// Flat-config ESLint for the @vcf/cli package.
// Strict TS rules; imports must be explicit; console.log is banned (all logs go to stderr via pino).
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-console": ["error", { allow: ["error"] }],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": [
        "error",
        {
          // Enforce stderr-only logging in stdio mode — stdout is JSON-RPC.
          selector: "MemberExpression[object.name='process'][property.name='stdout']",
          message:
            "Do not write to process.stdout — MCP stdio transport reserves it. Use stderr or the logger.",
        },
      ],
    },
  },
];
