import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run after the workspace build. Stop at the Phaser-free @vworlds dependencies.
const entry = new URL("../dist/headless.js", import.meta.url);
const visited = new Set();
await walk(entry);
const headless = await import(entry.href);
assert.deepEqual(Object.keys(headless).sort(), [
  "DeadReckonedModule",
  "phaserInterpolators",
  "rotationInterpolator",
]);
console.log(
  `Headless built graph: ${visited.size} modules, no Phaser imports; Node import passed.`
);

async function walk(url) {
  if (visited.has(url.href)) return;
  visited.add(url.href);
  const source = ts.createSourceFile(
    url.pathname,
    await readFile(url, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert(ts.isStringLiteral(node.arguments[0]), "Nonliteral dynamic import in headless graph");
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of imports) {
    assert(
      specifier !== "phaser" && !specifier.startsWith("phaser/"),
      `Phaser import in ${url.pathname}`
    );
    if (specifier.startsWith(".")) await walk(new URL(specifier, url));
    else assert(specifier.startsWith("@vworlds/"), `Unexpected dependency: ${specifier}`);
  }
}
