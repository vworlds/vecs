import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import internalUnderscore from "./eslint-rules/internal-underscore.js";

export default [
  {
    files: ["lib/*/src/**/*.ts", "lib/*/tests/**/*.ts", "apps/*/src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "unused-imports": unusedImportsPlugin,
    },
    rules: {
      curly: ["error", "all"],
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    files: ["lib/*/src/**/*.ts", "lib/*/tests/**/*.ts"],
    plugins: {
      local: {
        rules: { "internal-underscore": internalUnderscore },
      },
    },
    rules: {
      "local/internal-underscore": "error",
    },
  },
];
