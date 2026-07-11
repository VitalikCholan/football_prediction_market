/**
 * Bundle step for the container image. `nest build -b swc` already emits
 * dist/*.js with decorator metadata; the only runtime problem is that the
 * buildless workspace libs (@fpm/idl, @fpm/shared) ship as TS SOURCE, and Node
 * refuses to strip types for files under node_modules.
 *
 * Fix: inline ONLY the @fpm/* source into a single dist/bundle.cjs and keep
 * every real node_modules dependency (Nest, Prisma, @solana/kit, …) external —
 * so Nest's optional lazy-requires and Prisma's native engine load normally
 * from node_modules, while no @fpm TypeScript is ever resolved at runtime.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["dist/main.js"],
  outfile: "dist/bundle.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  plugins: [
    {
      name: "externalize-non-fpm",
      setup(b) {
        // Externalize real node_modules deps (Nest, Prisma, @solana/kit, …) so
        // they load normally at runtime. Keep bundling: @fpm/* workspace source
        // and `#…` subpath imports (@fpm/shared's internal `imports` map).
        b.onResolve({ filter: /^[^.]/ }, (args) => {
          if (args.path.startsWith("@fpm/")) return; // workspace source → bundle
          if (args.path.startsWith("#")) return; // internal subpath → bundle
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
