/**
 * ADR-0466 — Startup environment-probe hellgate.
 *
 * Locks the read-only toolchain probe (Cursor CloudAgentStartupWarning
 * absorption). The slice MUST:
 *
 *   - All-present → no warnings (every check `found:true` ⇒ `[]`).
 *   - Missing python3 → exactly ONE info warning with a degradation hint.
 *   - Missing core binary → `warn` severity (node/bun/git are core).
 *   - Exec error (Err) → SKIP that check, no crash, no warning for it.
 *   - Exec REJECTION (programmer bug) → degrades to skip, never escapes.
 *   - Gate OFF (enabled !== true) → `[]` AND the exec port is NEVER called
 *     (byte-identical to no probe).
 *   - Deterministic ordering: CORE order, then manifest-derived runners.
 *   - Manifest-derived test-runner checks: only emitted when the manifest
 *     implies the runner (no spurious pytest warning on a JS-only repo).
 *   - Abort → returns warnings gathered so far, no throw.
 *   - degradationHint is total over the closed WarningKind union.
 *
 * The fake exec port is a deterministic table keyed by the probed binary — no
 * real shelling out, no wall-clock, no network.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_WARNING_KINDS,
  CORE_CHECKS,
  degradationHint,
  deriveManifest,
  type ProbeExecError,
  type ProbeExecPort,
  type ProbeExecResult,
  type ProjectManifest,
  type RawProjectSignals,
  runEnvProbe,
  type WarningKind,
} from "@/runtime/env-probe"
import { ok, type Result } from "@/shared"

/** Build a deterministic fake exec port from a found-set of binary names.
 *  Any binary NOT in `present` resolves `found:false`. */
const fakeExec = (present: Set<string>, calls?: string[]): ProbeExecPort => {
  return async (argv) => {
    calls?.push(argv[0])
    return ok({ found: present.has(argv[0]) }) as Result<ProbeExecResult, ProbeExecError>
  }
}

const ALL_BINS = new Set(["node", "bun", "python3", "git", "pytest"])

describe("env-probe — happy path", () => {
  test("all core binaries present → no warnings", async () => {
    const w = await runEnvProbe(fakeExec(ALL_BINS), { enabled: true })
    expect(w).toEqual([])
  })

  test("all present + manifest with JS + python runners → still no warnings", async () => {
    const manifest: ProjectManifest = { packageJsonTestScript: "bun test", hasPyproject: true }
    const w = await runEnvProbe(fakeExec(ALL_BINS), { enabled: true, manifest })
    expect(w).toEqual([])
  })
})

describe("env-probe — missing toolchain", () => {
  test("missing python3 → exactly one info warning + hint", async () => {
    const present = new Set(["node", "bun", "git"])
    const w = await runEnvProbe(fakeExec(present), { enabled: true })
    expect(w).toHaveLength(1)
    expect(w[0]).toEqual({
      kind: "missing-toolchain",
      target: "python3",
      severity: "info",
      degradationHint: degradationHint("missing-toolchain", "python3"),
    })
    expect(w[0]?.degradationHint).toContain("python3")
  })

  test("missing core binary (git) → warn severity", async () => {
    const present = new Set(["node", "bun", "python3"])
    const w = await runEnvProbe(fakeExec(present), { enabled: true })
    expect(w).toHaveLength(1)
    expect(w[0]?.target).toBe("git")
    expect(w[0]?.severity).toBe("warn")
  })

  test("multiple missing → deterministic CORE order", async () => {
    const present = new Set<string>() // nothing present
    const w = await runEnvProbe(fakeExec(present), { enabled: true })
    // CORE order: node, bun, python3, git
    expect(w.map((x) => x.target)).toEqual(["node", "bun", "python3", "git"])
  })
})

