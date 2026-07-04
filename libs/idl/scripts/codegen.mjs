// Standalone Codama codegen: target/idl/amm.json -> libs/idl/src/generated
// Produces an @solana/kit-compatible TS client (buildless-consumed by @fpm/shared, apps).
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idlPath = resolve(__dirname, "../../../target/idl/amm.json");
const outDir = resolve(__dirname, "../src/generated");

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
