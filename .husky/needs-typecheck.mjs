// Read NUL-delimited staged paths so spaces and newlines in names remain intact.
import { readFileSync } from "node:fs";

const paths = readFileSync(0, "utf8").split("\0").filter(Boolean);
const affectsTypes = paths.some((path) => {
  if (/\.(?:md|mdx|txt|rst)$/.test(path)) return false;
  const name = path.split("/").at(-1);
  return (
    /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(path) ||
    /(?:^|\/)(?:tests?|bench)\//.test(path) ||
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|.*lock.*|tsconfig.*|.*eslint.*|.*vitest.*)$/.test(
      name
    )
  );
});
process.exitCode = affectsTypes ? 0 : 1;
