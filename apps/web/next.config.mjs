import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@fpm/shared", "@fpm/idl"],
  // Emit `.next/standalone` — a minimal `node server.js` + traced node_modules,
  // so the Docker runtime stage needs no `pnpm install`. Native Next 16 output,
  // no third-party adapter.
  output: "standalone",
  // pnpm monorepo: trace from the repo ROOT so file tracing follows the hoisted
  // (symlinked) `node_modules/.pnpm` store and workspace `@fpm/*` deps. Without
  // this, Next roots tracing at apps/web and misses hoisted deps at runtime.
  // Consequence: the standalone server nests under the package path, i.e.
  // `.next/standalone/apps/web/server.js`.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
