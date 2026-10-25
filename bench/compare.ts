/**
 * Interleaved A/B comparison of `bench/sector-tick.ts` between two vecs builds.
 *
 *   node bench/compare.ts <base-checkout> [head-checkout]
 *
 * Both checkouts must already be built (`npm run build`). The head defaults to
 * this checkout. Every round runs the benchmark once per build in a fresh
 * process, alternating which build goes first so machine drift and warm caches
 * hit both sides equally. `BENCH_ROUNDS` sets the number of rounds (default 8);
 * every other `BENCH_*` variable is passed through to the benchmark.
 *
 * The report gives each build's mean tick time per run, and the head/base ratio
 * of every round. It also checks that both builds produced the same checksum,
 * callback trace and network bytes: a pure optimization must not change them.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type BenchResult = {
  tick: { mean: number; median: number; p95: number };
  checksum: string;
  trace: string;
  bytesSent: number;
};

const benchDir = dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === "--release") {
  releaseCheck();
} else {
  const [baseArg, headArg] = process.argv.slice(2);
  if (baseArg === undefined) {
    console.error("usage: node bench/compare.ts <base-checkout> [head-checkout]");
    process.exit(2);
  }
  const variants = [
    { label: "base", root: resolve(baseArg) },
    { label: "head", root: resolve(headArg ?? resolve(benchDir, "..")) },
  ];
  const rounds = Number(process.env.BENCH_ROUNDS ?? 8);

  const results = new Map<string, BenchResult[]>(variants.map((v) => [v.label, []]));
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) {
      const result = runOnce(variant.root);
      results.get(variant.label)!.push(result);
      console.log(
        `round ${round + 1}/${rounds} ${variant.label}: mean ${result.tick.mean} ms, ` +
          `median ${result.tick.median} ms, p95 ${result.tick.p95} ms`
      );
    }
  }

  const base = results.get("base")!;
  const head = results.get("head")!;
  console.log("");
  for (const [label, runs] of results) {
    const means = runs.map((run) => run.tick.mean);
    console.log(
      `${label}: mean tick ${fmt(median(means))} ms median of ${runs.length} runs ` +
        `(min ${fmt(Math.min(...means))}, max ${fmt(Math.max(...means))}, ` +
        `stdev ${fmt(stdev(means))})`
    );
  }
  const ratios = base.map((run, index) => head[index].tick.mean / run.tick.mean);
  const faster = ratios.filter((ratio) => ratio < 1).length;
  console.log(
    `head/base per round: median ${fmt(median(ratios), 3)} ` +
      `(min ${fmt(Math.min(...ratios), 3)}, max ${fmt(Math.max(...ratios), 3)}); ` +
      `head faster in ${faster}/${ratios.length} rounds; ` +
      `change ${fmt((median(ratios) - 1) * 100, 1)}%`
  );

  const fingerprint = (run: BenchResult): string => `${run.checksum}/${run.trace}/${run.bytesSent}`;
  const fingerprints = new Set([...base, ...head].map(fingerprint));
  if (fingerprints.size === 1) {
    console.log(`behavior: identical checksum/trace/bytes ${[...fingerprints][0]}`);
  } else {
    console.log(`behavior: DIFFERENT checksum/trace/bytes: ${[...fingerprints].join(", ")}`);
    process.exitCode = 1;
  }
}

function runOnce<T = BenchResult>(root: string, file = "sector-tick.ts"): T {
  const child = spawnSync(
    process.execPath,
    ["--import", resolve(benchDir, "register-dist.mjs"), resolve(benchDir, file)],
    { env: { ...process.env, BENCH_VECS_ROOT: root }, encoding: "utf8" }
  );
  if (child.status !== 0) {
    throw new Error(`benchmark failed for ${root}:\n${child.stderr}`);
  }
  const lines = child.stdout.split("\n").filter((candidate) => /^[A-Z_]+_RESULT /.test(candidate));
  if (lines.length === 0) {
    throw new Error(`benchmark printed no result for ${root}:\n${child.stdout}`);
  }
  const results = lines.map((line) => JSON.parse(line.slice(line.indexOf(" ") + 1)) as T);
  return (results.length === 1 ? results[0] : { results }) as T;
}

type Metric = { name: string; timing: boolean; bytes: boolean; values: (number | string)[] };
type Comparison = {
  metric: string;
  previous: number | string | null;
  head: number | string;
  delta: number | string | null;
  verdict: string;
  spread?: number;
};

/** Build the latest reachable release and compare HEAD's identical benchmark programs. */
function releaseCheck(): void {
  const head = resolve(benchDir, "..");
  const output = resolve(head, ".tmp/release-check");
  mkdirSync(output, { recursive: true });
  const release =
    process.env.BENCH_BASE_REF ?? command("git", ["describe", "--tags", "--abbrev=0"], head).trim();
  const base = mkdtempSync(resolve(output, "release-"));
  const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
  if (!Number.isInteger(rounds) || rounds < 3) {
    throw new Error("BENCH_ROUNDS must be an integer >= 3 for release checks");
  }
  const table: Comparison[] = [];
  let registered = false;
  try {
    build(head);
    try {
      command("git", ["worktree", "add", "--detach", base, release], head);
      registered = true;
      if (
        readFileSync(resolve(base, "package-lock.json"), "utf8") ===
        readFileSync(resolve(head, "package-lock.json"), "utf8")
      ) {
        symlinkSync(resolve(head, "node_modules"), resolve(base, "node_modules"), "dir");
      } else {
        command("npm", ["ci"], base, { HUSKY: "0" });
      }
      build(base);
    } catch (error) {
      const warning = `release check: could not build ${release} for comparison: ${firstErrorLine(error)}`;
      console.warn(warning);
      writeFileSync(resolve(output, "comparison.md"), warning + "\n");
      return;
    }
    const files = [
      "sector-tick.ts",
      "dr-bandwidth.ts",
      "idle-systems.ts",
      ...readdirSync(benchDir).filter((file) => /(?:physics.*pose|pose.*out).*\.ts$/.test(file)),
    ];
    for (const file of files) {
      const samples = new Map<string, Metric[]>();
      let noPrevious = false;
      for (let round = 0; round < rounds; round++) {
        const variants = round % 2 === 0 ? ["previous", "head"] : ["head", "previous"];
        for (const variant of variants) {
          if (variant === "previous" && noPrevious) {
            continue;
          }
          let result: Record<string, unknown>;
          try {
            result = runOnce<Record<string, unknown>>(variant === "head" ? head : base, file);
          } catch (error) {
            if (
              variant === "previous" &&
              /does not provide an export named|No build output for @vworlds\//.test(String(error))
            ) {
              noPrevious = true;
              continue;
            }
            throw error;
          }
          const metrics = extractMetrics(file, result);
          const previous = samples.get(variant);
          if (!previous) {
            samples.set(variant, metrics);
          } else {
            for (const metric of metrics) {
              const accumulated = previous.find((candidate) => candidate.name === metric.name);
              if (!accumulated) {
                throw new Error(`metric set changed between runs: ${file}/${metric.name}`);
              }
              accumulated.values.push(...metric.values);
            }
          }
        }
      }
      for (const metric of samples.get("head") ?? []) {
        const previous = noPrevious
          ? undefined
          : samples.get("previous")?.find((candidate) => candidate.name === metric.name);
        table.push(compareMetric(`${file.replace(".ts", "")}/${metric.name}`, metric, previous));
      }
    }
    const markdown = [
      `## Benchmark comparison: ${release} → HEAD`,
      "",
      "| Metric | Previous release | HEAD | Delta | Verdict |",
      "| --- | ---: | ---: | ---: | --- |",
      ...table.map(
        (row) =>
          `| ${row.metric} | ${row.previous ?? "no previous data"} | ${row.head} | ${row.delta ?? "—"} | ${row.verdict} |`
      ),
      "",
      `Timing: arithmetic means of ${rounds} alternating runs; a warning requires >10% regression and a delta larger than either run-to-run range. Deterministic metrics are compared exactly, including within-build repeatability.`,
    ].join("\n");
    console.log(markdown);
    writeFileSync(resolve(output, "comparison.md"), markdown + "\n");
    writeFileSync(
      resolve(output, "comparison.json"),
      JSON.stringify({ release, rounds, table }, null, 2) + "\n"
    );
    if (process.env.GITHUB_ACTIONS) {
      for (const row of table) {
        if (row.verdict.startsWith("WARNING")) {
          console.log(`::warning::${row.metric}: ${row.verdict} (${row.previous} → ${row.head})`);
        }
      }
    }
  } finally {
    if (registered) {
      command("git", ["worktree", "remove", "--force", base], head);
    } else {
      rmSync(base, { recursive: true, force: true });
    }
  }
}

