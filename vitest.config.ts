import { defineConfig } from "vitest/config";
import { COVERAGE_THRESHOLDS } from "../../coverage-gate.mjs";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      exclude: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
      thresholds: COVERAGE_THRESHOLDS,
    },
  },
});
