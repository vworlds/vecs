import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import internalUnderscore from "./eslint-rules/internal-underscore.js";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      local: {
        rules: { "internal-underscore": internalUnderscore },
      },
    },
    rules: {
      curly: ["error", "all"],
      "local/internal-underscore": "error",
    },
  },
];
