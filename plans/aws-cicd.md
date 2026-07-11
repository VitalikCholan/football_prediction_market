# AWS CI/CD Deployment Plan — keeper + indexer (+ web later)

**Goal:** deploy the off-chain services to AWS with a *proper CI/CD pipeline* — the primary objective is to **gain hands-on AWS CI/CD experience**, not just to host. Region **eu-central-1 (Frankfurt)**. Shape: **ECS Fargate** (keeper, indexer) + **RDS Postgres**, driven by a **GitHub Actions → OIDC → ECR → ECS** pipeline. Web (Next 16) deferred until the shadcn migration lands.

> This also fixes PLAN.md §12 BUG-1/2/3-root: an always-on keeper drives the market lifecycle (activate/freeze/resolve) so markets stop being stuck in `Open`.

---

## 0. Why these choices (the learning rationale)

| Decision | Choice | Why (for learning) |
|---|---|---|
| Compute | **ECS Fargate** | Serverless containers — you learn task definitions, services, ALB wiring, IAM task roles, without managing EC2. The core AWS container primitive. |
| Database | **RDS PostgreSQL** | Managed Postgres — you learn subnet groups, security groups, parameter groups, secrets rotation. (Aurora Serverless v2 is the fancier option; RDS single-instance is cheaper + simpler to learn first.) |
| Registry | **ECR** | Where CI pushes images; you learn image tagging + lifecycle policies. |
| Secrets | **Secrets Manager** | keeper signer key + TxLINE token + DB URL — injected into task defs, never in the image. You learn `valueFrom` secret injection + IAM read scoping. |
| CI/CD | **GitHub Actions + OIDC** (primary) | The most **transferable** CI/CD skill. OIDC = no long-lived AWS keys in GitHub (short-lived role assumption) — the modern best practice. You already use GitHub. |
| IaC | **AWS CDK (TypeScript)** | Matches the repo's TS stack; teaches the actual AWS resources as code (vs Copilot, which hides them). Reviewable, diffable, repeatable. |
| Networking | **New VPC, 2 AZs** | You learn public/private subnets, NAT, security groups — the foundation everything sits on. |

**Alternatives noted (also worth learning later):**
- *AWS-native CI/CD* — CodePipeline + CodeBuild + CodeDeploy (blue/green). More "AWS-flavored" CI experience; heavier. GitHub Actions is the better first pipeline; try CodePipeline as a follow-up.
- *AWS Copilot CLI* — one command scaffolds Fargate + pipeline + ALB. Fastest, but hides the primitives you're trying to learn. Good for a speed pass, not for depth.
- *App Runner* — simpler than ECS (no ALB/task-def), but less control and less representative of production container platforms.

---

## 1. Architecture (target state)

```
                    GitHub (main)  ──push──▶  GitHub Actions
                                                   │ OIDC assume-role (no static keys)
                                                   ▼
                                    build 2 images ─▶ ECR (keeper, indexer)
                                                   │ update service (new task def)
                                                   ▼
   ┌──────────────────────── VPC (eu-central-1, 2 AZ) ───────────────────────┐
   │  public subnets:   ALB ──▶ indexer:3900 (Fargate service, /markets REST) │
   │  private subnets:  keeper (Fargate service, no inbound — SSE out only)   │
   │                    RDS Postgres (indexer only, SG-restricted)            │
   └──────────────────────────────────────────────────────────────────────────┘
        secrets: Secrets Manager (KEEPER_KEYPAIR, TXLINE_API_TOKEN, DATABASE_URL, RPC_URLS)
        logs:    CloudWatch Logs (one group per service)
```

- **keeper**: no inbound; outbound to TxLINE API + Solana RPC. Private subnet + NAT. Holds the signer → tightest IAM.
- **indexer**: inbound via ALB (HTTP :3900); talks to RDS. Public-subnet ALB, task in private subnet.
- **RDS**: reachable only from the indexer task security group. Not public.

---

## 2. Prerequisites (human — one-time)

1. **AWS account** with an IAM principal you can use.
2. **AWS MCP live** (already registered as `aws-mcp`, OAuth): attach `AWSMCPSignInOAuthAccessPolicy` to your IAM user/role, reconnect the Claude session, authorize the browser sign-in on first tool call. *(If org blocks OAuth `signin:*`, fall back to SigV4: `brew install awscli` + `aws login`.)*
3. **CDK bootstrap** (once per account/region): `cdk bootstrap aws://<acct>/eu-central-1` — creates the CDK asset bucket + roles.
4. **Secrets you paste yourself** (never through me, never in git): keeper signer keypair, TxLINE API token. I create empty Secrets Manager entries; you fill the values in the console.
5. **Funded keeper signer**: the devnet keypair used on-chain needs devnet SOL for tx fees.

---

## 3. Phased rollout (each phase = a reviewable, testable step)

