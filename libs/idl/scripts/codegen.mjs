// Standalone Codama codegen: target/idl/amm.json -> libs/idl/src/generated
// Produces an @solana/kit-compatible TS client (buildless-consumed by @fpm/shared, apps).
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idlPath = resolve(__dirname, "../../../target/idl/amm.json");
const outDir = resolve(__dirname, "../src/generated");

// The generated client is committed, so consumers (and the JS-only CI job)
// typecheck against it WITHOUT the Anchor toolchain. If the IDL isn't present
// (no `anchor build` in this environment) but the committed client already
// exists, no-op and use what's checked in. Only regenerate when the IDL exists
// (the Anchor CI job builds it, then the idl-fresh check catches any drift).
if (!existsSync(idlPath)) {
  const hasGenerated =
    existsSync(outDir) && readdirSync(outDir).length > 0;
  if (hasGenerated) {
    console.log(
      `@fpm/idl: no IDL at ${idlPath} — using committed src/generated (skip).`,
    );
    process.exit(0);
  }
  throw new Error(
    `@fpm/idl: IDL missing (${idlPath}) and no committed client in ${outDir}. Run 'anchor build' first.`,
  );
}

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
await Promise.resolve(
  codama.accept(
    renderJavaScriptVisitor(outDir, {
      deleteFolderBeforeRendering: true,
      formatCode: false,
    }),
  ),
);
console.log(`@fpm/idl generated from ${idlPath} -> ${outDir}`);
