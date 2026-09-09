import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    ignores: [
      "dist/**",
      "dist-desktop/**",
      "test-results/**",
      "coverage/**",
      ".venv/**",
      "node_modules/**"
    ]
  }
);