### Phase 0 — Repo artifacts (DONE, no AWS)
- `.dockerignore`, `apps/keeper/Dockerfile`, `apps/indexer/Dockerfile` — written. Verify they build **locally** first:
  ```
  docker build -f apps/indexer/Dockerfile -t fpm-indexer .
  docker build -f apps/keeper/Dockerfile  -t fpm-keeper .
  ```
  Fix any workspace-install/prisma issues before touching AWS. **Learning: containerizing a buildless pnpm monorepo.**

### Phase 1 — IaC skeleton + bootstrap
- Add an `infra/` CDK app (TypeScript, its own package). Stacks split for clarity:
  - `NetworkStack` — VPC, subnets, NAT, security groups.
  - `DataStack` — RDS Postgres, DB secret, subnet group.
  - `RegistryStack` — 2 ECR repos + lifecycle policy (expire untagged).
- `cdk bootstrap`, then `cdk deploy NetworkStack DataStack RegistryStack`.
- **Learning: VPC/subnets/SG, RDS provisioning, CDK synth/deploy/diff.**

### Phase 2 — Indexer service (first, because it's HTTP + needs the DB)
- `ServiceStack` (indexer): Fargate task def (image from ECR), ALB + target group + health check on `/health`, task role, CloudWatch log group, `DATABASE_URL` from Secrets Manager, desired-count 1.
- Manually build+push the indexer image once (to have something to run), `cdk deploy`.
- Verify: ALB DNS `GET /markets` returns data; `prisma migrate deploy` ran at startup (check logs).
- **Learning: task defs, ALB, health checks, secret injection, ECS service rollout.**

### Phase 3 — Keeper service
- Extend `ServiceStack` (or a `KeeperStack`): Fargate service, **no ALB** (no inbound), private subnet, task role scoped to read only the keeper secrets. Env: `RPC_URLS`, `KEEPER_KEYPAIR`, `TXLINE_API_TOKEN`, `ENABLE_AUTO_SEED=true`, scheduler tick config.
- Verify from CloudWatch logs: `scheduler: kickoff -> activate` firing; a seeded future market flips `Open → Trading`. **This is the BUG-1/2 fix confirmed.**
- **Learning: a no-inbound worker service, least-privilege task role, log-driven verification.**

### Phase 4 — CI/CD pipeline (the centerpiece)
- **GitHub OIDC provider + deploy role** (in CDK, `CicdStack`): a role GitHub Actions can assume via OIDC, scoped to ECR push + ECS update + `iam:PassRole` for the task/execution roles. No static AWS keys in GitHub.
- **`.github/workflows/deploy.yml`**: on push to `main` touching `apps/keeper|indexer|libs/**`:
  1. `aws-actions/configure-aws-credentials` (OIDC assume-role).
  2. `docker build` each changed service, tag with the git SHA.
  3. push to ECR.
  4. `aws ecs update-service --force-new-deployment` (or render a new task def + deploy).
  5. wait for the service to stabilize; roll back on failure (ECS circuit breaker).
- Use **Turborepo `--affected`** to build only the service whose code changed.
- **Learning: OIDC federation, ECR push from CI, zero-downtime ECS rolling deploys, path-filtered pipelines, rollback.**

### Phase 5 — Web (deferred)
- After the shadcn migration lands + is reviewed. Options: **Amplify Hosting** (native Next SSR, simplest) or **SST/OpenNext** (Lambda+CloudFront, more control). Next 16 SSR-adapter support is the risk — validate a preview deploy before wiring CI. Point web at the ALB DNS (`NEXT_PUBLIC_INDEXER_URL`).

---

## 4. Cost + teardown (keep it a demo, not a bill)
- Fargate 2×(0.25 vCPU/0.5GB) + RDS `db.t4g.micro` + ALB + NAT ≈ low tens of USD/month; NAT gateway is the sneaky cost. For a short demo, a single-NAT (one AZ) or a VPC endpoint setup trims it.
- Everything is CDK → `cdk destroy` tears the whole stack down cleanly when the demo's over. **Learning: lifecycle + cost hygiene.**

---

## 5. Security invariants (non-negotiable)
- **No secrets in git or images.** keeper keypair + TxLINE token live only in Secrets Manager; I create the entries empty, you paste values in the console.
- **OIDC, not access keys**, for GitHub→AWS. No long-lived AWS credentials anywhere in CI.
- **Least-privilege task roles**: keeper role reads only keeper secrets; indexer role reads only the DB secret. RDS SG allows only the indexer SG.
- **RDS not public.** Private subnets, SG-restricted.

---

## 6. Execution order (once MCP is live + you've authed)
1. Local Docker build smoke (Phase 0 verify).
2. Scaffold `infra/` CDK app.
3. Retrieve AWS MCP deploy skills (`retrieve_skill`) to cross-check the CDK patterns against AWS's own guidance.
4. Phases 1→2→3, verifying each before the next.
5. Phase 4 pipeline; push a trivial change to watch it deploy end-to-end.
6. Phase 5 web after shadcn.

**Locked decisions (2026-07-11):** IaC = **AWS CDK (TypeScript)**; CI/CD = **GitHub Actions + OIDC**. (Copilot / CodePipeline noted as optional follow-up passes for extra AWS-native learning, not the primary path.)
