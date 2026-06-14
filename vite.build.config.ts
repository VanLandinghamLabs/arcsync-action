import { builtinModules } from "node:module";
import type { Plugin } from "rollup";
import { defineConfig } from "vite";

// Some CJS deps (via @actions/core → undici) do require("performance"),
// which is not a real Node package — it resolves to the perf_hooks global.
// Intercept at resolve time and redirect to node:perf_hooks.
function resolvePerformance(): Plugin {
  return {
    name: "resolve-performance",
    resolveId(source) {
      if (source === "performance") {
        return { id: "node:perf_hooks", external: true };
      }
    },
  };
}

export default defineConfig({
  plugins: [resolvePerformance()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        inlineDynamicImports: true,
        // Vite 7+ uses rolldown as the bundler. Rolldown leaves `require()`
        // calls in ESM output for CJS deps (e.g. inside undici's optional
        // branches) instead of fully converting them — the rolldown CJS
        // shim throws "Calling `require` for X in an environment that
        // doesn't expose the `require` function" under Node's pure-ESM
        // loader (action.yml uses node24). Prepend a createRequire shim
        // so any remaining `require()` calls resolve to a real loader
        // backed by import.meta.url. Cheap (one CJS require per process)
        // and fully ESM-safe.
        banner:
          'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
    },
    target: "node22",
    outDir: "dist",
    sourcemap: true,
    minify: false,
    emptyOutDir: true,
  },
});
