/**
 * ADR-0472 hellgate — edit-repair-loop (deterministic, no network, no I/O).
 *
 * Seals (1) the pure lint-delta computer (introduced = post − pre as a count
 * multiset, identity excludes column/severity, pre-existing debt never blamed),
 * (2) the default-OFF gate (strict `=== "1"`), and (3) the bounded repair loop
 * over INJECTED ports — green / repair-to-green / exhausted / model-declined /
 * check-error / abort-mid-loop / invalid-config / gate-off no-op.
 *
 * All collaborators are FAKES (spies). NO arbitrary thresholds — `maxIters` is
 * the only bound and it is the REQUIRED config field under test.
 *
 * Axes:
 *   A. LINT-DELTA — multiset diff, identity tuple, render.
 *   B. GATE — strict opt-in, off ⇒ false; off path is the caller's no-op.
 *   C. LOOP — already-green / repair-to-green / exhausted / declined /
 *      check-error / abort / invalid-config + audit trail + signal threading.
 */

import { describe, expect, test } from "bun:test"
import {
  computeLintDelta,
  type Diagnostic,
  type DiagnosticsProvider,
  diagnosticKey,
  EDIT_REPAIR_LOOP_ENV,
  editRepairLoopEnabled,
  type RepairAttempt,
  type RepairCheck,
  type RepairFailure,
  type RepairLoopConfig,
  type RepairReactorPort,
  renderLintDelta,
  runRepairLoop,
} from "@/agent/edit-repair-loop"
import { err, ok } from "@/shared"

// ─── builders ───────────────────────────────────────────────────────────────

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "src/a.ts",
  line: 10,
  code: "TS2322",
  message: "Type mismatch",
  severity: "error",
  ...over,
})

const lintFailure = (diags: readonly Diagnostic[]): RepairFailure => ({
  check: "lints",
  diagnostics: diags,
  output: "",
})

const cmdFailure = (output: string, exitCode: number): RepairFailure => ({
  check: "command",
  diagnostics: [],
  output,
  exitCode,
})

const baseCfg = (over: Partial<RepairLoopConfig> = {}): RepairLoopConfig => ({
  file: "src/a.ts",
  checkKind: "lints",
  maxIters: 3,
  ...over,
})

/** A check that yields a queued sequence of results, one per call. */
const queuedCheck = (
  seq: ReadonlyArray<RepairFailure | null>,
): { check: RepairCheck; calls: () => number } => {
  let i = 0
  const check: RepairCheck = async () => {
    const v = i < seq.length ? seq[i] : null
    i++
    return ok(v ?? null)
  }
  return { check, calls: () => i }
}

/** A reactor that always claims it applied an edit, recording each request. */
const appliesReactor = (): {
  reactor: RepairReactorPort
  reqs: () => number
} => {
  let n = 0
  const reactor: RepairReactorPort = async () => {
    n++
    return { applied: true, rationale: `repair #${n}` } satisfies RepairAttempt
  }
  return { reactor, reqs: () => n }
}

// ─── A. LINT-DELTA ──────────────────────────────────────────────────────────

describe("A. lint-delta (pure)", () => {
  test("introduced = post − pre", () => {
    const pre = [diag({ line: 1, code: "A" })]
    const post = [diag({ line: 1, code: "A" }), diag({ line: 5, code: "B" })]
    const out = computeLintDelta(pre, post)
    expect(out).toHaveLength(1)
    expect(out[0]?.code).toBe("B")
  })

  test("pre-existing debt is NEVER reported", () => {
    const pre = [diag({ code: "X" }), diag({ code: "Y", line: 20 })]
    const post = [diag({ code: "X" }), diag({ code: "Y", line: 20 })]
    expect(computeLintDelta(pre, post)).toHaveLength(0)
  })

  test("a pre-existing lint that merely shifts COLUMN is not introduced", () => {
    const pre = [diag({ column: 4 })]
    const post = [diag({ column: 9 })]
    expect(computeLintDelta(pre, post)).toHaveLength(0)
  })

  test("severity is not part of identity", () => {
    const pre = [diag({ severity: "warning" })]
    const post = [diag({ severity: "error" })]
    expect(computeLintDelta(pre, post)).toHaveLength(0)
  })

  test("multiset multiplicity: 1 → 2 reports exactly 1 net-new", () => {
    const pre = [diag()]
    const post = [diag(), diag()]
    expect(computeLintDelta(pre, post)).toHaveLength(1)
  })

  test("empty pre ⇒ all post are introduced; empty post ⇒ none", () => {
    expect(computeLintDelta([], [diag(), diag({ line: 2 })])).toHaveLength(2)
    expect(computeLintDelta([diag()], [])).toHaveLength(0)
  })

  test("diagnosticKey excludes column & severity; distinct tuples differ", () => {
    expect(diagnosticKey(diag({ column: 1 }))).toBe(diagnosticKey(diag({ column: 99 })))
    expect(diagnosticKey(diag({ severity: "info" }))).toBe(diagnosticKey(diag()))
    expect(diagnosticKey(diag({ line: 1 }))).not.toBe(diagnosticKey(diag({ line: 2 })))
  })

  test("render: empty ⇒ positive line; nonempty ⇒ count + rows", () => {
    expect(renderLintDelta([])).toContain("no new diagnostics")
    const r = renderLintDelta([diag({ line: 7, column: 3 })])
    expect(r).toContain("1 new diagnostic")
    expect(r).toContain("src/a.ts:7:3")
    expect(r).toContain("TS2322")
  })
})

