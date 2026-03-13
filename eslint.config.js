import js from "@eslint/js";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "debug/**",
      "docs/**",
      "fixtures/**",
      "tests/manual/legacy/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs"],
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off"
    }
  },
  {
    files: ["electron/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs"
    }
  }
];
