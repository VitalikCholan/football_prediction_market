import { Stack, StackProps, CfnOutput, RemovalPolicy, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";

/**
 * ECR repositories the CI pipeline pushes service images to.
 *
 * One repo per service. Lifecycle: keep the last 10 images, expire untagged
 * after 7 days — stops a demo registry from accreting cost. emptyOnDelete so
 * `cdk destroy` can remove repos that still hold images.
 */
export class RegistryStack extends Stack {
  public readonly indexerRepo: ecr.Repository;
  public readonly keeperRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const lifecycleRules = [
      { description: "expire untagged", tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(7) },
      { description: "keep last 10", maxImageCount: 10 },
    ];

    this.indexerRepo = new ecr.Repository(this, "IndexerRepo", {
      repositoryName: "fpm-indexer",
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules,
    });

    this.keeperRepo = new ecr.Repository(this, "KeeperRepo", {
      repositoryName: "fpm-keeper",
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules,
    });

    new CfnOutput(this, "IndexerRepoUri", { value: this.indexerRepo.repositoryUri });
    new CfnOutput(this, "KeeperRepoUri", { value: this.keeperRepo.repositoryUri });
  }
}
