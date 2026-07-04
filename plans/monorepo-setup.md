# Monorepo Setup Runbook — Anchor 1.0 + NestJS + Next.js (Phase 0)

**Goal:** the `PLAN.md §3` layout, wired correctly. This is the Phase-0 scaffold deliverable.
**Locked context:** Anchor **1.0.0**, pnpm + Turborepo, **buildless** internal packages, one **build-fed** exception (`libs/idl` via Codama), `@solana/kit` client, `nestjs-zod` contract, TxLINE constants from `anchor-programs-plan.md §11.1`.

---

## 0. The 6 rules that make this "proper" (mental model)

1. **Anchor is NOT a JS workspace member.** `programs/` + `Anchor.toml` sit at the repo root and belong to a **Cargo** workspace. The pnpm workspace globs (`apps/*`, `libs/*`, `packages/*`) deliberately exclude `programs/`. The only thing crossing the Rust→JS boundary is the generated IDL.
2. **Everything internal is buildless** — packages point `main`/`exports` at **TS source** (`src/index.ts`), no `tsc` emit, no `dist/`. Consumers import `@fpm/shared` and get source.
3. **`libs/idl` is the ONE exception** — it contains **generated** code (Anchor build artifact → Codama). It's still *consumed* buildlessly (its `main` points at generated `src`), but it has a **generation step** that must run before anything typechecks. This is the only real ordering constraint in the repo.
4. **Two apps run TS with different runners.** Keeper = plain Node native TS strip / `tsx` (no decorators, truly buildless). **Indexer = `nest start --watch` (SWC)** — NestJS needs runtime decorator metadata (`emitDecoratorMetadata`), which erasable/strip-only loaders CANNOT produce, so it uses its framework's own watch runner (no manual build in dev). This is the "buildless conflict" from `backend-plan.md`; the resolution is a per-app runner + tsconfig, not a repo-wide one.
5. **Turbo is used only where it pays:** the `codegen` task (with the IDL JSON as input, for caching), affected-CI, and Docker pruning. Not as a mandatory orchestration layer.
6. **The API↔web type contract is zod in `libs/shared`** — imported by NestJS (`nestjs-zod`) and Next.js. No codegen, no `hc<App>()`.

---

## 1. Target topology

```
football-pm-amm/
├─ Cargo.toml              # [workspace] members = ["programs/*"]   ← RUST workspace
├─ Anchor.toml            # provider, [programs.localnet], [test], (optional [hooks])
├─ programs/amm/          # Rust program (see anchor-programs-plan.md)
├─ tests/                 # LiteSVM (Rust) + TS integration (Surfpool)
├─ pnpm-workspace.yaml     # packages: apps/* libs/* packages/*   ← JS workspace (NO programs/*)
├─ turbo.json
├─ package.json           # root: scripts + devDeps (turbo, prettier)
├─ tsconfig.json          # root: references only
├─ apps/
│  ├─ web/                # Next.js (create-next-app)
│  ├─ indexer/            # NestJS (nest new)  — tsx + decorator metadata
│  └─ keeper/             # plain TS service   — node --watch / tsx
├─ libs/
│  ├─ shared/             # @fpm/shared  — PDA derivs, constants, zod DTOs (buildless)
│  └─ idl/                # @fpm/idl     — generated Codama/Kit client (build-fed)
└─ packages/
   ├─ tsconfig/           # @fpm/tsconfig — base / nextjs / nestjs / library / service
   ├─ eslint-config/
   └─ prettier-config/
```

Dependency graph (who imports whom):
```
programs/amm ──(anchor build)──▶ target/idl/amm.json
                                      │ codama generate
                                      ▼
                                  libs/idl (@fpm/idl)
                                      ▼
        ┌───────────────┬────────────┴───────────┐
   libs/shared      apps/keeper              apps/indexer
   (@fpm/shared)         │                        │
        └──────┬─────────┴──────────┬─────────────┘
           apps/web             apps/indexer   (shared imports idl for PDA types)
```

---

## 2. Ordered setup (run top to bottom)

### 2.1 Root
```bash
mkdir football-pm-amm && cd football-pm-amm
git init
corepack enable && corepack prepare pnpm@latest --activate
pnpm init                       # root package.json (private)
pnpm add -Dw turbo prettier
```

