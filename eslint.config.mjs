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
  {
    // Page code checks the two values it needs from the contract by hand (`isErrorCode`, the hidden reasons table): a
    // value import would put zod, about 100 KB of it, back into the first load of the page. Types are free, and the
    // development check of the stream loads the contract through a dynamic import, which this rule does not see.
    files: ["src/components/**/*.{ts,tsx}", "src/lib/client/**/*.{ts,tsx}", "src/app/{page,layout,not-found,error}.tsx", "instrumentation-client.ts"],
    ignores: ["**/*.test.ts", "src/lib/client/testing.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/contract", allowTypeImports: true, message: "Page code imports types only from the contract; a value brings zod into the bundle." },
            { name: "zod", message: "Keep zod out of the page bundle." },
            { name: "zod/mini", message: "Keep zod out of the page bundle." },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "playwright-report/**", "test-results/**", "src/server/scan/inpage/generated/**"]),
]);
