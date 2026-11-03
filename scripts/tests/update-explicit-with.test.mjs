import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, transform } from "../codemods/update-explicit-with.mjs";

function rewrite(source) {
  const result = transform(source);
  assert.deepEqual(result.unrewritable, []);
  return result.output;
}

test("shorthand becomes the options form and joins the nearest plain with", () => {
  assert.equal(
    rewrite(`w.system("s").with(A).update(C, (e, c) => {});`),
    `w.system("s").with(A, C).update({ watch: C }, (e, c) => {});`
  );
});

test("shorthand without a with inserts .with(C) before update", () => {
  assert.equal(
    rewrite(`w.system("s").update(m.C, onUpdate);`),
    `w.system("s").with(m.C).update({ watch: m.C }, onUpdate);`
  );
});

test("shorthand with a call or element-access callback is still a vecs update", () => {
  assert.equal(
    rewrite(`q.with(A).update(C, vi.fn()); q.with(A).update(D, cbs[0]);`),
    `q.with(A, C).update({ watch: C }, vi.fn()); q.with(A, D).update({ watch: D }, cbs[0]);`
  );
});

test("options without optional require the watch", () => {
  assert.equal(
    rewrite(`w.system("s").with(A).phase(P).update({ watch: C, onEnter: true }, cb);`),
    `w.system("s").with(A, C).phase(P).update({ watch: C, onEnter: true }, cb);`
  );
});

test("a watch the chain already requires is left alone", () => {
  const source = `w.system("s").with(A, C).with(B).update({ watch: C }, cb);`;
  const result = transform(source);
  assert.equal(result.output, source);
  assert.equal(result.rewrites, 0);
});

test("optional: false loses the key and requires the watch", () => {
  assert.equal(
    rewrite(`s.with(A).update({ watch: C, optional: false, inject: [A] }, cb);`),
    `s.with(A, C).update({ watch: C, inject: [A] }, cb);`
  );
});

test("optional: true loses the key and requires nothing", () => {
  assert.equal(
    rewrite(`s.with(A).update({ watch: C, onEnter: true, optional: true }, cb);`),
    `s.with(A).update({ watch: C, onEnter: true }, cb);`
  );
});

test("a nearer without or a with of DSL terms gets a separate .with(C)", () => {
  assert.equal(
    rewrite(`s.with(A).without(B).update({ watch: C }, cb);`),
    `s.with(A).without(B).with(C).update({ watch: C }, cb);`
  );
  assert.equal(
    rewrite(`s.with(A, { target: [R, B] }).update({ watch: C }, cb);`),
    `s.with(A, { target: [R, B] }).with(C).update({ watch: C }, cb);`
  );
});

test("several updates of one chain join the same with in source order", () => {
  assert.equal(
    rewrite(`s.with(A).update(B, b).update({ watch: C }, c);`),
    `s.with(A, B, C).update({ watch: B }, b).update({ watch: C }, c);`
  );
});

test("a shorthand watch variable keeps its name", () => {
  assert.equal(
    rewrite(`for (const watch of list) s.with(A).update({ watch, onEnter: true }, cb);`),
    `for (const watch of list) s.with(A, watch).update({ watch, onEnter: true }, cb);`
  );
});

test("update calls that are not vecs updates are untouched", () => {
  const source = `scene.update(time, delta); map.update("k", 1); hash.update(data);`;
  const result = transform(source);
  assert.equal(result.output, source);
  assert.equal(result.rewrites, 0);
  assert.deepEqual(result.unrewritable, []);
});

test("unrewritable sites are reported with their line", () => {
  const result = transform(
    [
      `s.with(A).update({ ...options, watch: C }, cb);`,
      `s.with(A).update(options, (e) => {});`,
      `s.with(A).update({ [key]: C, watch: C, optional: flag }, cb);`,
    ].join("\n")
  );
  assert.deepEqual(result.unrewritable, [
    { line: 1, reason: "the options literal uses a spread" },
    { line: 2, reason: "the first argument is neither a component class nor an options literal" },
    { line: 3, reason: "optional is not true or false" },
  ]);
});

test("main rewrites files, prints unrewritable sites and exits non-zero", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "update-explicit-with-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.ts");
  const bad = join(dir, "bad.ts");
  writeFileSync(good, `s.with(A).update(C, cb);\n`);
  writeFileSync(bad, `s.with(A).update({ ...o, watch: C }, cb);\n`);
  const errors = [];
  const logs = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  t.mock.method(console, "log", (line) => logs.push(line));

  assert.equal(main(["--dry-run", dir]), 1);
  assert.equal(readFileSync(good, "utf8"), `s.with(A).update(C, cb);\n`);

  assert.equal(main([dir]), 1);
  assert.equal(readFileSync(good, "utf8"), `s.with(A, C).update({ watch: C }, cb);\n`);
  assert.ok(errors.some((line) => line.includes(`${bad}:1: the options literal uses a spread`)));

  writeFileSync(bad, `s.with(A, C).update({ watch: C }, cb);\n`);
  assert.equal(main([dir]), 0);
  assert.ok(logs.includes("0 update call(s) rewritten"));
});