function build(root: string): void {
  for (const name of [
    "vecs",
    "vecs-wire",
    "vecs-protocol",
    "vecs-client",
    "vecs-server",
    "vecs-physics",
    "vecs-phaser",
    "vecs-phaser-server",
  ]) {
    if (!existsSync(resolve(root, "lib", name, "package.json"))) {
      continue;
    }
    command(
      "npm",
      ["run", name === "vecs-physics" ? "compile" : "build", "-w", `@vworlds/${name}`],
      root
    );
  }
}

function command(program: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const child = spawnSync(
    program,
    program === "git" ? ["-c", `safe.directory=${cwd}`, ...args] : args,
    { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env }
  );
  if (child.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed (${child.status}):\n${child.stdout}\n${child.stderr}`
    );
  }
  return child.stdout;
}

function firstErrorLine(error: unknown): string {
  return (
    String(error)
      .split("\n")
      .find((line) => line.trim() !== "") ?? String(error)
  );
}

function extractMetrics(file: string, result: Record<string, unknown>): Metric[] {
  const flat: Record<string, number | string> = {};
  const visit = (value: unknown, name: string): void => {
    if (typeof value === "number" || typeof value === "string") {
      flat[name] = value;
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        visit(child, name ? `${name}.${key}` : key);
      }
    }
  };
  visit(result, "");
  const names =
    file === "sector-tick.ts"
      ? [
          "tick.mean",
          "checksum",
          "trace",
          "bytesSent",
          "entities",
          "asteroids",
          "retargetsPerTick",
          "spawnsPerTick",
        ]
      : Object.keys(flat).filter((name) => !/^(?:config|node)(?:\.|$)/.test(name));
  return names.map((name) => {
    const value = flat[name];
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`invalid or missing metric ${file}/${name}`);
    }
    return {
      name,
      timing:
        /(?:NsPerBodyStep$|nsPerSystem$|Ms$|\.mean$|\.median$|\.p\d+$|\.min$|\.max$|\.stdev$)/.test(
          name
        ),
      bytes: /bytes/i.test(name),
      values: [value],
    };
  });
}

function compareMetric(name: string, head: Metric, previous?: Metric): Comparison {
  const summarize = (metric: Metric): number | string =>
    metric.timing ? mean(metric.values as number[]) : metric.values[0];
  const current = summarize(head);
  if (!previous) {
    return {
      metric: name,
      previous: null,
      head: current,
      delta: null,
      verdict: "no previous data",
    };
  }
  const old = summarize(previous);
  const delta =
    typeof current === "number" && typeof old === "number"
      ? current - old
      : current === old
        ? "unchanged"
        : "changed";
  let verdict: string;
  let spread: number | undefined;
  if (head.timing) {
    const range = (values: (number | string)[]): number =>
      Math.max(...(values as number[])) - Math.min(...(values as number[]));
    spread = Math.max(range(head.values), range(previous.values));
    verdict =
      Number(current) > Number(old) * 1.1 && Number(delta) > spread
        ? "WARNING: timing regression >10% beyond spread"
        : "OK: within threshold/spread";
  } else if (new Set(head.values).size !== 1 || new Set(previous.values).size !== 1) {
    verdict = "WARNING: metric is not repeatable";
  } else {
    verdict =
      current === old
        ? "identical"
        : head.bytes && Number(current) > Number(old)
          ? "WARNING: bytes grew"
          : "changed";
  }
  return {
    metric: name,
    previous: old,
    head: current,
    delta,
    verdict,
    ...(spread === undefined ? {} : { spread }),
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stdev(values: readonly number[]): number {
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return Math.sqrt(values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length);
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}
