import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

interface KeeperServiceStackProps extends StackProps {
  vpc: ec2.Vpc;
  /** ECR repo the CI pipeline pushes keeper images to. */
  keeperRepo: ecr.Repository;
}

/**
 * Phase 3 — FpmKeeperService.
 *
 * A Fargate WORKER service running the keeper (apps/keeper). It has NO inbound:
 * the keeper only makes OUTBOUND calls (TxLINE API + Solana RPC) and signs +
 * sends transactions. So there is no ALB, no target group, no health check —
 * the service simply runs and is verified via CloudWatch Logs.
 *
 * Container runtime contract (apps/keeper/.env.example):
 *   - RPC_URLS, CLUSTER=devnet
 *   - KEEPER_KEYPAIR   (SECRET signer — base58 / JSON array / path; here base58
 *                       or JSON array injected directly as the env value)
 *   - TXLINE_BASE_URL, TXLINE_API_TOKEN (SECRET)
 *   - PRIORITY_FEE_MODE, SCHEDULER_TICK_MS, ENABLE_SCORE_STREAM, DRY_RUN,
 *     ENABLE_AUTO_SEED
 *
 * Networking: task runs in PRIVATE_WITH_EGRESS subnets — it needs NAT egress to
 * reach TxLINE + Solana RPC. assignPublicIp:false. Own task SG (egress allowed,
 * no ingress rule at all).
 *
 * SECRETS (plan section 5 — no secret value ever in git or code):
 *   Two EMPTY Secrets Manager placeholders are created here (no generated value).
 *   The human pastes the real values in the AWS console AFTER first deploy, then
 *   forces a new deployment (secrets are injected only at task launch — no
 *   hot-reload). Injected into the container as env vars via
 *   ecs.Secret.fromSecretsManager. CDK auto-grants read on these two secrets to
 *   the TASK EXECUTION role (the ECS agent fetches env-injected secrets at launch)
 *   — least privilege: only these two secrets, nothing else. The task role stays
 *   empty because the keeper makes no AWS API calls of its own (it talks to
 *   Solana + TxLINE, not AWS); it signs Solana txs with the injected keypair.
 *
 * SAFE-BY-DEFAULT env: the first deploy runs BEFORE the secret placeholders hold
 * real values, so the container must stay healthy without a valid signer/token.
 * We default DRY_RUN=1 (simulate, never send) and ENABLE_SCORE_STREAM=0 (the SSE
 * stream needs a real TXLINE_API_TOKEN). See the GO-LIVE note below.
 */
export class KeeperServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: KeeperServiceStackProps) {
    super(scope, id, props);

    const { vpc, keeperRepo } = props;

    // Image tag from CI (git SHA) via env; default "latest" for a manual push.
    const imageTag = process.env.IMAGE_TAG ?? "latest";

    // ---- Cluster ----
    // Own cluster (not shared with the indexer). Each service stack owning its
    // own cluster keeps the stacks independently deployable/destroyable with no
    // cross-stack cluster dependency — matches the IndexerServiceStack pattern
    // (which also creates its own "Cluster"). A cluster is a free logical
    // grouping, so there is no cost to a second one.
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ---- CloudWatch log group (short retention — it's a demo) ----
    const logGroup = new logs.LogGroup(this, "KeeperLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // ---- Task security group (egress only; NO ingress rule is ever added) ----
    // ASCII-only description (EC2 rejects non-ASCII: use plain hyphens).
    const taskSg = new ec2.SecurityGroup(this, "KeeperTaskSg", {
      vpc,
      description: "Keeper Fargate task - egress only to TxLINE + Solana RPC, no inbound",
      allowAllOutbound: true,
    });

    // ---- Secrets Manager (REFERENCED, not created here) ----
    // The two secrets are created + populated OUT OF BAND (aws secretsmanager
    // create-secret, then the human pastes the real values). We only REFERENCE
    // them so the secret VALUES never live in this stack: a failed first deploy
    // rolls back the service without deleting the secrets, and the keeper only
    // starts once the signer secret holds a valid key (it exits without one).
    const signerSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "KeeperSignerSecret",
      "fpm/keeper/signer",
    );

    const txlineTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "KeeperTxlineTokenSecret",
      "fpm/keeper/txline-api-token",
    );

    // ---- Task definition (0.25 vCPU / 0.5 GB, X86_64 — image built amd64) ----
    const taskDef = new ecs.FargateTaskDefinition(this, "KeeperTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDef.addContainer("keeper", {
      image: ecs.ContainerImage.fromEcrRepository(keeperRepo, imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "keeper",
        logGroup,
      }),
      // Plain env — safe defaults so the FIRST deploy stays healthy BEFORE the
      // secret placeholders hold real values.
      environment: {
        CLUSTER: "devnet",
        RPC_URLS: "https://api.devnet.solana.com",
        TXLINE_BASE_URL: "https://txline-dev.txodds.com",
        PRIORITY_FEE_MODE: "dynamic",
        SCHEDULER_TICK_MS: "5000",
        ENABLE_AUTO_SEED: "0",
        // --- SAFE MODE (default) ---
        // DRY_RUN=1: simulate every tx, never send — safe with an empty signer.
        // ENABLE_SCORE_STREAM=0: don't open the SSE stream — it needs a real
        // TXLINE_API_TOKEN, absent until the placeholder secret is filled.
        //
        // GO-LIVE (do this in order, AFTER first deploy):
        //   1. In the AWS console, paste the real values into the two secrets:
        //      fpm/keeper/signer            = the GlobalConfig.keeper keypair
        //                                     (base58 or JSON array), and it MUST
        //                                     be funded with devnet SOL for fees.
        //      fpm/keeper/txline-api-token  = the TxLINE X-Api-Token.
        //   2. Flip these two env values to DRY_RUN=0 and ENABLE_SCORE_STREAM=1
        //      here, and redeploy (cdk deploy) — OR set them as an override.
        //   3. Force a new deployment so the task picks up the pasted secret
        //      values (secrets are injected only at task launch, no hot-reload):
        //      aws ecs update-service --force-new-deployment ...
        DRY_RUN: "1",
        ENABLE_SCORE_STREAM: "0",
      },
      // Injected only inside the running task (fetched by the execution role at
      // launch) — never in plain env / code / image.
      secrets: {
        KEEPER_KEYPAIR: ecs.Secret.fromSecretsManager(signerSecret),
        TXLINE_API_TOKEN: ecs.Secret.fromSecretsManager(txlineTokenSecret),
      },
    });

    // ---- Fargate service (PRIVATE_WITH_EGRESS, no public IP, NO load balancer) ----
    const service = new ecs.FargateService(this, "KeeperService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSg],
      // Single long-running worker; no ALB so no zero-downtime target draining
      // to worry about. Allow the old task to stop before the new one starts so
      // there is never a moment with two keepers signing at once (a second
      // signer could double-send). minHealthy 0 / max 100 => stop-then-start.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Bad deploys auto-roll-back instead of hanging "in progress".
      circuitBreaker: { rollback: true },
    });

    new CfnOutput(this, "KeeperServiceName", {
      value: service.serviceName,
      description: "Keeper Fargate service name (verify via CloudWatch logs; no ALB)",
    });

    new CfnOutput(this, "KeeperLogGroupName", {
      value: logGroup.logGroupName,
      description: "CloudWatch log group for keeper task logs",
    });
  }
}
