import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      { extends: true, test: { name: "unit", environment: "node", include: ["src/**/*.test.ts"] } },
      { extends: true, test: { name: "dom", environment: "jsdom", include: ["src/**/*.test.tsx"] } },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
