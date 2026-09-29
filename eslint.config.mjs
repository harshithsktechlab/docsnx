import { FlatCompat } from "@eslint/eslintrc";
import path from "path";
import { fileURLToPath } from "url";
import tailwind from "eslint-plugin-tailwindcss";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals"),
  ...tailwind.configs["flat/recommended"],
  // Ignore build artifacts
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    /**
     * Undefined identifiers are ERRORS, everywhere.
     *
     * `next/core-web-vitals` leaves `no-undef` off, and `tsc` does not check
     * `.js` at all — so a component could reference a variable that was never
     * declared and pass both gates. Three pages shipped exactly that:
     * `{success}` on the bulk-scan completed screen (which threw at render and
     * replaced the whole result with an error boundary), `disabled={uploading}`
     * on the lic-mediclaim and vehicles add forms, and a `registrationStatus`
     * state wills-estate bound a <Select> to but never created.
     *
     * Scoped to the JS/JSX files TypeScript cannot see. TS files are covered by
     * `tsc`, where this rule is redundant and known to misfire on type-only
     * names.
     */
    files: ["src/**/*.{js,jsx}"],
    rules: {
      "no-undef": "error",
    },
  },
  {
    files: ["src/app/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "tailwindcss/no-arbitrary-value": "warn",
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/enforces-shorthand": "warn",
      "no-restricted-syntax": [
        "warn",
        {
          "selector": "JSXElement[openingElement.name.name='button']",
          "message": "Use the <Button> component from @/components/ui instead of raw <button>."
        },
        {
          "selector": "JSXElement[openingElement.name.name='input']",
          "message": "Use the <Input> component from @/components/ui instead of raw <input>."
        },
        {
          "selector": "JSXElement[openingElement.name.name='select']",
          "message": "Use the <Select> component from @/components/ui instead of raw <select>."
        },
        {
          "selector": "JSXElement[openingElement.name.name='table']",
          "message": "Use the <Table> component from @/components/ui instead of raw <table>."
        },
        {
          "selector": "JSXElement[openingElement.name.name='a']",
          "message": "Use the <Link> component from next/link instead of raw <a>."
        }
      ]
    }
  }
];

export default eslintConfig;
