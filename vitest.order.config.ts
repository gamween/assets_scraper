import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const order = (process.env.ORDER ?? "").split(",");
class Ordered extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    const rank = (f: TestSpecification) => order.findIndex((o) => f.moduleId.endsWith(o));
    return [...files].sort((a, b) => rank(a) - rank(b));
  }
}
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { sequencer: Ordered },
  },
});
