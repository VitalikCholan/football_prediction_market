import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";

interface IndexerServiceStackProps extends StackProps {
  vpc: ec2.Vpc;
  /** RDS instance from DataStack; its `.secret` holds the generated credentials. */
  db: rds.DatabaseInstance;
  /** RDS security group (starts closed) — we add the indexer ingress rule here. */
  dbSecurityGroup: ec2.SecurityGroup;
  /** ECR repo the CI pipeline pushes indexer images to. */
  indexerRepo: ecr.Repository;
}

/**
 * Phase 2 — FpmIndexerService.
 *
 * A Fargate service running the NestJS indexer (apps/indexer) behind an
 * internet-facing ALB. Explicit task def + ALB (not the L3 pattern) to keep
 * fine-grained control over networking, IAM, secret injection, and health
 * checks — matches the "learn the primitives" goal of the deploy plan.
 *
 * Container runtime contract (apps/indexer/Dockerfile + .env.example):
 *   - listens on PORT 3900, serves GET /health and GET /markets
 *   - runs Prisma: `prisma migrate deploy` must run against RDS before serving
 *   - needs DATABASE_URL (Postgres), RPC_URLS, INDEXER_ENABLED
 *
 * DATABASE_URL approach (chosen: option (a) — compose in a command wrapper):
 *   The RDS secret (DataStack.db.secret) is JSON {username,password,host,port,
 *   dbname,...}, but the indexer wants a single postgresql:// URL. We inject the
 *   individual secret fields as `ecs.Secret`s (password/username/host/port/dbname
 *   -> env vars DB_USER/DB_PASS/DB_HOST/DB_PORT/DB_NAME, materialised only inside
 *   the task, never in the CDK output or the image), then a `sh -c` container
 *   command composes DATABASE_URL from them and runs `prisma migrate deploy`
 *   before starting the server. No credential ever appears in plain env, in code,
 *   or in the image. This also keeps a single source of truth (the RDS-generated
 *   secret) — no second placeholder secret to fill in by hand.
 */
export class IndexerServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: IndexerServiceStackProps) {
    super(scope, id, props);

    const { vpc, db, dbSecurityGroup, indexerRepo } = props;

    // Image tag from CI (git SHA) via env; default "latest" for a manual push.
    const imageTag = process.env.IMAGE_TAG ?? "latest";

    // ---- Cluster ----
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ---- CloudWatch log group (short retention — it's a demo) ----
    const logGroup = new logs.LogGroup(this, "IndexerLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // ---- Task security group (its own SG so RDS can allow-list exactly it) ----
    // ASCII-only description (EC2 rejects non-ASCII: no em-dashes).
    const taskSg = new ec2.SecurityGroup(this, "IndexerTaskSg", {
      vpc,
      description: "Indexer Fargate task - egress to RDS + outbound RPC/TxLINE",
      allowAllOutbound: true,
    });

    // Security invariant (plan section 5): RDS ingress ONLY from the indexer task SG.
    // We create the ingress rule as a standalone construct scoped to THIS stack
    // (not via dbSecurityGroup.addIngressRule, which would add the rule to the
    // DataStack and create a cross-stack dependency cycle: DataStack would then
    // depend on this stack's task SG, while this stack depends on DataStack's
    // RDS secret). ASCII-only description (EC2 rejects non-ASCII).
    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromIndexer", {
      groupId: dbSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: taskSg.securityGroupId,
      description: "Indexer Fargate task to Postgres",
    });

    // ---- Task definition (0.25 vCPU / 0.5 GB) ----
    const taskDef = new ecs.FargateTaskDefinition(this, "IndexerTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // The RDS-generated secret; fail loud if it is somehow absent.
    if (!db.secret) {
      throw new Error("DataStack RDS instance has no generated secret");
    }
    const dbSecret = db.secret;

    // Compose DATABASE_URL from the injected secret fields, run migrations, serve.
    // urlencode the password (may contain URL-reserved chars from generation).
    const startupCommand = [
      'export DATABASE_URL="postgresql://$DB_USER:$(node -e ' +
        "'process.stdout.write(encodeURIComponent(process.env.DB_PASS))'" +
        ')@$DB_HOST:$DB_PORT/$DB_NAME?schema=public"',
      "node_modules/.bin/prisma migrate deploy",
      "exec node dist/bundle.cjs",
    ].join(" && ");

    const container = taskDef.addContainer("indexer", {
      image: ecs.ContainerImage.fromEcrRepository(indexerRepo, imageTag),
      // Override the image CMD: compose DATABASE_URL from secret fields first.
      command: ["sh", "-c", startupCommand],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "indexer",
        logGroup,
      }),
      environment: {
        PORT: "3900",
        INDEXER_ENABLED: "1",
        // Public devnet RPC as a plain env is fine (no secret). A keyed Helius
        // URL would instead go in a Secret (HELIUS_RPC_URL) and be injected below.
        RPC_URLS: "https://api.devnet.solana.com",
        TXLINE_BASE_URL: "https://txline-dev.txodds.com",
      },
      // Injected only inside the running task — never in plain env / code / image.
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASS: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, "host"),
        DB_PORT: ecs.Secret.fromSecretsManager(dbSecret, "port"),
        DB_NAME: ecs.Secret.fromSecretsManager(dbSecret, "dbname"),
      },
    });

    container.addPortMappings({
      containerPort: 3900,
      protocol: ecs.Protocol.TCP,
    });

    // ---- Fargate service (tasks in PRIVATE_WITH_EGRESS, no public IP) ----
    const service = new ecs.FargateService(this, "IndexerService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSg],
      // Zero-downtime rolling deploy at desiredCount 1 needs room for 2 tasks.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Bad deploys auto-roll-back instead of hanging "in progress".
      circuitBreaker: { rollback: true },
      // Give the container time to run migrations + boot before ALB health-checks.
      healthCheckGracePeriod: Duration.seconds(120),
    });

    // ---- ALB (internet-facing, PUBLIC subnets) ----
    const alb = new elbv2.ApplicationLoadBalancer(this, "IndexerAlb", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });

    listener.addTargets("IndexerTarget", {
      port: 3900,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/health",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyHttpCodes: "200",
      },
      // Shorten drain time so deploys finish quickly (default is 300s).
      deregistrationDelay: Duration.seconds(30),
    });

    new CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "Public DNS of the indexer ALB (GET /markets, /health)",
    });
  }
}
