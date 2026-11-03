#!/usr/bin/env node
// Migrate vecs `update` call sites to the explicit-`with` API (vecs #443).
//
//   node scripts/codemods/update-explicit-with.mjs [--dry-run] <file-or-directory>...
//
// `update` used to add the watched component to the predicate; now only `with`
// builds membership. Each rewrite keeps the call's previous meaning:
//
// - `update(C, cb)` becomes `update({ watch: C }, cb)` and requires `C`;
// - `update({ watch: C, ... })` without `optional`, or with `optional: false`,
//   loses the key and requires `C`;
// - `update({ watch: C, optional: true, ... })` loses the key and requires nothing.
//
// Requiring `C` appends it to the nearest `with(...)` of the call chain when that
// call lists only component references, does nothing when a `with(...)` of the
// chain already names it, and otherwise inserts `.with(C)` just before `.update`.
// Every site it cannot rewrite is printed and the script exits with status 1.
// Run it once, on code written for the previous API: on migrated code it would
// read every options literal as the old form and require its watch again.
// Format the rewritten files with your formatter afterwards.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ts = loadTypeScript();

const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".tmp", ".worktrees"]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

/** Run the codemod over the given paths; returns the process exit status. */
export function main(args) {
  const dryRun = args.includes("--dry-run");
  const paths = args.filter((arg) => arg !== "--dry-run");
  if (paths.length === 0) {
    console.error("usage: update-explicit-with.mjs [--dry-run] <file-or-directory>...");
    return 2;
  }
  let rewrites = 0;
  const unrewritable = [];
  for (const file of paths.flatMap(listFiles)) {
    const source = readFileSync(file, "utf8");
    const result = transform(source, file);
    unrewritable.push(...result.unrewritable.map((site) => `${file}:${site.line}: ${site.reason}`));
    if (result.rewrites === 0) {
      continue;
    }
    rewrites += result.rewrites;
    console.log(`${file}: ${result.rewrites} update call(s) rewritten`);
    if (!dryRun) {
      writeFileSync(file, result.output);
    }
  }
  console.log(`${rewrites} update call(s) rewritten${dryRun ? " (dry run)" : ""}`);
  if (unrewritable.length > 0) {
    console.error(`${unrewritable.length} update call(s) need a manual rewrite:`);
    for (const site of unrewritable) {
      console.error(`  ${site}`);
    }
    return 1;
  }
  return 0;
}

/**
 * Rewrite every `update` call in `source`. Returns the new text, the number of
 * rewritten calls and the sites that need a manual rewrite (1-based lines).
 */
export function transform(source, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName)
  );
  const edits = [];
  const unrewritable = [];
  let rewrites = 0;
  const visit = (node) => {
    if (isUpdateCall(node)) {
      const plan = planUpdate(node, sourceFile);
      if (plan.reason !== undefined) {
        unrewritable.push({ line: lineOf(sourceFile, node), reason: plan.reason });
      } else if (plan.edits.length > 0) {
        rewrites++;
        edits.push(...plan.edits);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { output: applyEdits(source, edits), rewrites, unrewritable };
}

/** A `<receiver>.update(a, b)` call with exactly two arguments. */
function isUpdateCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "update" &&
    node.arguments.length === 2
  );
}

/**
 * Decide how to rewrite one update call. Returns `{ edits }`, empty for calls
 * that are not vecs updates, or `{ reason }` for a site it cannot rewrite.
 */
function planUpdate(call, sourceFile) {
  const [options, callback] = call.arguments;
  if (ts.isObjectLiteralExpression(options)) {
    return planOptionsForm(call, options, sourceFile);
  }
  if (isComponentReference(options) && isCallbackLike(callback)) {
    const watch = options.getText(sourceFile);
    return {
      edits: [
        { start: options.getStart(sourceFile), end: options.end, text: `{ watch: ${watch} }` },
        ...requireWatch(call, watch, sourceFile),
      ],
    };
  }
  if (isFunctionLike(callback)) {
    return { reason: "the first argument is neither a component class nor an options literal" };
  }
  return { edits: [] };
}

