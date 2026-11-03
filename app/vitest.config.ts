import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Phase 2 foundation: server-side unit tests only (no jsdom, no React libs).
// Convention: tests are colocated next to source as `src/**/*.test.ts`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The streamed-upload tests push whole multi-megabyte videos through the
    // platform clients. Alone they take 1-2 s, but with every file running in
    // parallel on a slower machine a few went past Vitest's 5 s default and
    // failed one full run and passed the next (2026-11-02). A test that truly
    // hangs still fails, after 20 s.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      // Mirror the `@/*` -> `./src/*` path alias from tsconfig.json so tests and
      // helpers can import via `@/...` exactly like application code does.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
