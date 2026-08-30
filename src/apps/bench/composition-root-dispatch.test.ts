/**
 * HELLGATE — bench COMPOSITION-ROOT dispatch (aug-22 LOW-10 repair).
 *
 * WHY THIS FILE EXISTS. Every fail-closed dataset-family assertion in the
 * jun-30/aug-22 changeset was a PURE-FUNCTION test on `resolveBenchRunConfig` /
 * `parseDatasetFamilyOrThrow`. Nothing observed the composition roots. That is
 * structurally why MED-6 shipped green: the rail exercised the resolver while
 * `cli.ts` handed it a hardcoded `argvFamily: undefined`. A resolver test can
 * never see a mis-wired caller.
 *
 * So every test here drives the REAL dispatch: `bun src/apps/bench/cli.ts <argv>`
 * as a child process (the true `main()` router, the true handler, the true
 * `process.exit`), or the REAL exported handler in-process where the observable
 * is the parent's own `process.env`. Nothing mocks the resolver — mocking the
 * thing under test is exactly what made the old rails worthless.
 *
 * OBSERVABLES (real effects, not re-assertions of the resolver):
 *   - process EXIT STATUS + the operator-facing refusal text,
 *   - the DRY-RUN PLAN each root prints: the resolved execution preset, the
 *     grading-verifier label, and the resolved dataset family — i.e. the typed
 *     decisions the root actually made and would hand to a box,
 *   - ambient `process.env` after an in-process root call (HIGH-1's rail, which
 *     cannot be observed across a process boundary).
 *
 * NON-VACUITY: the whole family union flows through every root, and the
 * assertions are PAIRED — `pro` must differ from `verified`, `live` must differ
 * from `verified` on the family line, and `verified` must equal the absent
 * default. A root that ignored its argv and returned a constant fails the pair.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stripComments } from "@/shared/source-text"
import { positionals, VALUE_FLAGS } from "./commands/shared"
import { DATASET_FAMILY_FLAG, readDatasetFamilySelector } from "./run-config"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"
const CLI = join(import.meta.dir, "cli.ts")
const SPAWN_BUDGET_MS = 240_000

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures + the REAL CLI child-process harness
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = (() => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-cli-root-"))
  const dataset = join(dir, "ds.jsonl")
  writeFileSync(
    dataset,
    `${JSON.stringify({
      instance_id: "demo__pkg-1",
      repo: "demo/pkg",
      base_commit: "0".repeat(40),
      problem_statement: "fix it",
      patch: "",
      test_patch: "",
      FAIL_TO_PASS: "[]",
      PASS_TO_PASS: "[]",
    })}\n`,
  )
  const report = join(dir, "report.json")
  writeFileSync(report, JSON.stringify({ model: "gpt-5.4", resolved_ids: [] }))
  return { dir, dataset, report }
})()

interface CliResult {
  readonly code: number
  readonly out: string
}

/** Spawn the REAL CLI. The family env var is genuinely DELETED unless a case
 *  sets it — an empty string is itself an explicit-blank selector and would make
 *  a refusal pass for the WRONG reason. */
const runCli = (args: readonly string[], env: Record<string, string> = {}): CliResult => {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  if (!(FAMILY_KEY in env)) delete childEnv[FAMILY_KEY]
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: childEnv as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  }
}

/** The family-bearing subcommands, each with the CHEAPEST argv that still
 *  reaches its composition root. `run`/`pool`/`grade --mode full` use --dry-run
 *  (real work, no box, no LLM); `grade` (grade-only) and `bestk-passk` reach the
 *  root and then refuse on missing/unusable inputs — in both cases the family
 *  decision is made BEFORE that refusal, which is itself part of the contract. */
const FAMILY_BEARING = [
  { name: "run", argv: ["run", "--swebench", fixtures.dataset, "--dry-run"], env: {} },
  // Legacy entry: no subcommand at all (a leading flag routes to `run`).
  { name: "no-subcommand", argv: ["--swebench", fixtures.dataset, "--dry-run"], env: {} },
  { name: "grade", argv: ["grade"], env: {} },
  {
    name: "grade --mode full",
    argv: [
      "grade",
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dataset",
      fixtures.dataset,
      "--dry-run",
    ],
    env: {},
  },
  { name: "pool", argv: ["pool"], env: {} },
  {
    name: "bestk-passk",
    argv: [
      "bestk-passk",
      "--observe-root",
      "/nonexistent-observe-root",
      "--dataset",
      "/nonexistent.jsonl",
      "--backend",
      "ec2",
      "--report",
      fixtures.report,
    ],
    env: { QUANTA_BENCH_BESTK_PASSK: "1" },
  },
  { name: "terminal", argv: ["terminal"], env: {} },
] as const

