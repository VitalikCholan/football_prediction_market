/**
 * ESM resolve hook: the Codama-generated `@fpm/idl` client uses extensionless
 * relative imports (`export * from './accounts'`, `from '../pdas'`), which
 * node's strict ESM loader rejects. This hook retries failed RELATIVE
 * specifiers bundler-style: `<spec>.ts`, then `<spec>/index.ts`.
 *
 * Scoped to relative specifiers only — bare package imports are untouched.
 */
const RETRYABLE = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
]);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative =
      specifier === "." ||
      specifier === ".." ||
      specifier.startsWith("./") ||
      specifier.startsWith("../");
    if (!RETRYABLE.has(err?.code) || !isRelative) {
      throw err;
    }
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        // fall through to the next candidate
      }
    }
    throw err;
  }
}
