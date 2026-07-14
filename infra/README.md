# @fpm/infra — AWS CDK (ECS Fargate + RDS)

Off-chain deploy for the FPM keeper + indexer. Region **eu-central-1**. See
`plans/aws-cicd.md` for the full rationale and phased rollout.

**Standalone package** — not part of the pnpm workspace (like `programs/`). Use
`npm` here, not `pnpm`.

## Phase 1 (this scaffold): Network + Data + Registry

```bash
cd infra
npm install

# one-time per account/region — creates the CDK asset bucket + roles
CDK_DEFAULT_REGION=eu-central-1 npx cdk bootstrap aws://<ACCOUNT_ID>/eu-central-1

# review what will be created (no changes)
npm run synth

# deploy the Phase-1 foundation
npx cdk deploy FpmNetwork FpmData FpmRegistry
```

Requires AWS credentials in the shell (AWS MCP OAuth, or `aws configure` /
`AWS_PROFILE`). `CDK_DEFAULT_ACCOUNT` is read from those credentials.

## Stacks

| Stack | Contents |
|-------|----------|
| `FpmNetwork` | VPC (2 AZ, single NAT), public / private-egress / isolated subnets |
| `FpmData` | RDS Postgres 16 (db.t4g.micro, isolated, closed SG), creds in Secrets Manager `fpm/rds/credentials` |
| `FpmRegistry` | ECR repos `fpm-indexer`, `fpm-keeper` (scan-on-push, lifecycle) |

## Not yet built (next phases)

- **Phase 2** `FpmIndexerService` — Fargate + ALB + `/health`, `DATABASE_URL` from Secrets Manager, opens RDS ingress from the indexer task SG.
- **Phase 3** `FpmKeeperService` — Fargate, no inbound, keeper secret injected.
- **Phase 4** `FpmCicd` — GitHub OIDC provider + deploy role; `.github/workflows/deploy.yml`.

## Teardown

```bash
npx cdk destroy FpmRegistry FpmData FpmNetwork
```

All stacks use `RemovalPolicy.DESTROY` — demo hygiene, tears down clean. Do not
reuse these settings for a real production database.