/** Adversarial EXPLICIT selectors. Every one is present-in-argv, so every one
 *  must be refused — the fail-closed contract's whole point is that an operator
 *  who NAMED a family never silently gets Verified. */
const BAD_SELECTORS = [
  { label: "unknown token", args: ["--dataset-family", "prow"] },
  { label: "empty string", args: ["--dataset-family", ""] },
  { label: "whitespace only", args: ["--dataset-family", "   "] },
  { label: "mixed-case garbage", args: ["--dataset-family", "PrOw"] },
  { label: "=-form unknown", args: ["--dataset-family=prow"] },
  { label: "=-form blank", args: ["--dataset-family="] },
  // PMX-01: `promax` exists now, so its NEAR-MISSES are the live typo risk. A
  // prefix-matching or `startsWith` resolver would admit these as ProMax (or as
  // Pro), and a lenient one would grade them as Verified.
  { label: "promax typo (extra char)", args: ["--dataset-family", "promaxx"] },
  { label: "promax typo (separator)", args: ["--dataset-family", "pro-max"] },
  // The flag is the LAST argv token, so `argv[i+1]` is undefined. An EXPLICIT
  // selector that reads back as ABSENT is a fail-OPEN straight to Verified.
  { label: "dangling flag (no value)", args: ["--dataset-family"] },
  // The next token is another flag, so the "value" is a flag name.
  { label: "value swallowed by next flag", args: ["--dataset-family", "--keep"] },
] as const

const FAMILY_REFUSAL = /unknown dataset family|is blank|SWE-only|requires a value|missing a value/i