describe("env-probe — manifest-derived test runners", () => {
  test("JS test script declared + bun missing → missing-test-runner warn", async () => {
    const present = new Set(["node", "python3", "git"]) // bun absent
    const manifest: ProjectManifest = { packageJsonTestScript: "bun test", hasPyproject: false }
    const w = await runEnvProbe(fakeExec(present), { enabled: true, manifest })
    // bun missing trips BOTH the core toolchain check AND the test-runner check
    const kinds = w.map((x) => x.kind)
    expect(kinds).toContain("missing-toolchain")
    expect(kinds).toContain("missing-test-runner")
    // ordering: core (toolchain) before derived (test-runner)
    expect(w[0]?.kind).toBe("missing-toolchain")
    expect(w[w.length - 1]?.kind).toBe("missing-test-runner")
  })

  test("no manifest → NO spurious pytest warning even when pytest absent", async () => {
    const present = new Set(["node", "bun", "python3", "git"]) // pytest absent
    const w = await runEnvProbe(fakeExec(present), { enabled: true }) // no manifest
    expect(w).toEqual([]) // pytest is not probed without a manifest
  })

  test("pyproject present + pytest absent → one missing-test-runner warn", async () => {
    const present = new Set(["node", "bun", "python3", "git"]) // pytest absent
    const manifest: ProjectManifest = { hasPyproject: true }
    const w = await runEnvProbe(fakeExec(present), { enabled: true, manifest })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: "missing-test-runner", target: "pytest" })
  })

  test("missing-test-runner warning carries the test-runner degradation hint (not the toolchain one)", async () => {
    const present = new Set(["node", "bun", "python3", "git"]) // pytest absent
    const manifest: ProjectManifest = { hasPyproject: true }
    const w = await runEnvProbe(fakeExec(present), { enabled: true, manifest })
    expect(w[0]?.degradationHint).toBe(degradationHint("missing-test-runner", "pytest"))
    // the two hint variants are genuinely distinct strings
    expect(degradationHint("missing-test-runner", "pytest")).not.toBe(
      degradationHint("missing-toolchain", "pytest"),
    )
  })
})

describe("env-probe — deriveManifest (READ not guessed, no-throw)", () => {
  test("package.json with scripts.test string → JS runner expected", () => {
    const signals: RawProjectSignals = {
      packageJson: { scripts: { test: "bun test" } },
      hasPyproject: false,
    }
    expect(deriveManifest(signals)).toEqual({
      packageJsonTestScript: "bun test",
      hasPyproject: false,
    })
  })

  test("package.json WITHOUT scripts.test → no JS runner expectation (not guessed)", () => {
    const signals: RawProjectSignals = {
      packageJson: { name: "x", scripts: { build: "tsc" } },
      hasPyproject: false,
    }
    const m = deriveManifest(signals)
    expect(m.packageJsonTestScript).toBeUndefined()
    expect(m.hasPyproject).toBe(false)
  })

  test("absent package.json → no JS runner expectation", () => {
    expect(deriveManifest({ hasPyproject: true })).toEqual({ hasPyproject: true })
  })

  test("malformed package.json shapes degrade to absent, never throw", () => {
    const cases: unknown[] = [
      null,
      "not an object",
      42,
      [],
      { scripts: "nope" }, // scripts not an object
      { scripts: null },
      { scripts: { test: 123 } }, // test not a string
      { scripts: { test: "" } }, // empty string is not a real script
      { scripts: {} }, // no test key
    ]
    for (const packageJson of cases) {
      const m = deriveManifest({ packageJson, hasPyproject: false })
      expect(m.packageJsonTestScript).toBeUndefined()
      expect(m.hasPyproject).toBe(false)
    }
  })

  test("derived manifest drives the probe end-to-end (read-not-guessed wiring)", async () => {
    const signals: RawProjectSignals = {
      packageJson: { scripts: { test: "bun test" } },
      hasPyproject: true,
    }
    const manifest = deriveManifest(signals)
    const present = new Set(["node", "bun", "python3", "git"]) // pytest absent
    const w = await runEnvProbe(fakeExec(present), { enabled: true, manifest })
    // JS runner (bun) present ⇒ no JS warning; pytest absent ⇒ one warning
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: "missing-test-runner", target: "pytest" })
  })
})

