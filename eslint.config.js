// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── TypeScript strict rules ──────────────────────────────
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],

      // ── General best practices ───────────────────────────────
      "no-console": "off", // CLI app uses console extensively
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    // Ignore non-source files
    ignores: [
      "dist/",
      "node_modules/",
      "observability/",
      "templates/",
      "_bmad/",
      "_bmad-output/",
      "scripts/",
      "test/",
      "**/*.js",
      "!eslint.config.js",
    ],
  }
);