`pnpm-workspace.yaml` — **note the absence of `programs/*`:**
```yaml
packages:
  - "apps/*"
  - "libs/*"
  - "packages/*"
```

Root `package.json` (key bits):
```jsonc
{
  "name": "football-pm-amm", "private": true, "type": "module",
  "packageManager": "pnpm@9",
  "scripts": {
    "codegen": "turbo run codegen",
    "dev": "turbo run dev", "build": "turbo run build",
    "lint": "turbo run lint", "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "anchor:build": "anchor build",
    "anchor:test": "NO_DNA=1 anchor test"
  }
}
```

### 2.2 Anchor (Rust — outside pnpm) — *verified vs anchor-lang.com/docs/quickstart/local*
```bash
# toolchain (anchor-programs-plan.md §8): Rust 1.89+, Solana CLI 3.1.10+, Anchor 1.0.x
avm install 1.0.2 && avm use 1.0.2        # 1.0.2 is current patch of the locked 1.0 line
anchor init amm --test-template rust      # ← rust/LiteSVM harness, matches anchor plan §10
```
- **Why `--test-template rust`:** the **default** `anchor init` generates a **ts-mocha** TS test at `/tests/amm.ts` and a yarn-driven `[scripts] test = "yarn run ts-mocha ..."`. We want the **Rust LiteSVM** tests from anchor plan §10, and we don't want a yarn/TS harness fighting pnpm. `--test-template rust` gives Rust tests instead. (Other option: `--test-template mollusk`.)
- The default init produces the **modular single-program** layout that matches our plan: `programs/amm/src/{lib.rs, instructions/, state/, constants.rs, error.rs}` — confirm it lines up with anchor plan §1.
- Root `Cargo.toml` is a `[workspace]` with `members = ["programs/*"]`.
- **Delete any `package.json`/`yarn.lock`/`node_modules`** `anchor init` drops at root — pnpm owns JS. (With `--test-template rust` there should be none, but check.)
- Default `Anchor.toml` sections to know: `[toolchain]`, `[features] resolution = true, skip-lint = false`, `[programs.localnet] amm = "<id>"`, `[provider] cluster = "Localnet", wallet = "~/.config/solana/id.json"`, `[scripts]`. **Edit:** set `[provider] cluster = "Devnet"`; pin the program id; if you kept any TS scripts, drop them.
- Optional: run codegen as a build hook (Anchor 1.0 `[hooks]` — from release notes, not shown on the quickstart page; the turbo `codegen` task in §2.9 is the primary path):
  ```toml
  [hooks]
  post-build = "pnpm --filter @fpm/idl codegen"
  ```

### 2.3 `packages/tsconfig` (shared configs) — buildless-tuned
`packages/tsconfig/base.json`:
```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "module": "NodeNext", "moduleResolution": "NodeNext",
    "target": "ES2022", "lib": ["ES2023"],
    "strict": true, "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,   // import "#src/foo.ts"
    "noEmit": true,                        // buildless: nobody emits
    "esModuleInterop": true, "resolveJsonModule": true
  }
}
```
- `library.json` extends base (for `libs/shared`, `libs/idl`): adds `"erasableSyntaxOnly": true`.
- `service.json` (keeper): extends library.
- `nestjs.json` (indexer) — **the exception**, DROPS `erasableSyntaxOnly`/`verbatimModuleSyntax`, adds decorator metadata:
  ```jsonc
  { "extends": "./base.json",
    "compilerOptions": {
      "experimentalDecorators": true, "emitDecoratorMetadata": true,
      "verbatimModuleSyntax": false, "allowImportingTsExtensions": false
    } }
  ```
- `nextjs.json` (web): extends base, `"jsx": "preserve"`, `"lib": ["ES2023","DOM","DOM.Iterable"]`, `"plugins":[{"name":"next"}]`.

### 2.4 `libs/shared` (@fpm/shared) — pure buildless
```jsonc
// libs/shared/package.json
{ "name": "@fpm/shared", "version": "0.0.0", "private": true, "type": "module",
  "main": "src/index.ts", "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "imports": { "#src/*.ts": "./src/*.ts" },
  "dependencies": { "@fpm/idl": "workspace:*", "zod": "^3" } }
```
Contents:
- `src/constants.ts` — **program id**, PDA seed byte-strings (mirror `anchor-programs-plan.md §2.6`: `config`, `mkt_config`, `market`, `position`, `vault`), fixed-point denominators, and **TxLINE constants** (program ids, TxL/USDT mints per cluster from §11.1).
- `src/pda.ts` — PDA derivations using `@solana/kit`'s `getProgramDerivedAddress`, reusing the seeds so client + program never diverge.
- `src/dto/` — zod schemas for the REST contract (`MarketDto`, `HistoryPointDto`, …) — the single source of truth for indexer + web.

