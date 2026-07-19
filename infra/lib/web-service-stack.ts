import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";

interface WebServiceStackProps extends StackProps {
  vpc: ec2.Vpc;
  /** ECR repo the CI pipeline pushes web images to. */
  webRepo: ecr.Repository;
}

/**
 * Phase 5 — FpmWebService.
 *
 * A Fargate service running the Next.js 16 web app (apps/web) in `standalone`
 * mode (native `node server.js`) behind its OWN internet-facing ALB. Same
 * explicit task-def + ALB shape as the indexer, but simpler: NO database, NO
 * secrets, NO inbound-from-DB rules.
 *
 * Container runtime contract (apps/web/Dockerfile):
 *   - listens on PORT 3000, HOSTNAME 0.0.0.0, serves 200 on `/`
 *   - the NEXT_PUBLIC_* config (indexer URL, RPC URL, cluster) is INLINED at
 *     `docker build` time (build-args), NOT read from ECS env — so nothing about
 *     the indexer endpoint is set here; the deployed image already carries it.
 */
export class WebServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: WebServiceStackProps) {
    super(scope, id, props);

    const { vpc, webRepo } = props;

    // Image tag from CI (git SHA) via env; default "latest" for a manual push.
    const imageTag = process.env.IMAGE_TAG ?? "latest";

    // ---- Cluster ----
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ---- CloudWatch log group (short retention — it's a demo) ----
    const logGroup = new logs.LogGroup(this, "WebLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // ---- Task security group (ASCII-only description; EC2 rejects non-ASCII) ----
    const taskSg = new ec2.SecurityGroup(this, "WebTaskSg", {
      vpc,
      description: "Web Fargate task - inbound from ALB, egress for SSR fetch",
      allowAllOutbound: true,
    });

    // ---- Task definition (0.25 vCPU / 0.5 GB) ----
    const taskDef = new ecs.FargateTaskDefinition(this, "WebTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDef.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(webRepo, imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "web",
        logGroup,
      }),
      // NEXT_PUBLIC_* are baked at build time (do NOT set them here). Only the
      // Node server runtime knobs live in ECS env.
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        HOSTNAME: "0.0.0.0",
      },
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // ---- Fargate service (tasks in PRIVATE_WITH_EGRESS, no public IP) ----
    const service = new ecs.FargateService(this, "WebService", {
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
      // Give the Next server time to boot before ALB health-checks.
      healthCheckGracePeriod: Duration.seconds(120),
    });

    // ---- ALB (internet-facing, PUBLIC subnets) ----
    const alb = new elbv2.ApplicationLoadBalancer(this, "WebAlb", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });

    listener.addTargets("WebTarget", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        // Next serves the home page (200) on `/`; allow 2xx/3xx to be safe.
        path: "/",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyHttpCodes: "200-399",
      },
      // Shorten drain time so deploys finish quickly (default is 300s).
      deregistrationDelay: Duration.seconds(30),
    });

    // ---- CloudFront (HTTPS without a custom domain) ----
    // Browsers only expose WebCrypto (`crypto.subtle`) in a SECURE CONTEXT:
    // the plain-HTTP ALB URL breaks every PDA derivation in the client (the
    // leverage panel silently hides) and blocks wallet connect. CloudFront's
    // default *.cloudfront.net certificate gives us HTTPS with zero domain
    // setup; the origin stays the HTTP ALB (private hop, HTTP-only origin).
    const cdn = new cloudfront.Distribution(this, "WebCdn", {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // SSR pages are dynamic — never cache them at the edge.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        // Hashed immutable assets — safe to cache aggressively at the edge.
        "/_next/static/*": {
          origin: new origins.LoadBalancerV2Origin(alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      comment: "fpm web (HTTPS front for the web ALB)",
    });

    new CfnOutput(this, "WebCdnUrl", {
      value: `https://${cdn.distributionDomainName}`,
      description: "HTTPS web app URL (CloudFront; use THIS, not the ALB)",
    });

    new CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "Public DNS of the web ALB (HTTP origin; prefer WebCdnUrl)",
    });
    // Consumed by .github/workflows/deploy.yml to target `ecs update-service`.
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "ServiceName", { value: service.serviceName });
  }
}
