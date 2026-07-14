import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

/**
 * VPC foundation for the FPM services (eu-central-1, 2 AZ).
 *
 * Cost-conscious for a demo: a SINGLE NAT gateway (not one per AZ) — the NAT
 * gateway is the sneakiest recurring cost, so we run one and accept that a
 * single-AZ NAT outage would cut egress. Three subnet tiers:
 *   - PUBLIC            : ALB + the NAT gateway
 *   - PRIVATE_WITH_EGRESS: Fargate tasks (keeper needs outbound to TxLINE +
 *                          Solana RPC; indexer needs outbound RPC), via NAT
 *   - PRIVATE_ISOLATED  : RDS Postgres (no internet route at all)
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1, // single NAT — cost trim for the demo
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "app",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "data",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
  }
}
