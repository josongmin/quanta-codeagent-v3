/**
 * TB21-00A — HELLGATE for the `quanta-bench terminal` REGISTRATION.
 *
 * WHY A CHILD-PROCESS TEST. The MED-6 defect this repo already paid for was a
 * composition root that handed its resolver a hardcoded `undefined`: every pure
 * unit test stayed green while the LIVE cli path let a SWE-only axis through. So
 * the observables here are the REAL `bun src/apps/bench/cli.ts …` process — its
 * exit status and the bytes it prints — not a re-assertion of a pure builder.
 *
 * ⚠️⚠️ SPEND SAFETY. `quanta-bench terminal run` WITHOUT `--dry-run` executes
 * `harbor run`, which provisions containers and bills a provider for 89 tasks ×
 * k trials. An earlier session's proof-of-a-CLI-gate spawned the real thing and
 * leaked ten c7i.4xlarge spot boxes. Therefore:
 *   - `runCli` below THROWS if a `run` action ever reaches it without
 *     `--dry-run` — the guard is in the harness, by construction;
 *   - the executing path is proven with an INJECTED spawn port in-process, and
 *     "the port was never called" is itself the load-bearing assertion.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { resolveTerminalRunConfig } from "../terminal/config"
import { TERMINAL_BENCH_DATASET } from "../terminal/dataset"
import { buildTerminalRunManifest, validateTerminalRunManifest } from "../terminal/manifest"
import { cmdTerminal, spawnSyncText } from "./terminal"

const CLI = join(import.meta.dir, "..", "cli.ts")
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SPAWN_BUDGET_MS = 240_000

interface CliResult {
  readonly code: number
  readonly out: string
}

/** Spawn the REAL CLI. ⚠️ Never lets a live `terminal run` through. */
const runCli = (args: readonly string[], env: Record<string, string> = {}): CliResult => {
  if (args[0] === "terminal" && args[1] === "run" && !args.includes("--dry-run")) {
    throw new Error("spend guard: never spawn a live `terminal run` in a test")
  }
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  delete childEnv.QUANTA_SWEBENCH_DATASET_FAMILY
  for (const key of Object.keys(env)) childEnv[key] = env[key]
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: childEnv as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` }
}

const RUN_ARGS = [
  "terminal",
  "run",
  "--profile",
  "quanta-full",
  "--model",
  "gpt-5.5",
  "--provider",
  "openai",
  "--effort",
  "xhigh",
  "--dry-run",
] as const

// ─────────────────────────────────────────────────────────────────────────────

describe("nested command registration", () => {
  test(
    "`terminal` with no action prints the four registered actions",
    () => {
      const r = runCli(["terminal"])
      expect(r.code).toBe(0)
      for (const action of ["doctor", "canary", "run", "report"]) {
        expect(r.out, `usage does not name ${action}`).toContain(action)
      }
      // The BFND-01 stub it replaces claimed the suite was unwired — that string
      // must be GONE, or the command is still a placeholder.
      expect(r.out).not.toContain("not yet wired")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "an unknown action is refused (exit 2), not silently treated as `run`",
    () => {
      const r = runCli(["terminal", "grade"])
      expect(r.code).toBe(2)
      expect(r.out).toMatch(/doctor/)
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "RED RAIL — registration does NOT shadow legacy SWE `run` routing",
    () => {
      const swe = runCli([
        "run",
        "--swebench",
        join(REPO_ROOT, "tests/smoke/swebench/picks.jsonl"),
        "--dry-run",
      ])
      expect(swe.out).toContain("dry-run plan")
      expect(swe.out).not.toContain("terminal-bench")
      // The legacy no-subcommand entry still routes to the SWE runner too.
      const legacy = runCli([
        "--swebench",
        join(REPO_ROOT, "tests/smoke/swebench/picks.jsonl"),
        "--dry-run",
      ])
      expect(legacy.out).toContain("dry-run plan")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "RED RAIL — `--dataset-family` on the terminal subcommand is refused by the LIVE cli",
    () => {
      for (const sel of [
        ["--dataset-family", "verified"],
        ["--dataset-family=pro"],
        ["--dataset-family"],
      ]) {
        const r = runCli(["terminal", "doctor", ...sel])
        expect(r.code, sel.join(" ")).not.toBe(0)
        expect(r.out).toMatch(/SWE-only|requires a value/i)
      }
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────

describe("the dry-run receipt is the operator's proof of what would run", () => {
  const receipt = (env: Record<string, string> = {}): CliResult => runCli([...RUN_ARGS], env)

  test(
    "prints the final harbor argv with the exact 2.1 dataset + agent selector",
    () => {
      const r = receipt()
      expect(r.code).toBe(0)
      expect(r.out).toContain("terminal-bench/terminal-bench-2-1@sha256:")
      expect(r.out).toContain("quanta_agent:QuantaAgent")
      expect(r.out).toContain("reasoning_effort=xhigh")
      expect(r.out).toContain("gpt-5.5")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "RED RAIL — the ambient env cannot override a resolved profile knob",
    () => {
      // A stale operator export is the 2.0 shell-script failure mode verbatim.
      const CONTROL_ARGS = RUN_ARGS.map((a) => (a === "quanta-full" ? "control" : a))
      expect(runCli(CONTROL_ARGS).code).toBe(0)
      const withStaleExport = runCli(CONTROL_ARGS, {
        QUANTA_TB_VERIFY_GATE: "1",
        QUANTA_MAX_TURNS: "999",
      })
      expect(withStaleExport.code).toBe(0)
      expect(withStaleExport.out).toContain("QUANTA_TB_VERIFY_GATE=0")
      expect(withStaleExport.out).not.toContain("QUANTA_MAX_TURNS=999")
      // PAIRED CONTROL: the quanta-full profile really does deliver it ON, so the
      // assertion above is about the ENV being ignored, not about the key being
      // hardcoded off.
      expect(receipt().out).toContain("QUANTA_TB_VERIFY_GATE=1")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "SECURITY — the receipt shows credential NAMES, never values",
    () => {
      const secret = "sk-live-CLI-RECEIPT-MUST-NOT-PRINT"
      const r = receipt({ OPENAI_API_KEY: secret })
      expect(r.out).not.toContain(secret)
      expect(r.out).toContain("OPENAI_API_KEY")
      expect(r.out).toMatch(/redacted/i)
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "RED RAIL — an under-specified paid run refuses BEFORE printing a command",
    () => {
      for (const missing of ["--model", "--effort", "--profile"]) {
        const argv = [...RUN_ARGS].filter((tok, i, all) => {
          const prev = all[i - 1]
          return tok !== missing && prev !== missing
        })
        const r = runCli(argv)
        expect(r.code, `${missing} absent`).not.toBe(0)
        expect(r.out).not.toContain("quanta_agent:QuantaAgent")
      }
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────

/** An ALL-GREEN doctor + provenance port. Injected so the paid-path tests
 *  measure the SPEND GATE, not whether this machine has a Docker daemon.
 *  Module-scoped: both the spend-guard block and the run→report handoff block
 *  drive the paid path and must agree on what "green" means. */
const greenRun = (bin: string, args: readonly string[]) => {
  const line = [bin, ...args].join(" ")
  if (line.startsWith("git rev-parse")) return { code: 0, stdout: "9d5369d310bb\n", stderr: "" }
  if (line.startsWith("git status")) return { code: 0, stdout: "", stderr: "" }
  if (line.includes("quanta_agent")) {
    return {
      code: 0,
      stdout: JSON.stringify({
        module: "quanta_agent",
        klass: "QuantaAgent",
        isBaseAgentSubclass: true,
        abstractMethods: [],
        supportsAtif: true,
      }),
      stderr: "",
    }
  }
  return { code: 0, stdout: "1.0.0\n", stderr: "" }
}

describe("SPEND GUARD — the executing path is only ever reached deliberately", () => {
  const base = {
    doctorRun: greenRun,
    canWriteDir: () => true,
    now: () => "2026-08-22T00:00:00.000Z",
    write: () => {},
  } as const

  test("`run --dry-run` NEVER calls the spawn port", async () => {
    let calls = 0
    await cmdTerminal({
      ...base,
      argv: [...RUN_ARGS],
      env: { OPENAI_API_KEY: "x" },
      spawnHarbor: () => {
        calls += 1
        return 0
      },
      exit: () => {},
    })
    expect(calls, "a --dry-run reached the harbor spawn port").toBe(0)
  })

  test("a live `run` DOES call the injected port exactly once (paired control)", async () => {
    const seen: Array<{ bin: string; argv: readonly string[] }> = []
    await cmdTerminal({
      ...base,
      argv: RUN_ARGS.filter((a) => a !== "--dry-run"),
      env: { OPENAI_API_KEY: "x" },
      spawnHarbor: (bin, argv) => {
        seen.push({ bin, argv })
        return 0
      },
      exit: () => {},
    })
    expect(seen.length).toBe(1)
    expect(seen[0]?.bin).toBe("uv")
    expect(seen[0]?.argv).toContain("quanta_agent:QuantaAgent")
  })

  test("a doctor failure BLOCKS the paid run (the port is never reached)", async () => {
    let calls = 0
    const codes: number[] = []
    await cmdTerminal({
      ...base,
      argv: RUN_ARGS.filter((a) => a !== "--dry-run"),
      env: {}, // no credential at all ⇒ the doctor's credentials check is red
      spawnHarbor: () => {
        calls += 1
        return 0
      },
      exit: (c) => {
        codes.push(c)
      },
    })
    expect(calls, "a red doctor did NOT block the paid run").toBe(0)
    expect(codes.some((c) => c !== 0)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("package scripts are THIN aliases only", () => {
  const scripts = (): Readonly<Record<string, string>> =>
    (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>
      }
    ).scripts

  test("every terminal-bench alias invokes the ONE cli entry", () => {
    const aliases = Object.entries(scripts()).filter(([name]) => name.startsWith("bench:tb"))
    // Anti-vacuity: the aliases exist, so the rail below is checking something.
    expect(aliases.length).toBeGreaterThanOrEqual(1)
    for (const [name, body] of aliases) {
      expect(body, `${name} does not route through the unified cli`).toContain(
        "src/apps/bench/cli.ts terminal",
      )
    }
  })

  test("RED RAIL — no package script constructs Harbor argv", () => {
    const offenders = Object.entries(scripts()).filter(([, body]) =>
      /harbor\s+run|--agent[- ]|--ak\s|--ae\s|terminal-bench-2-1@/.test(body),
    )
    expect(
      offenders.map(([n]) => n),
      "a package script builds Harbor argv; aliases must be thin",
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("the probe port survives a missing binary", () => {
  // FOUND BY RUNNING IT: `Bun.spawnSync` THROWS `Executable not found in $PATH`
  // instead of returning 127, so the very first `terminal doctor` on a machine
  // without the brain shim crashed with a bare error string — no receipt, no
  // per-check verdict, and no way to see WHICH probe failed. A doctor whose job
  // is diagnosing a missing tool must not die on one.
  test("a missing executable is a NON-ZERO result, not a thrown exception", () => {
    const r = spawnSyncText("quanta-definitely-not-a-real-binary-zzz", ["--version"])
    expect(r.code).not.toBe(0)
    expect(`${r.stderr}${r.stdout}`.length).toBeGreaterThan(0)
  })

  test("PAIRED CONTROL — a real executable still reports its own exit code", () => {
    expect(spawnSyncText("git", ["rev-parse", "HEAD"]).code).toBe(0)
    expect(
      spawnSyncText("git", ["rev-parse", "--verify", "definitely-not-a-ref-zzz"]).code,
    ).not.toBe(0)
  })

  test("`terminal doctor` renders a receipt even when a probe binary is absent", async () => {
    const lines: string[] = []
    const codes: number[] = []
    await cmdTerminal({
      argv: ["terminal", "doctor", "--model", "gpt-5.5", "--effort", "xhigh"],
      env: { PATH: "/nonexistent-bin-dir" },
      write: (t) => lines.push(t),
      exit: (c) => codes.push(c),
    })
    const out = lines.join("\n")
    expect(out).toContain("dataset-identity")
    expect(out).toContain("brain-shim")
    expect(codes).toEqual([1])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("`terminal report` consumes the manifest, it does not re-derive one", () => {
  const MANIFEST_JSON = (() => {
    const cfg = resolveTerminalRunConfig({
      argv: ["terminal", "run", "--profile", "control", "--model", "gpt-5.5", "--effort", "xhigh"],
      env: {},
    })
    return JSON.stringify(
      buildTerminalRunManifest({
        cfg,
        provenance: { packageVersion: "1.0.025", sha: "9d5369d310bb", dirty: false },
        harborVersion: "0.21.0",
        timestamp: "2026-08-22T00:00:00.000Z",
      }),
    )
  })()

  /** TB21-04 wired the LAST hop: the report is no longer printed, it is persisted
   *  through the canonical writer. So the assertions read the artifact the writer
   *  actually landed, and the canonical mirror is redirected into the same temp
   *  dir so nothing reaches the operator's live `~/.quanta/bench/results`. */
  const runReport = async (
    manifestJson: string,
  ): Promise<{ out: string; codes: number[]; report: Record<string, unknown> | null }> => {
    const dir = mkdtempSync(join(tmpdir(), "tb21-cmd-report-"))
    const prior = process.env.QUANTA_BENCH_RESULTS_DIR
    process.env.QUANTA_BENCH_RESULTS_DIR = join(dir, "ssot")
    __resetRuntimeConfig()
    const outFile = join(dir, "tb21.report.json")
    const lines: string[] = []
    const codes: number[] = []
    try {
      await cmdTerminal({
        argv: [
          "terminal",
          "report",
          "--manifest",
          "/fake/manifest.json",
          "--job-dir",
          "/no/such/dir",
          "--out",
          outFile,
        ],
        env: {},
        readText: () => manifestJson,
        write: (t) => lines.push(t),
        exit: (c) => codes.push(c),
      })
      return {
        out: lines.join("\n"),
        codes,
        report: existsSync(outFile)
          ? (JSON.parse(readFileSync(outFile, "utf8")) as Record<string, unknown>)
          : null,
      }
    } finally {
      if (prior === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
      else process.env.QUANTA_BENCH_RESULTS_DIR = prior
      __resetRuntimeConfig()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("the manifest's identity fields become the report's, verbatim", async () => {
    const { codes, report } = await runReport(MANIFEST_JSON)
    expect(codes).toEqual([0])
    expect(report).not.toBeNull()
    const persisted = report as Record<string, unknown>
    expect(persisted.schemaVersion).toBe("terminal-bench-report/v2")
    expect(persisted.benchmarkSuite).toBe("terminal-bench")
    expect(persisted.arm).toBe("control")
    expect(persisted.preset).toBe("terminal-bench-2.1/control")
    expect(persisted.k).toBe(5)
    // The manifest rides through, TYPED, not re-derived.
    expect((persisted.manifest as Record<string, unknown>).schemaVersion).toBe(
      "terminal-bench-run/v2",
    )
    expect(persisted).not.toHaveProperty("datasetFamily")
  })

  test("RED RAIL — a manifest that fails validation stops the report BEFORE anything is written", async () => {
    const poisoned = JSON.stringify({
      ...(JSON.parse(MANIFEST_JSON) as Record<string, unknown>),
      datasetFamily: "verified",
    })
    const { out, codes, report } = await runReport(poisoned)
    expect(codes).toEqual([2])
    expect(out).toMatch(/datasetFamily/i)
    // Nothing landed: a refused manifest must not leave a half-identified artifact.
    expect(report).toBeNull()
  })

  test("RED RAIL — no --out means no destination is invented", async () => {
    const lines: string[] = []
    const codes: number[] = []
    await cmdTerminal({
      argv: ["terminal", "report", "--manifest", "/fake/manifest.json", "--job-dir", "/no/such"],
      env: {},
      readText: () => MANIFEST_JSON,
      write: (t) => lines.push(t),
      exit: (c) => codes.push(c),
    })
    expect(codes).toEqual([2])
    expect(lines.join("\n")).toContain("--out")
  })
})

/**
 * MEASURED aug-22, first green canary. `terminal report` REQUIRES
 * `--manifest <run-manifest.json>` — it is the authority for the dataset ref,
 * the agent version, the effort decision, the knob set and the promotion
 * blockers. `terminal run` built that manifest in memory, printed a receipt from
 * it, spawned harbor, and threw it away.
 *
 * So after a REAL run there was no manifest on disk and the last hop of the
 * TB21-04 pipeline had no input: the two halves of the pipeline had never been
 * connected, and nothing said so, because every test drove each half with a
 * hand-built fixture.
 *
 * The manifest is written BEFORE the spawn, deliberately: a harbor job that dies
 * halfway is exactly when an operator needs to know what was launched.
 */
describe("run → report handoff", () => {
  // The same green-doctor fixture the paid-run tests above use, re-declared here
  // because it is scoped to that describe block.
  const base = {
    doctorRun: greenRun,
    canWriteDir: () => true,
    fileExists: () => true,
    now: () => "2026-08-22T00:00:00.000Z",
    write: () => {},
  } as const

  const runArgs = (out: string) => [
    "terminal",
    "run",
    "--profile",
    "quanta-full",
    "--model",
    "gpt-5.5",
    "--effort",
    "xhigh",
    "--out",
    out,
  ]

  test("a paid run PERSISTS its run-manifest into the output root", async () => {
    const out = mkdtempSync(join(tmpdir(), "tb-run-manifest-"))
    const written: Array<{ path: string; text: string }> = []
    await cmdTerminal({
      ...base,
      argv: runArgs(out),
      env: { OPENAI_API_KEY: "x" },
      spawnHarbor: () => 0,
      writeFile: (path, text) => {
        written.push({ path, text })
      },
      exit: () => {},
    })

    const manifests = written.filter((w) => w.path.includes("run-manifest"))
    expect(manifests.length, "no run-manifest was persisted").toBe(1)
    expect(manifests[0]?.path.startsWith(out)).toBe(true)

    // It must be the REAL manifest — `report` validates it, so a placeholder or
    // a partial dump would fail there rather than here.
    const parsed = validateTerminalRunManifest(JSON.parse(manifests[0]?.text ?? "{}"))
    expect(parsed.model).toBe("gpt-5.5")
    expect(parsed.dataset).toBe(TERMINAL_BENCH_DATASET)
    rmSync(out, { recursive: true, force: true })
  })

  test("it is written BEFORE the spawn, so a dead job still leaves provenance", async () => {
    const out = mkdtempSync(join(tmpdir(), "tb-run-manifest-"))
    const order: string[] = []
    await cmdTerminal({
      ...base,
      argv: runArgs(out),
      env: { OPENAI_API_KEY: "x" },
      writeFile: (path) => {
        if (path.includes("run-manifest")) order.push("manifest")
      },
      spawnHarbor: () => {
        order.push("spawn")
        return 1 // the job dies
      },
      exit: () => {},
    })
    expect(order).toEqual(["manifest", "spawn"])
    rmSync(out, { recursive: true, force: true })
  })

  test("PAIRED CONTROL — a --dry-run persists nothing (it spends nothing)", async () => {
    const out = mkdtempSync(join(tmpdir(), "tb-run-manifest-"))
    const written: string[] = []
    await cmdTerminal({
      ...base,
      argv: [...runArgs(out), "--dry-run"],
      env: { OPENAI_API_KEY: "x" },
      writeFile: (path) => written.push(path),
      spawnHarbor: () => 0,
      exit: () => {},
    })
    expect(written.filter((p) => p.includes("run-manifest"))).toEqual([])
    rmSync(out, { recursive: true, force: true })
  })
})
