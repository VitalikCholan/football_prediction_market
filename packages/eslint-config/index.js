// Minimal shared flat ESLint config for the @fpm monorepo.
// Kept barebones for the hackathon; per-package configs can extend this array.
/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["**/dist/**", "**/.next/**", "**/.turbo/**", "**/src/generated/**"],
  },
];
