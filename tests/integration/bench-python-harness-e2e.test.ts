/**
 * Bench Python harness e2e — REAL spawn pipeline, stub `python` binary.
 *
 * ── Why this sits at L4 (integration), not contract ───────────────────────
 * The contract tier exercises the REAL `swebench.harness.run_evaluation`
 * grader inside Docker (heavy, gated, polite-skip). The unit + bench-eval
 * tiers cover the pure logic and the `spawn`/`probe` injection seam with JS
 * fakes.
 *
 * THIS suite sits between them: it leaves `evaluateWithPythonSwebench`'s
 * default `defaultSpawn` (= real `Bun.spawn`) in place and substitutes the
 * `python` interpreter itself with a bash script on `PATH`. The result is a
 * full FS + child-process + argv + env + report-file pipeline driven by
 * production code paths — the exact e2e wire the JS-fake tests cannot reach.
 *
 * A regression that, e.g., (a) flipped the argv order so `--predictions_path`
 * was dropped, (b) stopped passing the work dir as cwd, or (c) silently
 * swallowed harness exit codes WOULD FAIL HERE — and only here, since the
 * unit-level fake spawn doesn't see real argv reaching a real process.
 *
 * ── Stub binary contract ───────────────────────────────────────────────────
 * The stub bash script handles BOTH probe and run modes the module emits:
 *
 *  - `python -c "import swebench"`        → exit 0 (or 1, scripted).
 *  - `python -m swebench.harness.run_evaluation \
 *       --predictions_path P --run_id R --instance_ids I … `
 *       → record every argv element (RS-separated) into a fixture-configured
 *         log file outside the harness's
 *         tmp `work` dir, which is `rm -rf`'d immediately after the call),
 *         then emit a report JSON shaped like the upstream harness
 *         (`{ "resolved_ids": [...] }`) into the harness's cwd (= `work`),
 *         and `exit 0` (or scripted code / hang / malformed body).
 *
 * The stub is created in a per-test tmpdir, made executable, and the test's
 * `process.env.PATH` is prepended with that dir so `Bun.spawn(["python", …])`
 * resolves to it. Fixture controls are files beside the executable, because
 * the production child deliberately receives a scrubbed environment.
 * `process.env.PATH` is restored in `afterEach` so nothing leaks across tests.
 *
 * No real Python, no Docker, no network. Cleaned up in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateWithPythonSwebench } from "../../src/apps/bench/python-swebench"
import type { Instance } from "../../src/apps/bench/types"

const RS = "\x1e"
const mkInstance = (
  id: string,
  over: Partial<Instance> = {},
  opts: { noSwebench?: boolean } = {},
): Instance => {
  const base: Instance = {
    id,
    repoPath: "/tmp/does-not-matter",
    problemStatement: "fix it",
    testCmd: "true",
    ...(opts.noSwebench
      ? {}
      : {
          swebench: { instanceId: id, repo: "demo/demo", baseCommit: "0".repeat(40) },
        }),
  }
  return { ...base, ...over }
}

describe("bench python harness e2e — stub `python` binary on PATH", () => {
  let dir: string
  let argvLog: string
  let savedPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pyharness-e2e-"))
    argvLog = join(dir, "argv.log")
    savedPath = process.env.PATH
    // Prepend our stub dir so `python` (and `python3`) resolve to our script.
    process.env.PATH = `${dir}:${savedPath ?? ""}`
  })
  afterEach(() => {
    // Restore PATH BEFORE rm — never leak the stub PATH into other suites.
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Write a `python` shell script to `${dir}/python` (and a `python3` symlink-
   * by-copy) that:
   *  - handles `-c "import swebench"` per its fixture control file
   *  - handles `-m swebench.harness.run_evaluation ...` by recording argv to
   *    a fixture-configured log (RS-separated) and writing configured JSON to
   *    `report.json` in cwd, then either sleeping or exiting with the
   *    configured code (default 0).
   */
  const writeStub = (
    opts: {
      readonly argvLog?: string
      readonly reportBody?: string
      readonly sleepSeconds?: string
      readonly exitCode?: number
      readonly importOk?: boolean
    } = {},
  ): void => {
    const writeControl = (name: string, value: string | undefined): void => {
      if (value !== undefined) writeFileSync(join(dir, name), value)
    }
    writeControl("argv-log", opts.argvLog)
    writeControl("report-body", opts.reportBody)
    writeControl("sleep-seconds", opts.sleepSeconds)
    writeControl("exit-code", opts.exitCode?.toString())
    writeControl("import-ok", opts.importOk === undefined ? undefined : opts.importOk ? "1" : "0")
    const stubPath = join(dir, "python")
    // `exec sleep` PID-replace trick (same as docker-sandbox-e2e): SIGTERM
    // reaches sleep directly so timeoutMs cancellation is observable.
    const lines = [
      "#!/usr/bin/env bash",
      "set -u",
      'stub_dir="$(cd "$(dirname "$0")" && pwd)"',
      // jun-28: buildArgv now invokes the harness via a `python -c <shim>` (the
      // SPHINX_RA_SHIM that appends -rA then runpy.run_module). The import-PROBE
      // is ALSO `python -c "import swebench"`. Both start with `-c`, so we route
      // on the script body: the RUN shim contains `run_evaluation`, the probe
      // does not.
      `if [ "$1" = "-c" ]; then`,
      `  case "$2" in`,
      // Run path: `python -c "<...run_evaluation...>" --predictions_path ...`.
      `    *run_evaluation*)`,
      '      if [ -f "$stub_dir/argv-log" ]; then',
      '        argv_log="$(cat "$stub_dir/argv-log")"',
      `        printf '%s\\x1e' "$0" >> "$argv_log"`,
      `        for arg in "$@"; do printf '%s\\x1e' "$arg" >> "$argv_log"; done`,
      "      fi",
      // Write the report JSON into the harness cwd (= work dir). Control files
      // keep this test hermetic without weakening the production env scrub.
      '      if [ -f "$stub_dir/report-body" ]; then cat "$stub_dir/report-body" > report.json; else : > report.json; fi',
      '      if [ -f "$stub_dir/sleep-seconds" ]; then exec sleep "$(cat "$stub_dir/sleep-seconds")"; fi',
      '      if [ -f "$stub_dir/exit-code" ]; then exit "$(cat "$stub_dir/exit-code")"; else exit 0; fi ;;',
      // Probe path: `python -c "import swebench"`.
      `    *)`,
      '      if [ -f "$stub_dir/import-ok" ] && [ "$(cat "$stub_dir/import-ok")" != "1" ]; then exit 1; else exit 0; fi ;;',
      `  esac`,
      "fi",
      // Anything else (defensive): exit 0.
      "exit 0",
    ]
    writeFileSync(stubPath, lines.join("\n"))
    chmodSync(stubPath, 0o755)
    // python3 — same script, copied (PYTHONS = ["python", "python3"]).
    const stubPath3 = join(dir, "python3")
    writeFileSync(stubPath3, lines.join("\n"))
    chmodSync(stubPath3, 0o755)
  }

  const readArgv = (): string[] => {
    const raw = readFileSync(argvLog, "utf8")
    return raw.split(RS).filter((s) => s.length > 0)
  }

  // (a) happy path — stub reports the id resolved.
  test("(a) happy path: stub returns resolved_ids:[id] → resolved:true via real spawn", async () => {
    writeStub({ argvLog, reportBody: JSON.stringify({ resolved_ids: ["case-1"] }) })

    const r = await evaluateWithPythonSwebench(
      mkInstance("case-1"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    )

    expect(r.resolved).toBe(true)
    expect(r.log).toContain("case-1")
    expect(r.log).toContain("exit: 0")
    expect(r.log).toContain('resolved_ids: ["case-1"]')
  })

  // (b) failure path — stub returns empty resolved_ids.
  test("(b) failure path: stub returns empty resolved_ids → resolved:false", async () => {
    writeStub({ argvLog, reportBody: JSON.stringify({ resolved_ids: [] }) })

    const r = await evaluateWithPythonSwebench(
      mkInstance("case-2"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    )

    expect(r.resolved).toBe(false)
    expect(r.log).toContain("exit: 0")
    expect(r.log).toContain("resolved_ids: []")
  })

  // (c) argv contract — exact argv reaches the real subprocess.
  test("(c) argv contract: -c <run_evaluation shim> with --predictions_path/--instance_ids/--run_id", async () => {
    writeStub({ argvLog, reportBody: JSON.stringify({ resolved_ids: ["case-c"] }) })

    // Inject an explicit HarnessConfig to pin the argv contract independent
    // of runtime-config defaults (which now flow from env via
    // resolveHarnessConfig — `cache_level=env clean=false workers=4 namespace=none`
    // are the SOTA defaults; the OLD `none/True/1` is still reachable via env
    // override but we don't depend on it here).
    await evaluateWithPythonSwebench(
      mkInstance("case-c"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
      {
        datasetName: "princeton-nlp/SWE-bench_Lite",
        harnessConfig: {
          cacheLevel: "env",
          clean: false,
          maxWorkers: 4,
          namespace: "none",
          forceRebuild: false,
        },
      },
    )

    const argv = readArgv()
    // argv[0] is the stub binary path ($0). buildArgv now invokes the harness
    // via `-c <SPHINX_RA_SHIM>`: argv[1] is `-c`, argv[2] is the shim body (runs
    // run_evaluation via runpy + appends -rA for sphinx). The run_evaluation
    // flags follow as sys.argv.
    expect(argv[1]).toBe("-c")
    expect(argv[2]).toContain("swebench.harness.run_evaluation")
    expect(argv[2]).toContain("'-rA'")

    const i = (flag: string): number => argv.indexOf(flag)
    expect(i("--predictions_path")).toBeGreaterThan(-1)
    // The predictions file path must point at a real JSONL produced by the
    // module (we cannot read it back — harness cwd was rm -rf'd — but the
    // arg must at minimum end in `predictions.jsonl`).
    expect(argv[i("--predictions_path") + 1]).toMatch(/predictions\.jsonl$/)

    expect(i("--run_id")).toBeGreaterThan(-1)
    expect(argv[i("--run_id") + 1] ?? "").toMatch(/^quanta-case-c-\d+$/)

    expect(i("--instance_ids")).toBeGreaterThan(-1)
    expect(argv[i("--instance_ids") + 1]).toBe("case-c")

    expect(i("--max_workers")).toBeGreaterThan(-1)
    expect(argv[i("--max_workers") + 1]).toBe("4")

    expect(i("--cache_level")).toBeGreaterThan(-1)
    expect(argv[i("--cache_level") + 1]).toBe("env")

    expect(i("--clean")).toBeGreaterThan(-1)
    expect(argv[i("--clean") + 1]).toBe("False")

    // --namespace omitted: swebench==2.1.6 does not accept --namespace
    expect(i("--namespace")).toBe(-1)

    // --force_rebuild absent unless explicitly enabled (default off)
    expect(i("--force_rebuild")).toBe(-1)

    expect(i("--dataset_name")).toBeGreaterThan(-1)
    expect(argv[i("--dataset_name") + 1]).toBe("princeton-nlp/SWE-bench_Lite")
  })

  // (d) malformed report — never throws; resolved:false with log.
  test("(d) malformed report.json → resolved:false, never throws (graceful skip)", async () => {
    // Intentionally broken JSON the tolerant reader will skip.
    writeStub({ argvLog, reportBody: "{not valid json" })

    const r = await evaluateWithPythonSwebench(
      mkInstance("case-d"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    )

    expect(r.resolved).toBe(false)
    // The stub must finish successfully; an env/spawn error is not evidence
    // that malformed-report parsing was exercised.
    expect(r.log).toContain("exit: 0")
    expect(r.log).toContain("retried: false")
    expect(readArgv()).toContain("--predictions_path")
    // Module's log uses resolved_ids: [] when the only report file is
    // unparseable — proves tolerance, not crash.
    expect(r.log).toContain("resolved_ids: []")
  })

  // (e) timeout — stub hangs; opts.timeoutMs fires.
  test("(e) timeout: stub hangs, opts.timeoutMs kills the real child", async () => {
    // exec sleep 3 — the PID-replace trick means SIGTERM lands on sleep.
    writeStub({
      argvLog,
      reportBody: JSON.stringify({ resolved_ids: ["case-e"] }),
      sleepSeconds: "3",
    })

    const start = Date.now()
    const r = await evaluateWithPythonSwebench(
      mkInstance("case-e"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
      { timeoutMs: 250 },
    )
    const elapsed = Date.now() - start

    // Killed well before the 3s the stub would otherwise sleep. Even though
    // the stub already wrote report.json before exec sleep, the timeout MUST
    // fire to unblock the caller — that is the seam under test.
    expect(elapsed).toBeLessThan(2500)
    // Whether `resolved` is true or false is incidental (depends on whether
    // the stub managed to flush report.json before the kill). The contract
    // we lock in here is "no hang, no throw, returns a structured result".
    expect(typeof r.resolved).toBe("boolean")
    expect(typeof r.log).toBe("string")
  }, 10000)

  // (f) probe negative — `import swebench` exits 1 → unavailable path; no
  //     run-mode invocation happens (proves probe wiring through real spawn).
  test("(f) probe fails (import swebench exit 1) → unavailable, run-mode never spawned", async () => {
    writeStub({ argvLog, importOk: false })

    const r = await evaluateWithPythonSwebench(
      mkInstance("case-f"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    )

    expect(r.resolved).toBe(false)
    expect(r.log).toContain("unavailable")
    // The stub records argv ONLY on run_evaluation shims. Probes never write.
    let probeOnly = true
    try {
      const argv = readArgv()
      // If any argv was recorded, it must have only come from the probe
      // (and our stub does NOT log probe). So a non-empty file is a bug.
      probeOnly = argv.length === 0
    } catch {
      // ENOENT — log never written, which is the expected case.
    }
    expect(probeOnly).toBe(true)
  })

  // (g) non-swebench instance — short-circuits before any spawn.
  test("(g) non-swebench instance → resolved:false, harness never invoked", async () => {
    writeStub({ argvLog })

    const r = await evaluateWithPythonSwebench(
      mkInstance("case-g", {}, { noSwebench: true }),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    )

    expect(r.resolved).toBe(false)
    expect(r.log).toContain("no swebench metadata")
    let argvWritten = true
    try {
      readArgv()
    } catch {
      argvWritten = false
    }
    expect(argvWritten).toBe(false)
  })
})
