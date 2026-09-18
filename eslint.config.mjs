import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { react: { version: "19.3" } } },
  {
    files: ["src/components/**/*.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  {
    // The stock merger does not know the app's type scale, so it reads `text-body` as a color and drops the real one
    // from the same element, with no error anywhere. shadcn writes this import into every base-nova item it generates.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/common/cn.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "cn", message: "Import cn from @/components/common/cn; the stock merger does not know the type scale." }] },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**", "src/server/scan/inpage/generated/**"]),
]);