describe("env-probe — graceful degradation on exec failure", () => {
  test("exec returns Err → that check is skipped, no crash, no warning", async () => {
    // python3 detection errors; everything else present.
    const exec: ProbeExecPort = async (argv) => {
      if (argv[0] === "python3") {
        return { ok: false, error: { kind: "spawn-failed", detail: "ENOENT" } }
      }
      return ok({ found: true })
    }
    const w = await runEnvProbe(exec, { enabled: true })
    expect(w).toEqual([]) // python3 skipped (Err), others found → no warnings
  })

  test("exec REJECTS (programmer bug) → degrades to skip, never throws", async () => {
    const exec: ProbeExecPort = async (argv) => {
      if (argv[0] === "git") throw new Error("boom — bad adapter")
      return ok({ found: true })
    }
    const w = await runEnvProbe(exec, { enabled: true })
    expect(w).toEqual([]) // git check rejection swallowed → skipped
  })

  test("worst case: every check rejects → returns [] not a throw", async () => {
    const exec: ProbeExecPort = async () => {
      throw new Error("total adapter failure")
    }
    const w = await runEnvProbe(exec, { enabled: true })
    expect(w).toEqual([])
  })
})

describe("env-probe — default-OFF byte-identity", () => {
  test("enabled omitted → [] and exec NEVER called", async () => {
    const calls: string[] = []
    const w = await runEnvProbe(fakeExec(new Set(), calls), {})
    expect(w).toEqual([])
    expect(calls).toEqual([]) // port untouched
  })

  test("enabled:false → [] and exec NEVER called", async () => {
    const calls: string[] = []
    const w = await runEnvProbe(fakeExec(new Set(), calls), { enabled: false })
    expect(w).toEqual([])
    expect(calls).toEqual([])
  })

  test("no opts at all → []", async () => {
    const w = await runEnvProbe(fakeExec(new Set()))
    expect(w).toEqual([])
  })
})

describe("env-probe — abort", () => {
  test("pre-aborted signal → no checks run, []", async () => {
    const calls: string[] = []
    const ac = new AbortController()
    ac.abort()
    const w = await runEnvProbe(fakeExec(new Set(), calls), { enabled: true, signal: ac.signal })
    expect(w).toEqual([])
    expect(calls).toEqual([]) // aborted before first check
  })

  test("abort mid-way → returns warnings gathered so far, no throw", async () => {
    const ac = new AbortController()
    let n = 0
    // node absent (warn), then abort before the rest.
    const exec: ProbeExecPort = async (argv) => {
      n += 1
      if (n >= 1) ac.abort() // abort right after first check is evaluated
      return ok({ found: argv[0] !== "node" })
    }
    const w = await runEnvProbe(exec, { enabled: true, signal: ac.signal })
    // first check (node) ran and was missing → 1 warning; rest short-circuited
    expect(w).toHaveLength(1)
    expect(w[0]?.target).toBe("node")
  })
})

describe("env-probe — invariants", () => {
  test("degradationHint is total over the closed WarningKind union", () => {
    for (const kind of ALL_WARNING_KINDS as readonly WarningKind[]) {
      const hint = degradationHint(kind, "x")
      expect(typeof hint).toBe("string")
      expect(hint.length).toBeGreaterThan(0)
    }
  })

  test("CORE_CHECKS is the documented closed list (node/bun/python3/git)", () => {
    expect(CORE_CHECKS.map((c) => c.target)).toEqual(["node", "bun", "python3", "git"])
    // every core check probes with --version (side-effect-free)
    for (const c of CORE_CHECKS) expect(c.probeArgv[1]).toBe("--version")
  })

  test("NO dedupe: a binary satisfying two checks yields one warning PER check", async () => {
    // bun is BOTH a core toolchain check AND the JS test-runner check. When it
    // is absent and a JS test script is declared, both checks must fire — the
    // runner intentionally does NOT collapse them by target/binary.
    const present = new Set(["node", "python3", "git"]) // bun absent
    const manifest: ProjectManifest = { packageJsonTestScript: "bun test", hasPyproject: false }
    const w = await runEnvProbe(fakeExec(present), { enabled: true, manifest })
    const bunWarnings = w.filter((x) => x.target === "bun")
    expect(bunWarnings).toHaveLength(2)
    expect(bunWarnings.map((x) => x.kind)).toEqual(["missing-toolchain", "missing-test-runner"])
  })

  test("determinism: same inputs → identical output across runs", async () => {
    const present = new Set(["node", "git"])
    const a = await runEnvProbe(fakeExec(present), { enabled: true })
    const b = await runEnvProbe(fakeExec(present), { enabled: true })
    expect(a).toEqual(b)
  })
})