/** Rewrite `update({ watch, optional?, ... }, cb)`. */
function planOptionsForm(call, options, sourceFile) {
  if (options.properties.some((p) => ts.isSpreadAssignment(p))) {
    return { reason: "the options literal uses a spread" };
  }
  const watchProperty = options.properties.find((p) => propertyName(p) === "watch");
  if (watchProperty === undefined) {
    return { edits: [] };
  }
  const watch = watchExpression(watchProperty, sourceFile);
  if (watch === undefined) {
    return { reason: "the watch property is not a plain property" };
  }
  const optional = options.properties.find((p) => propertyName(p) === "optional");
  if (optional === undefined) {
    return { edits: requireWatch(call, watch, sourceFile) };
  }
  if (!ts.isPropertyAssignment(optional)) {
    return { reason: "optional is not true or false" };
  }
  const value = optional.initializer.kind;
  if (value !== ts.SyntaxKind.TrueKeyword && value !== ts.SyntaxKind.FalseKeyword) {
    return { reason: "optional is not true or false" };
  }
  const removal = removePropertyEdit(optional, sourceFile);
  if (value === ts.SyntaxKind.TrueKeyword) {
    return { edits: [removal] };
  }
  return { edits: [removal, ...requireWatch(call, watch, sourceFile)] };
}

/**
 * Edits that require `watch` on the chain the update call belongs to: none when
 * a `with(...)` already names it, an appended argument on the nearest plain
 * `with(...)`, or an inserted `.with(watch)` before `.update`.
 */
function requireWatch(call, watch, sourceFile) {
  const chain = chainCalls(call.expression.expression);
  const withCalls = chain.filter((c) => c.name === "with");
  if (withCalls.some((c) => c.node.arguments.some((arg) => arg.getText(sourceFile) === watch))) {
    return [];
  }
  const nearest = chain.find((c) => c.name === "with" || c.name === "without");
  if (
    nearest?.name === "with" &&
    nearest.node.arguments.length > 0 &&
    nearest.node.arguments.every(isComponentReference)
  ) {
    const last = nearest.node.arguments[nearest.node.arguments.length - 1];
    return [{ start: last.end, end: last.end, text: `, ${watch}`, order: call.pos }];
  }
  const name = call.expression.name;
  return [
    { start: name.getStart(sourceFile), end: name.getStart(sourceFile), text: `with(${watch}).` },
  ];
}

/** Method calls of a fluent chain, nearest first: `a.with(X).track()` gives track, with. */
function chainCalls(expression) {
  const calls = [];
  let node = expression;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    calls.push({ name: node.expression.name.text, node });
    node = node.expression.expression;
  }
  return calls;
}

/** Remove one property and the comma that separates it from its neighbour. */
function removePropertyEdit(property, sourceFile) {
  const text = sourceFile.text;
  const start = property.getStart(sourceFile);
  const after = /^\s*,[ \t]*/.exec(text.slice(property.end));
  if (after !== null) {
    return { start, end: property.end + after[0].length, text: "" };
  }
  const before = /,\s*$/.exec(text.slice(0, start));
  return { start: before === null ? start : before.index, end: property.end, text: "" };
}

function watchExpression(property, sourceFile) {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.getText(sourceFile);
  }
  if (ts.isPropertyAssignment(property)) {
    return property.initializer.getText(sourceFile);
  }
  return undefined;
}

function propertyName(property) {
  const name = property.name;
  if (name === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** `Position`, `m.Transform`, `registered.Class`: a PascalCase name or member. */
function isComponentReference(node) {
  if (ts.isIdentifier(node)) {
    return /^[A-Z]/.test(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return /^[A-Z]/.test(node.name.text);
  }
  return false;
}

/** A function, a reference to one, or a call that returns one (such as `vi.fn()`). */
function isCallbackLike(node) {
  return (
    isFunctionLike(node) ||
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  );
}

function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Apply non-overlapping edits from the end; same-position inserts keep source order. */
function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || (b.order ?? 0) - (a.order ?? 0));
  let output = source;
  for (const edit of sorted) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function scriptKind(fileName) {
  const extension = extname(fileName);
  if (extension === ".tsx") {
    return ts.ScriptKind.TSX;
  }
  if (extension === ".jsx") {
    return ts.ScriptKind.JSX;
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function listFiles(path) {
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listFiles(child);
    }
    return EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith(".d.ts") ? [child] : [];
  });
}

/** Prefer the project's own TypeScript, falling back to the one next to this script. */
function loadTypeScript() {
  for (const base of [join(process.cwd(), "package.json"), import.meta.url]) {
    try {
      return createRequire(base)("typescript");
    } catch {
      // Try the next location.
    }
  }
  throw new Error("update-explicit-with needs the typescript package installed");
}
