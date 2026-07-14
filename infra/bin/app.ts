#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { RegistryStack } from "../lib/registry-stack";
import { IndexerServiceStack } from "../lib/indexer-service-stack";

/**
 * FPM off-chain infra — ECS Fargate (keeper, indexer) + RDS Postgres.
 * Region eu-central-1. Account from the ambient AWS credentials
 * (CDK_DEFAULT_ACCOUNT), so nothing account-specific is committed.
 *
 * Phase 1 (this file): NetworkStack, DataStack, RegistryStack.
 * Phase 2/3 (indexer + keeper Fargate services) and Phase 4 (GitHub OIDC
 * CI/CD) add ServiceStack / CicdStack here later.
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
};

const network = new NetworkStack(app, "FpmNetwork", { env });

const data = new DataStack(app, "FpmData", { env, vpc: network.vpc });

const registry = new RegistryStack(app, "FpmRegistry", { env });

// Phase 2 — indexer Fargate service behind an ALB. Consumes the Phase-1
// stacks' exposed properties (VPC, RDS instance + its SG, ECR indexer repo).
new IndexerServiceStack(app, "FpmIndexerService", {
  env,
  vpc: network.vpc,
  db: data.db,
  dbSecurityGroup: data.dbSecurityGroup,
  indexerRepo: registry.indexerRepo,
});

app.synth();
