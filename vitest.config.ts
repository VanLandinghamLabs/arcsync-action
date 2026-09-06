import { defineConfig } from "vitest/config";
import { COVERAGE_THRESHOLDS } from "../../coverage-gate.mjs";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: COVERAGE_THRESHOLDS,
    },
  },
});