### 2.5 `libs/idl` (@fpm/idl) — the build-fed exception
```jsonc
// libs/idl/package.json
{ "name": "@fpm/idl", "version": "0.0.0", "private": true, "type": "module",
  "main": "src/generated/index.ts", "types": "src/generated/index.ts",
  "exports": { ".": "./src/generated/index.ts" },
  "scripts": { "codegen": "node ./scripts/codegen.mjs" },
  "dependencies": { "@solana/kit": "^2" },
  "devDependencies": { "codama": "^1", "@codama/nodes-from-anchor": "^1", "@codama/renderers-js": "^1" } }
```
`libs/idl/scripts/codegen.mjs` (standalone — robust, cache-friendly; verified pattern):
```js
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";
import { readFileSync } from "node:fs";

const idl = JSON.parse(readFileSync("../../target/idl/amm.json", "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
codama.accept(renderVisitor("src/generated"));
console.log("✅ @fpm/idl generated from target/idl/amm.json");
```
> Also drop TxLINE's **devnet IDL** at `programs/amm/idls/txline.json` for the on-chain `declare_program!(txline)` (that's Rust-side, separate from this JS client). If the keeper needs to call TxLINE directly from TS too, generate a second client from that IDL here.

### 2.6 `apps/keeper` — plain TS service (no decorators)
```jsonc
// apps/keeper/package.json
{ "name": "@fpm/keeper", "private": true, "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "start": "node --experimental-strip-types src/index.ts",
    "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "@fpm/idl": "workspace:*", "@fpm/shared": "workspace:*",
                    "@solana/kit": "^2" } }
```
(If native strip chokes on any syntax, swap to `tsx watch src/index.ts` — same buildless spirit.) `tsconfig.json` extends `@fpm/tsconfig/service.json`.

