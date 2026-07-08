import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Phase 2 foundation: server-side unit tests only (no jsdom, no React libs).
// Convention: tests are colocated next to source as `src/**/*.test.ts`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Mirror the `@/*` -> `./src/*` path alias from tsconfig.json so tests and
      // helpers can import via `@/...` exactly like application code does.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