// ─────────────────────────────────────────────────────────────────────────────
// LOW-10 (a) — fail-closed on EVERY explicit-invalid selector, PER SUBCOMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe("LOW-10 — every family-bearing composition root fails closed on an explicit-invalid selector", () => {
  for (const sub of FAMILY_BEARING) {
    test(
      `${sub.name}: all ${BAD_SELECTORS.length} adversarial selectors are refused`,
      () => {
        const survivors: string[] = []
        for (const sel of BAD_SELECTORS) {
          const r = runCli([...sub.argv, ...sel.args], sub.env)
          if (r.code === 0 || !FAMILY_REFUSAL.test(r.out)) {
            survivors.push(
              `${sel.label} (${sel.args.join(" ")}) -> exit ${r.code}: ${r.out.slice(0, 200)}`,
            )
          }
        }
        expect(
          survivors,
          `${sub.name} accepted an explicit-invalid family selector:\n${survivors.join("\n")}`,
        ).toEqual([])
      },
      SPAWN_BUDGET_MS,
    )
  }

  test(
    "PAIRED CONTROL — a VALID selector is never caught by the family gate",
    () => {
      const leaked: string[] = []
      for (const sub of FAMILY_BEARING) {
        if (sub.name === "terminal") continue // terminal refuses ANY family selector, by design
        for (const family of ["verified", "live", "pro", "promax"]) {
          const r = runCli([...sub.argv, "--dataset-family", family], sub.env)
          if (/unknown dataset family|is blank|requires a value/i.test(r.out)) {
            leaked.push(`${sub.name} --dataset-family ${family}: ${r.out.slice(0, 200)}`)
          }
        }
      }
      expect(leaked, `family gate rejected a VALID family:\n${leaked.join("\n")}`).toEqual([])
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "PAIRED CONTROL — the same roots SUCCEED (or refuse for their OWN reason) with no selector",
    () => {
      // A blanket-failing gate would make this red. `run`/`pool`/`grade --mode
      // full` must reach their dry-run plans (exit 0); `grade`/`bestk-passk`
      // must refuse on their OWN missing inputs (exit 2), never on the family.
      const expectations: Record<string, (r: CliResult) => boolean> = {
        run: (r) => r.code === 0 && r.out.includes("dry-run plan"),
        "no-subcommand": (r) => r.code === 0 && r.out.includes("dry-run plan"),
        grade: (r) => r.code === 2 && /usage: quanta-bench grade/.test(r.out),
        "grade --mode full": (r) => r.code === 0 && r.out.includes("full-remote plan"),
        pool: (r) => r.code === 2 && /refused: pool runs patch-gen/.test(r.out),
        "bestk-passk": (r) => r.code !== 0 && !/unknown dataset family/i.test(r.out),
        terminal: (r) => r.code === 0,
      }
      const wrong: string[] = []
      for (const sub of FAMILY_BEARING) {
        const r = runCli([...sub.argv], sub.env)
        const ok = expectations[sub.name]
        expect(ok, `no expectation registered for ${sub.name}`).toBeDefined()
        if (!ok?.(r)) wrong.push(`${sub.name} -> exit ${r.code}: ${r.out.slice(0, 300)}`)
      }
      expect(wrong, `absent-selector control failed:\n${wrong.join("\n")}`).toEqual([])
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// LOW-10 (b) — argv in ⇒ TYPED DECISION out, observed on the real dry-run plans
// ─────────────────────────────────────────────────────────────────────────────

/** `  key: value` — the local-run dry-run plan's line shape (values may contain
 *  spaces, e.g. the verifier label), read to end-of-line. */
const planLine = (out: string, key: string): string | undefined => {
  const m = new RegExp(`^.*\\b${key}: *(.*)$`, "m").exec(out)
  return m?.[1]?.trim()
}

/** `key=value` — the remote (pool / full-remote) plan's inline token shape. */
const planToken = (out: string, key: string): string | undefined =>
  new RegExp(`\\b${key}=([^\\s,)]+)`).exec(out)?.[1]

const runPlan = (family: string | undefined): CliResult =>
  runCli([
    "run",
    "--swebench",
    fixtures.dataset,
    "--dry-run",
    ...(family !== undefined ? ["--dataset-family", family] : []),
  ])

const poolPlan = (family: string | undefined): CliResult =>
  runCli([
    "pool",
    "--allow-remote-secrets",
    "--datasets",
    fixtures.dataset,
    "--dry-run",
    ...(family !== undefined ? ["--dataset-family", family] : []),
  ])

const fullRemotePlan = (family: string | undefined): CliResult =>
  runCli([
    "grade",
    "--mode",
    "full",
    "--allow-remote-secrets",
    "--dataset",
    fixtures.dataset,
    "--dry-run",
    ...(family !== undefined ? ["--dataset-family", family] : []),
  ])

describe("LOW-10 — the resolved family reaches an OBSERVABLE decision at each root", () => {
  test(
    "run: preset + verifier + family line follow the argv selector (full union, paired)",
    () => {
      const absent = runPlan(undefined)
      const verified = runPlan("verified")
      const live = runPlan("live")
      const pro = runPlan("pro")
      const promax = runPlan("promax")
      for (const r of [absent, verified, live, pro, promax]) expect(r.code).toBe(0)

      // The resolved family is stated explicitly — the ONLY way `live` is
      // distinguishable from `verified` at this root (their parse, preset and
      // verifier are identical by design, so a family-line-free plan could not
      // tell a mis-resolved `live` from a correct `verified`).
      expect(planLine(absent.out, "dataset family")).toBe("verified")
      expect(planLine(verified.out, "dataset family")).toBe("verified")
      expect(planLine(live.out, "dataset family")).toBe("live")
      expect(planLine(pro.out, "dataset family")).toBe("pro")
      expect(planLine(promax.out, "dataset family")).toBe("promax")
      // PMX-01: promax and pro reach DIFFERENT graders (invariant 1), which the
      // verifier line is the root's observable for.
      expect(planLine(promax.out, "verifier")).toMatch(/promax/i)
      expect(planLine(promax.out, "verifier")).not.toBe(planLine(pro.out, "verifier"))

      // Known items: the Pro root really selects the Pro harness + Pro preset.
      expect(planLine(pro.out, "verifier")).toBe("ScaleAI SWE-bench Pro harness")
      expect(planLine(pro.out, "preset")).toBe("agentless-v1")
      // PAIRED: non-Pro families must NOT get the Pro decisions. With the
      // harness gate off they get NO grader at all — official rows ship
      // `testCmd:"true"`, so `verdict.ts` refuses them instead of fake-passing.
      // The line must say so: calling it "local testCmd" advertised a grading
      // mode that never runs and made refusals read as agent misses.
      const refusedLabel =
        "NONE — official grading OFF (every instance REFUSED, reported FAIL). Set QUANTA_SWEBENCH_PYTHON=1 to grade"
      expect(planLine(verified.out, "verifier")).toBe(refusedLabel)
      expect(planLine(live.out, "verifier")).toBe(refusedLabel)
      expect(planLine(verified.out, "verifier")).not.toMatch(/local testCmd/)
      expect(planLine(verified.out, "preset")).not.toBe(planLine(pro.out, "preset"))
      // ...and absent must be byte-equal to explicit verified.
      expect(planLine(absent.out, "preset")).toBe(planLine(verified.out, "preset"))
      expect(planLine(live.out, "preset")).toBe(planLine(verified.out, "preset"))
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "pool: the box-provision plan carries the resolved family + preset (full union, paired)",
    () => {
      const absent = poolPlan(undefined)
      const verified = poolPlan("verified")
      const live = poolPlan("live")
      const pro = poolPlan("pro")
      for (const r of [absent, verified, live, pro]) expect(r.code).toBe(0)

      expect(planToken(absent.out, "dataset-family")).toBe("verified")
      expect(planToken(verified.out, "dataset-family")).toBe("verified")
      expect(planToken(live.out, "dataset-family")).toBe("live")
      expect(planToken(pro.out, "dataset-family")).toBe("pro")

      expect(planToken(pro.out, "preset")).toBe("agentless-v1")
      expect(planToken(verified.out, "preset")).not.toBe(planToken(pro.out, "preset"))
      expect(planToken(absent.out, "preset")).toBe(planToken(verified.out, "preset"))
      expect(planToken(live.out, "preset")).toBe(planToken(verified.out, "preset"))
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "grade --mode full: the box plan carries the resolved family + preset (full union, paired)",
    () => {
      const absent = fullRemotePlan(undefined)
      const verified = fullRemotePlan("verified")
      const live = fullRemotePlan("live")
      const pro = fullRemotePlan("pro")
      for (const r of [absent, verified, live, pro]) expect(r.code).toBe(0)

      expect(planToken(absent.out, "dataset-family")).toBe("verified")
      expect(planToken(verified.out, "dataset-family")).toBe("verified")
      expect(planToken(live.out, "dataset-family")).toBe("live")
      expect(planToken(pro.out, "dataset-family")).toBe("pro")

      expect(planToken(pro.out, "preset")).toBe("agentless-v1")
      expect(planToken(verified.out, "preset")).not.toBe(planToken(pro.out, "preset"))
      expect(planToken(absent.out, "preset")).toBe(planToken(verified.out, "preset"))
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "whitespace-padded / mixed-case selectors reach the root CANONICALIZED",
    () => {
      // LOW-8's documented trim+case-fold semantics, observed on the real roots
      // rather than re-asserted on the resolver.
      for (const raw of ["  PRO  ", "\tpro\n", " Pro "]) {
        expect(planLine(runPlan(raw).out, "dataset family")).toBe("pro")
        expect(planToken(poolPlan(raw).out, "dataset-family")).toBe("pro")
      }
      expect(planLine(runPlan(" LIVE ").out, "dataset family")).toBe("live")
      // The `=`-form spelling must reach the SAME decision as the space form
      // (it is a separate branch in the selector reader).
      expect(
        planLine(
          runCli(["run", "--swebench", fixtures.dataset, "--dry-run", "--dataset-family=pro"]).out,
          "dataset family",
        ),
      ).toBe("pro")
      expect(
        planToken(
          runCli([
            "pool",
            "--allow-remote-secrets",
            "--datasets",
            fixtures.dataset,
            "--dry-run",
            "--dataset-family=live",
          ]).out,
          "dataset-family",
        ),
      ).toBe("live")
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// LOW-10 (c) — the argv-vs-env PRECEDENCE contract, at the roots
// ─────────────────────────────────────────────────────────────────────────────
describe("LOW-10 — argv beats env at every family-bearing root", () => {
  test(
    "run / pool / grade --mode full: argv wins, env is the fallback, env-garbage still refuses",
    () => {
      // env alone ⇒ env is honoured.
      expect(
        planLine(
          runCli(["run", "--swebench", fixtures.dataset, "--dry-run"], { [FAMILY_KEY]: "pro" }).out,
          "dataset family",
        ),
      ).toBe("pro")
      // argv + a CONFLICTING env ⇒ argv wins, in BOTH directions.
      expect(
        planLine(
          runCli(
            ["run", "--swebench", fixtures.dataset, "--dry-run", "--dataset-family", "verified"],
            { [FAMILY_KEY]: "pro" },
          ).out,
          "dataset family",
        ),
      ).toBe("verified")
      expect(
        planLine(
          runCli(["run", "--swebench", fixtures.dataset, "--dry-run", "--dataset-family", "pro"], {
            [FAMILY_KEY]: "live",
          }).out,
          "dataset family",
        ),
      ).toBe("pro")

      // Same three-way contract on the pool root.
      expect(
        planToken(
          runCli(["pool", "--allow-remote-secrets", "--datasets", fixtures.dataset, "--dry-run"], {
            [FAMILY_KEY]: "live",
          }).out,
          "dataset-family",
        ),
      ).toBe("live")
      expect(
        planToken(
          runCli(
            [
              "pool",
              "--allow-remote-secrets",
              "--datasets",
              fixtures.dataset,
              "--dry-run",
              "--dataset-family",
              "pro",
            ],
            { [FAMILY_KEY]: "live" },
          ).out,
          "dataset-family",
        ),
      ).toBe("pro")

      // A VALID argv selector does NOT rescue a garbage env value on a root that
      // never reads argv... and a garbage ENV value alone still fails closed.
      const envGarbage = runCli(["run", "--swebench", fixtures.dataset, "--dry-run"], {
        [FAMILY_KEY]: "prow",
      })
      expect(envGarbage.code).not.toBe(0)
      expect(envGarbage.out).toMatch(/unknown dataset family/i)
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// LOW-10 (d) — HIGH-1's ambient-env rail, at the grade/pool roots IN-PROCESS
// ─────────────────────────────────────────────────────────────────────────────

/** Run `body` with `process.argv` pinned, `process.env` snapshotted/restored,
 *  and raw stdout captured (the dry-run plan block bypasses `logger`). */
const withRoot = async (
  argv: readonly string[],
  body: () => Promise<void>,
): Promise<{ out: string; envAfter: NodeJS.ProcessEnv }> => {
  const argvBefore = process.argv
  const envBefore = { ...process.env }
  const writeBefore = process.stdout.write.bind(process.stdout)
  let captured = ""
  process.argv = ["bun", "cli.ts", ...argv]
  ;(process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    captured += String(chunk)
    return true
  }
  try {
    await body()
    return { out: captured, envAfter: { ...process.env } }
  } finally {
    ;(process.stdout as { write: unknown }).write = writeBefore
    process.argv = argvBefore
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, envBefore)
  }
}

describe("LOW-10 — the grade/pool roots make their decision WITHOUT touching ambient env", () => {
  test(
    "cmdPool resolves Pro and leaves process.env[FAMILY] undefined",
    async () => {
      const { cmdPool } = await import("./commands/pool")
      delete process.env[FAMILY_KEY]
      const { out, envAfter } = await withRoot(
        [
          "pool",
          "--allow-remote-secrets",
          "--datasets",
          fixtures.dataset,
          "--dry-run",
          "--dataset-family",
          "pro",
        ],
        async () => {
          await cmdPool()
        },
      )
      // The decision REALLY flowed (non-vacuous: this is the Pro preset, not the
      // default), and the ambient env was never used as the carrier.
      expect(planToken(out, "preset")).toBe("agentless-v1")
      expect(planToken(out, "dataset-family")).toBe("pro")
      expect(envAfter[FAMILY_KEY]).toBeUndefined()
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "cmdPool does not REWRITE a conflicting operator-set family env value",
    async () => {
      const { cmdPool } = await import("./commands/pool")
      process.env[FAMILY_KEY] = "  LIVE  "
      const { out, envAfter } = await withRoot(
        [
          "pool",
          "--allow-remote-secrets",
          "--datasets",
          fixtures.dataset,
          "--dry-run",
          "--dataset-family",
          "verified",
        ],
        async () => {
          await cmdPool()
        },
      )
      expect(planToken(out, "dataset-family")).toBe("verified")
      // Sentinel preserved byte-for-byte: nothing canonicalized argv into env.
      expect(envAfter[FAMILY_KEY]).toBe("  LIVE  ")
      delete process.env[FAMILY_KEY]
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "cmdGrade --mode full resolves Pro and leaves process.env[FAMILY] undefined",
    async () => {
      const { cmdGrade } = await import("./commands/grade")
      delete process.env[FAMILY_KEY]
      const { out, envAfter } = await withRoot(
        [
          "grade",
          "--mode",
          "full",
          "--allow-remote-secrets",
          "--dataset",
          fixtures.dataset,
          "--dry-run",
          "--dataset-family",
          "pro",
        ],
        async () => {
          await cmdGrade()
        },
      )
      expect(planToken(out, "preset")).toBe("agentless-v1")
      expect(planToken(out, "dataset-family")).toBe("pro")
      expect(envAfter[FAMILY_KEY]).toBeUndefined()
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// NEW-2 — the dispatcher's VALUE_FLAGS table silently drifts from the real
//         `argValue("--flag")` call sites, mis-parsing positionals.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract every value-taking flag LITERAL read by the dispatcher layer. */
const scanValueFlags = (sources: readonly { path: string; text: string }[]): Set<string> => {
  const flags = new Set<string>()
  for (const src of sources) {
    for (const m of stripComments(src.text).matchAll(/argValue\(\s*"(--[^"]+)"/g)) {
      const flag = m[1]
      if (flag !== undefined) flags.add(flag)
    }
  }
  return flags
}

/** The REAL bytes of `cli.ts` + every `./commands/*.ts` handler. `positionals()`
 *  skips the token after a value-flag ONLY if the flag is in `VALUE_FLAGS`, so a
 *  flag read here but missing from that set leaks its VALUE into the positional
 *  list and shifts every real positional one slot. */
const dispatcherSources = async (): Promise<{ path: string; text: string }[]> => {
  const { readdirSync, readFileSync } = await import("node:fs")
  const cmdDir = join(import.meta.dir, "commands")
  const paths = [
    join(import.meta.dir, "cli.ts"),
    ...readdirSync(cmdDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(cmdDir, f)),
  ]
  return paths.map((path) => ({ path, text: readFileSync(path, "utf8") }))
}

describe("NEW-2 — VALUE_FLAGS covers every value-taking flag the dispatcher reads", () => {
  test("known-item floor: the scan really reads the dispatcher's live call sites", async () => {
    const sources = await dispatcherSources()
    const flags = scanValueFlags(sources)
    // A dead walker / dead regex must fail LOUDLY here, not pass vacuously.
    expect(sources.length).toBeGreaterThan(5)
    expect(sources.map((s) => s.path).join("|")).toContain("commands/analyze.ts")
    expect(sources.every((s) => s.text.length > 0)).toBe(true)
    expect(flags.size).toBeGreaterThan(25)
    for (const known of ["--predictions", "--backend", "--report", "--observe-root"]) {
      expect([...flags], `scan lost the known value-flag ${known}`).toContain(known)
    }
    // NON-VACUITY, both directions: the scanner FIRES on a realistic new call
    // site appended to a real file's bytes, and does NOT fire on the same text
    // sitting inside a comment (which is how this file's own prose reads).
    const realFile = sources[0]
    expect(realFile).toBeDefined()
    const injected = `${realFile?.text ?? ""}\nconst x = argValue("--brand-new-flag")\n`
    expect([...scanValueFlags([{ path: "injected", text: injected }])]).toContain(
      "--brand-new-flag",
    )
    const commented = `${realFile?.text ?? ""}\n// const x = argValue("--commented-flag")\n`
    expect([...scanValueFlags([{ path: "commented", text: commented }])]).not.toContain(
      "--commented-flag",
    )
  })

  test("no value-flag read by a handler is missing from VALUE_FLAGS", async () => {
    const flags = scanValueFlags(await dispatcherSources())
    // The family selector has its OWN reader (`readDatasetFamilySelector`), so an
    // argValue-only scan would miss it — but `positionals()` must still skip its
    // value, so it belongs in the same universe.
    flags.add(DATASET_FAMILY_FLAG)
    const missing = [...flags].filter((f) => !VALUE_FLAGS.has(f)).sort()
    expect(
      missing,
      `these flags take a value but are absent from VALUE_FLAGS, so positionals() ` +
        `treats their VALUE as a positional argument: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("BEHAVIORAL — positionals() does not leak a value-flag's value", () => {
    const argvBefore = process.argv
    try {
      // Realistic invocation shape: value-flags first, reports last.
      process.argv = [
        "bun",
        "cli.ts",
        "wave2-ab",
        "--control-predictions",
        "/c.jsonl",
        "--treatment-predictions",
        "/t.jsonl",
        "--dataset-family",
        "pro",
        "/A.json",
        "/B.json",
      ]
      expect(positionals()).toEqual(["/A.json", "/B.json"])
      // Paired direction: a genuine positional in the FIRST slot is still kept,
      // and a BOOLEAN flag must NOT swallow the token after it.
      process.argv = ["bun", "cli.ts", "cost", "/A.json", "--observe-dir", "/obs"]
      expect(positionals()).toEqual(["/A.json"])
      process.argv = ["bun", "cli.ts", "leaderboard", "--keep", "/A.json"]
      expect(positionals()).toEqual(["/A.json"])
    } finally {
      process.argv = argvBefore
    }
  })

  test(
    "END-TO-END — wave2-ab reads the REPORTS as reports, not the predictions files",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "quanta-wave2-"))
      const write = (name: string, body: unknown): string => {
        const p = join(dir, name)
        writeFileSync(p, JSON.stringify(body))
        return p
      }
      const control = write("control-report.json", { model: "m", resolved_ids: [] })
      const treatment = write("treatment-report.json", { model: "m", resolved_ids: [] })
      const cPred = write("control-preds.jsonl", { instance_id: "x" })
      const tPred = write("treatment-preds.jsonl", { instance_id: "x" })
      const r = runCli([
        "wave2-ab",
        "--control-predictions",
        cPred,
        "--treatment-predictions",
        tPred,
        control,
        treatment,
      ])
      // Both reports lack perInstance provenance, so this refuses either way —
      // the load-bearing assertion is WHICH file it names. Before the fix it
      // named the PREDICTIONS file, i.e. the positional parse was shifted.
      expect(r.out).toContain("control-report.json")
      expect(r.out).not.toContain("control-preds.jsonl")
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// NEW-1 — the selector READER: ABSENT vs PRESENT-BUT-VALUELESS
// ─────────────────────────────────────────────────────────────────────────────
describe("NEW-1 — readDatasetFamilySelector separates ABSENT from typed-but-valueless", () => {
  test("ABSENT ⇒ undefined; a real value ⇒ that value, in BOTH argv spellings", () => {
    // Absent — the ONLY input allowed to yield the Verified default.
    expect(readDatasetFamilySelector(["bun", "cli.ts", "run", "--swebench", "ds"])).toBeUndefined()
    expect(readDatasetFamilySelector([])).toBeUndefined()
    // Full union, both spellings, and a padded/mixed-case token passed through
    // VERBATIM (canonicalization belongs to the ONE normalization owner).
    for (const family of ["verified", "live", "pro", "promax", "  PROMAX  ", "prow"]) {
      expect(readDatasetFamilySelector(["x", DATASET_FAMILY_FLAG, family])).toBe(family)
      expect(readDatasetFamilySelector(["x", `${DATASET_FAMILY_FLAG}=${family}`])).toBe(family)
    }
    // Explicit-blank is PRESENT, not absent — it must reach the fail-closed
    // parser as "" so the operator gets the blank-selector error.
    expect(readDatasetFamilySelector(["x", DATASET_FAMILY_FLAG, ""])).toBe("")
    expect(readDatasetFamilySelector(["x", `${DATASET_FAMILY_FLAG}=`])).toBe("")
    // Space form wins over an `=` form, matching the generic argValue reader.
    expect(
      readDatasetFamilySelector(["x", `${DATASET_FAMILY_FLAG}=live`, DATASET_FAMILY_FLAG, "pro"]),
    ).toBe("pro")
  })

  test("PRESENT-BUT-VALUELESS ⇒ throws (never silently absent)", () => {
    // Flag is the last token.
    expect(() => readDatasetFamilySelector(["x", "run", DATASET_FAMILY_FLAG])).toThrow(
      /requires a value/i,
    )
    // Value slot swallowed by the NEXT flag — no family starts with "-", so this
    // is always a swallowed value, never a family.
    expect(() => readDatasetFamilySelector(["x", DATASET_FAMILY_FLAG, "--keep"])).toThrow(
      /requires a value/i,
    )
    expect(() => readDatasetFamilySelector(["x", DATASET_FAMILY_FLAG, "-h"])).toThrow(
      /requires a value/i,
    )
    // PAIRED CONTROL: the same argv with a real value does NOT throw.
    expect(() =>
      readDatasetFamilySelector(["x", DATASET_FAMILY_FLAG, "pro", "--keep"]),
    ).not.toThrow()
  })
})