// ─── B. GATE ────────────────────────────────────────────────────────────────

describe("B. gate (default-OFF)", () => {
  test("unset ⇒ OFF", () => {
    expect(editRepairLoopEnabled({})).toBe(false)
  })

  test('only exactly "1" opts in', () => {
    expect(editRepairLoopEnabled({ [EDIT_REPAIR_LOOP_ENV]: "1" })).toBe(true)
    for (const v of ["0", "true", "on", "yes", " 1", "1 ", ""]) {
      expect(editRepairLoopEnabled({ [EDIT_REPAIR_LOOP_ENV]: v })).toBe(false)
    }
  })
})

// ─── C. LOOP ────────────────────────────────────────────────────────────────

describe("C. repair loop", () => {
  test("already green ⇒ green, 0 attempts, reactor never called", async () => {
    const { check, calls } = queuedCheck([null])
    const { reactor, reqs } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.green).toBe(true)
    expect(r.stop.kind).toBe("green")
    expect(r.attempts).toBe(0)
    expect(reqs()).toBe(0)
    expect(calls()).toBe(1)
  })

  test("fail then green ⇒ repairs to green in 1 attempt", async () => {
    const { check } = queuedCheck([lintFailure([diag()]), null])
    const { reactor, reqs } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.green).toBe(true)
    expect(r.attempts).toBe(1)
    expect(reqs()).toBe(1)
    expect(r.iterations[0]?.iteration).toBe(0)
    expect(r.iterations[0]?.failure.diagnostics).toHaveLength(1)
  })

  test("maxIters exhausted ⇒ give-up + structured report", async () => {
    // Always failing check, reactor always applies but never fixes.
    const check: RepairCheck = async () => ok(lintFailure([diag()]))
    const { reactor, reqs } = appliesReactor()
    const r = await runRepairLoop(baseCfg({ maxIters: 2 }), { check, reactor })
    expect(r.green).toBe(false)
    expect(r.stop.kind).toBe("exhausted")
    expect(r.attempts).toBe(2)
    expect(reqs()).toBe(2)
    expect(r.iterations).toHaveLength(2)
  })

  test("model declines ⇒ model-declined give-up, loop stops immediately", async () => {
    const check: RepairCheck = async () => ok(lintFailure([diag()]))
    const reactor: RepairReactorPort = async () => ({ applied: false, rationale: "no fix" })
    const r = await runRepairLoop(baseCfg({ maxIters: 5 }), { check, reactor })
    expect(r.green).toBe(false)
    expect(r.stop.kind).toBe("model-declined")
    expect(r.attempts).toBe(1)
  })

  test("tests check variant: failing output fed back, then green", async () => {
    const { check } = queuedCheck([cmdFailure("FAIL test_x at x.ts:3", 1), null])
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg({ checkKind: "tests" }), { check, reactor })
    expect(r.green).toBe(true)
    expect(r.iterations[0]?.failure.output).toContain("FAIL")
  })

  test("command check variant: exit code carried", async () => {
    const { check } = queuedCheck([cmdFailure("err", 2), null])
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg({ checkKind: "command" }), { check, reactor })
    expect(r.green).toBe(true)
    expect(r.iterations[0]?.failure.exitCode).toBe(2)
  })

  test("check port returns err ⇒ check-error give-up", async () => {
    const check: RepairCheck = async () => err("checker crashed")
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.green).toBe(false)
    expect(r.stop).toEqual({ kind: "check-error", error: "checker crashed" })
  })

  test("check port THROWS ⇒ caught, check-error (NO-THROW)", async () => {
    const check: RepairCheck = async () => {
      throw new Error("boom")
    }
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.stop.kind).toBe("check-error")
    if (r.stop.kind === "check-error") expect(r.stop.error).toContain("boom")
  })

  test("reactor THROWS ⇒ caught as model-declined (NO-THROW)", async () => {
    const check: RepairCheck = async () => ok(lintFailure([diag()]))
    const reactor: RepairReactorPort = async () => {
      throw new Error("model exploded")
    }
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.stop.kind).toBe("model-declined")
    expect(r.iterations[0]?.attempt.rationale).toContain("model exploded")
  })

  test("abort BEFORE loop ⇒ aborted, no port calls", async () => {
    const ac = new AbortController()
    ac.abort()
    let touched = false
    const check: RepairCheck = async () => {
      touched = true
      return ok(null)
    }
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor }, ac.signal)
    expect(r.stop.kind).toBe("aborted")
    expect(touched).toBe(false)
  })

  test("abort MID-loop (after first failing check) ⇒ aborted", async () => {
    const ac = new AbortController()
    const check: RepairCheck = async () => {
      ac.abort()
      return ok(lintFailure([diag()]))
    }
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor }, ac.signal)
    expect(r.stop.kind).toBe("aborted")
  })

  test("invalid maxIters (< 1 / non-int) ⇒ invalid-config, no port calls", async () => {
    let touched = false
    const check: RepairCheck = async () => {
      touched = true
      return ok(null)
    }
    const { reactor } = appliesReactor()
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = await runRepairLoop(baseCfg({ maxIters: bad }), { check, reactor })
      expect(r.stop.kind).toBe("invalid-config")
      expect(r.green).toBe(false)
    }
    expect(touched).toBe(false)
  })

  test("report shape: file + checkKind echoed, attempts == iterations.length", async () => {
    const check: RepairCheck = async () => ok(lintFailure([diag()]))
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg({ file: "src/z.ts", maxIters: 3 }), { check, reactor })
    expect(r.file).toBe("src/z.ts")
    expect(r.checkKind).toBe("lints")
    expect(r.attempts).toBe(r.iterations.length)
  })
})

