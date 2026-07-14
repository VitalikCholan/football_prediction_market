import { Stack, StackProps, CfnOutput, RemovalPolicy, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";

interface DataStackProps extends StackProps {
  vpc: ec2.Vpc;
}

/**
 * RDS PostgreSQL for the indexer (eu-central-1).
 *
 * Demo-sized + demo-safe teardown: db.t4g.micro, single-AZ, 20 GB gp3, NOT
 * publicly accessible, in PRIVATE_ISOLATED subnets. Credentials are auto-
 * generated into Secrets Manager (never in code). The security group starts
 * CLOSED — the indexer's Phase-2 stack adds the ingress rule from its task SG,
 * so nothing else can reach 5432.
 *
 * removalPolicy DESTROY + no deletion protection: this is a throwaway demo DB;
 * `cdk destroy` must tear it down cleanly. DO NOT copy these to a real prod DB.
 */
export class DataStack extends Stack {
  public readonly db: rds.DatabaseInstance;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc: props.vpc,
      description: "RDS Postgres - ingress added per-consumer (indexer only)",
      allowAllOutbound: false,
    });

    this.db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret("fpm_admin", {
        secretName: "fpm/rds/credentials",
      }),
      databaseName: "fpm",
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY, // demo — teardown clean
    });

    new CfnOutput(this, "DbEndpoint", {
      value: this.db.dbInstanceEndpointAddress,
    });
    new CfnOutput(this, "DbSecretArn", {
      value: this.db.secret?.secretArn ?? "none",
      description: "Secrets Manager ARN holding the generated DB credentials",
    });
  }
}