### 2.7 `apps/indexer` — NestJS (the decorator exception)
```bash
pnpm dlx @nestjs/cli new apps/indexer --skip-git --package-manager pnpm --strict
```
**Run it with NestJS's own watch runner — not raw `node`/`tsx`.** NestJS depends on runtime **decorator metadata** (`emitDecoratorMetadata`), which the buildless native-strip loader (`node --experimental-strip-types`) cannot produce. Rather than bend `tsx` to emit metadata (version-fragile with esbuild), use Nest's native `nest start --watch` — officially supported, handles decorators, incremental, and needs **no manual build step** in dev (it manages its own compile). This is the clean resolution of the "buildless conflict": keeper + libs are truly buildless; the indexer uses its framework's dev runner.
```jsonc
// apps/indexer/package.json (scripts)
{ "scripts": {
    "dev": "nest start --watch -b swc",   // SWC = fast incremental; drop -b swc for tsc
    "start": "node dist/main.js",          // after `build`
    "build": "nest build",
    "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@fpm/idl":"workspace:*", "@fpm/shared":"workspace:*",
                    "nestjs-zod":"^4", "reflect-metadata":"^0.2", "zod":"^3" } }
```
- `tsconfig.json` extends `@fpm/tsconfig/nestjs.json` (`experimentalDecorators` + `emitDecoratorMetadata` ON — required; these are the standard NestJS tsconfig options).
- `import "reflect-metadata";` as the **first line** of `main.ts` (before any Nest import).
- Use `nestjs-zod` `ZodValidationPipe` + `createZodDto(MarketDto)` so the `libs/shared` zod schemas ARE the DTOs — one source of truth with the web app.
- Prod image: `nest build` → run compiled `dist/` (decorators are safest precompiled for prod).
- `-b swc` needs `@swc/core` + `@swc/cli`; if SWC ever mis-handles a decorator edge case, drop `-b swc` to fall back to `tsc`.
- *(tsx alternative: `tsx watch src/main.ts` works only if your esbuild/tsx version honors `emitDecoratorMetadata` from tsconfig — don't rely on it; `nest start --watch` is the supported path.)*

### 2.8 `apps/web` — Next.js
```bash
pnpm dlx create-next-app@latest apps/web --ts --tailwind --app --eslint --src-dir --use-pnpm --import-alias "@/*"
```
Buildless consumption of the workspace TS packages needs `transpilePackages`:
```js
// apps/web/next.config.mjs
export default { transpilePackages: ["@fpm/shared", "@fpm/idl"] };
```
- Add `@fpm/shared`, `@fpm/idl` as `workspace:*` deps.
- Wallet: framework-kit (`@solana/react-hooks`) + `@solana/kit`, per `frontend-plan.md` (pending the wallet-stack confirmation).
- Data layer: fetch the indexer REST API, validate responses with the **same `libs/shared` zod DTOs** → end-to-end type safety without a generated client.

### 2.9 `turbo.json`
```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "codegen": {                         // @fpm/idl only
      "inputs": ["../../target/idl/amm.json", "scripts/**"],
      "outputs": ["src/generated/**"]
    },
    "typecheck": { "dependsOn": ["@fpm/idl#codegen"] },
    "dev":       { "dependsOn": ["@fpm/idl#codegen"], "cache": false, "persistent": true },
    "build":     { "dependsOn": ["@fpm/idl#codegen"], "outputs": ["dist/**", ".next/**"] },
    "lint":      {},
    "test":      { "dependsOn": ["@fpm/idl#codegen"] }
  }
}
```
Everything that touches the client `dependsOn: ["@fpm/idl#codegen"]`, and codegen is cached against the IDL JSON — so it only re-runs when the program changes.

---

## 3. The end-to-end flow (once scaffolded)

```
edit programs/amm  →  anchor build            (emits target/idl/amm.json)
                   →  pnpm codegen             (turbo: @fpm/idl#codegen → libs/idl/src/generated)
                   →  keeper / indexer / web pick up new types automatically (buildless)
```
Day-to-day dev: `pnpm dev` (turbo runs codegen if the IDL changed, then starts web + indexer + keeper). Change the program → `anchor build` → types ripple out with no rebuild of the JS packages.

---

## 4. Gotchas checklist (the "properly" part)

- [ ] `programs/*` is in the **Cargo** workspace, **excluded** from `pnpm-workspace.yaml`. Mixing them makes pnpm try to install a Rust crate.
- [ ] Delete any `package.json`/`yarn.lock` `anchor init` drops at root — pnpm owns JS.
- [ ] `libs/idl#codegen` must run **before** any `typecheck`/`dev`/`build` — enforced via `dependsOn`. First-ever run: `anchor build` then `pnpm codegen` manually, else imports of `@fpm/idl` fail.
- [ ] Indexer tsconfig is the **only** one with `emitDecoratorMetadata`; keeper/libs use `erasableSyntaxOnly`. Don't apply one repo-wide tsconfig.
- [ ] Indexer dev runner is **`nest start --watch`** (not `node`/`tsx`) — its framework runner is what reliably emits decorator metadata. Keeper/libs stay buildless.
- [ ] `import "reflect-metadata"` as the **first line** of the indexer entrypoint, or Nest DI silently breaks.
- [ ] Next.js `transpilePackages` MUST list every workspace TS package it imports, or you get "unexpected token" on `.ts` source.
- [ ] Buildless packages: `main`/`types`/`exports` all point at `src/*.ts`; no `dist/`, `noEmit: true`. The editor TS-server reads source directly (no stale build).
- [ ] `workspace:*` for all internal deps; single dependency versions across the repo (`pnpm dedupe`).
- [ ] Seeds/constants live in `@fpm/shared` and are the **same bytes** as the program — never hardcode a seed in keeper/indexer/web.
- [ ] Docker: `turbo prune --scope=@fpm/indexer --docker` (and `@fpm/keeper`) so each image carries only its slice. Prod indexer image uses `nest build` output, not tsx.

---

## 5. First-run sanity sequence
```bash
pnpm install
anchor build              # → target/idl/amm.json
pnpm codegen              # → libs/idl/src/generated
pnpm typecheck            # everything resolves @fpm/idl + @fpm/shared
pnpm dev                  # web + indexer + keeper up; edit program → anchor build → types ripple
```
Definition of done (Phase 0): `pnpm install && anchor build && pnpm codegen && pnpm typecheck` is green from a clean clone, CI runs `NO_DNA=1 anchor build` + `turbo run lint typecheck test --affected`.