// ─── C2. DiagnosticsProvider → computeLintDelta → RepairCheck composition ────
// Proves the load-bearing integration path (ADR-0472 TODO #3): the host adapts a
// DiagnosticsProvider into a `lints` RepairCheck by diffing pre/post and reporting
// ONLY introduced diagnostics. Pre-existing debt must never drive a repair.

describe("C2. diagnostics-provider composition (lints adapter)", () => {
  // Build a `lints` RepairCheck the way the composition root would: snapshot
  // pre-edit diagnostics once, then on each check re-run the provider and report
  // a failure only when the edit INTRODUCED diagnostics (delta non-empty).
  const lintCheckFromProvider = (
    file: string,
    provider: DiagnosticsProvider,
    preDiags: readonly Diagnostic[],
  ): RepairCheck => {
    return async (signal) => {
      const post = await provider({ file }, signal)
      if (!post.ok) return err(post.error)
      const introduced = computeLintDelta(preDiags, post.value)
      if (introduced.length === 0) return ok(null)
      return ok({ check: "lints", diagnostics: introduced, output: "" } satisfies RepairFailure)
    }
  }

  test("pre-existing debt present in post ⇒ check is green (delta empty)", async () => {
    const pre = [diag({ code: "PRE", line: 1 })]
    const provider: DiagnosticsProvider = async () => ok([diag({ code: "PRE", line: 1 })])
    const check = lintCheckFromProvider("src/a.ts", provider, pre)
    const { reactor, reqs } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.green).toBe(true)
    expect(r.attempts).toBe(0)
    expect(reqs()).toBe(0)
  })

  test("edit introduced a NEW lint ⇒ failure carries only the introduced diag, repaired to green", async () => {
    const pre = [diag({ code: "PRE", line: 1 })]
    // First check: post has PRE + a new INTRODUCED lint. After the repair the
    // provider returns only PRE again ⇒ delta empty ⇒ green.
    let pass = 0
    const provider: DiagnosticsProvider = async () => {
      pass++
      return pass === 1
        ? ok([diag({ code: "PRE", line: 1 }), diag({ code: "NEW", line: 9 })])
        : ok([diag({ code: "PRE", line: 1 })])
    }
    const check = lintCheckFromProvider("src/a.ts", provider, pre)
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.green).toBe(true)
    expect(r.attempts).toBe(1)
    const introduced = r.iterations[0]?.failure.diagnostics ?? []
    expect(introduced).toHaveLength(1)
    expect(introduced[0]?.code).toBe("NEW")
  })

  test("provider err ⇒ check-error give-up (NO-THROW)", async () => {
    const provider: DiagnosticsProvider = async () => err("lsp down")
    const check = lintCheckFromProvider("src/a.ts", provider, [])
    const { reactor } = appliesReactor()
    const r = await runRepairLoop(baseCfg(), { check, reactor })
    expect(r.stop).toEqual({ kind: "check-error", error: "lsp down" })
  })
})

// ─── D. GATE-OFF NO-OP (caller contract) ────────────────────────────────────

describe("D. gate-off is the caller's no-op", () => {
  test("when gate is OFF the caller never constructs the loop", async () => {
    // Simulates the integration site: if the gate is off, the ports are never
    // referenced — proving byte-identical-to-today on the OFF path.
    const env = {} // gate unset
    let portUsed = false
    const check: RepairCheck = async () => {
      portUsed = true
      return ok(null)
    }
    const { reactor } = appliesReactor()
    if (editRepairLoopEnabled(env)) {
      await runRepairLoop(baseCfg(), { check, reactor })
    }
    expect(portUsed).toBe(false)
  })
})
