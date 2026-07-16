import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecr from "aws-cdk-lib/aws-ecr";

interface CicdStackProps extends StackProps {
  indexerRepo: ecr.IRepository;
  keeperRepo: ecr.IRepository;
  webRepo: ecr.IRepository;
}

/**
 * GitHub Actions -> OIDC -> ECR -> ECS deploy identity.
 *
 * The pipeline (.github/workflows/deploy.yml) assumes `github-actions-deploy`
 * via OIDC (NO long-lived AWS keys in GitHub), builds the changed service image,
 * pushes it to ECR, and runs `ecs update-service --force-new-deployment`.
 *
 * SECURITY:
 *  - The trust policy pins the assumer to ONLY the `main` branch of this exact
 *    repo (`sub = repo:<owner>/<repo>:ref:refs/heads/main`) with the standard
 *    `aud = sts.amazonaws.com`. Any other repo/branch/PR cannot assume the role.
 *  - Permissions are least-privilege: ECR push to only our two repos + the
 *    account-wide `ecr:GetAuthorizationToken`, and `ecs:UpdateService/
 *    DescribeServices` scoped to only the FpmIndexerService / FpmKeeperService
 *    ECS services. No CloudFormation, no CDK bootstrap roles, no `ecs:*`.
 */
export class CicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    const GITHUB_REPO = "VitalikCholan/football_prediction_market";

    const provider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const role = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: "github-actions-deploy",
      description:
        "Assumed by GitHub Actions (main branch) via OIDC to push images to ECR and force ECS deployments",
      maxSessionDuration: undefined,
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:ref:refs/heads/main`,
        },
      }),
    });

    // ECR login is account-wide (cannot be resource-scoped).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );

    // Push/pull layers + images to ONLY our two repos.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ],
        resources: [
          props.indexerRepo.repositoryArn,
          props.keeperRepo.repositoryArn,
          props.webRepo.repositoryArn,
        ],
      }),
    );

    // Force a new deployment on ONLY our ECS services. The service ARNs
    // embed the CDK-generated cluster + service names; wildcards match them
    // without a cross-stack dependency.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:UpdateService", "ecs:DescribeServices"],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:service/FpmIndexerService-*/*`,
          `arn:aws:ecs:${this.region}:${this.account}:service/FpmKeeperService-*/*`,
          `arn:aws:ecs:${this.region}:${this.account}:service/FpmWebService-*/*`,
        ],
      }),
    );

    // Read-only: the workflow resolves the ECS cluster/service names from the
    // two service stacks' outputs. Scoped to only those stacks.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/FpmIndexerService/*`,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/FpmKeeperService/*`,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/FpmWebService/*`,
        ],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description: "role-to-assume for aws-actions/configure-aws-credentials",
    });
  }
}
