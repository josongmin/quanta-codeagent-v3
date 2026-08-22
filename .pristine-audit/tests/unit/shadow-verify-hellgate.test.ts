/** ADR-0396 — Shadow Verify hellgate (apply-before-show in a scratch overlay).
 *
 *  The runner orchestrates THREE injected ports (scratch / applier / checker)
 *  and is NO-THROW to its caller. Every adversarial case below pins one
 *  invariant from the ADR contract:
 *
 *    HELL-SV-01: clean apply + no diagnostics ⇒ ok:true, applied:true
 *    HELL-SV-02: apply fails ⇒ ok:false, applied:false, one error diag
 *                (source = first requested check), scratch STILL disposed
 *    HELL-SV-03: lint error diagnostic ⇒ ok:false (error severity fails)
 *    HELL-SV-04: warning-only ⇒ ok:true (warnings do not fail)
 *    HELL-SV-05: info-only ⇒ ok:true (info does not fail)
 *    HELL-SV-06: checker throws ⇒ converted to error diag, NO throw to caller
 *    HELL-SV-07: applier throws ⇒ converted to error diag, applied:false, disposed
 *    HELL-SV-08: scratch.open throws ⇒ ok:false, applied:false, NO throw, NO dispose-leak
 *    HELL-SV-09: dispose throws ⇒ swallowed, result still returned (NO throw)
 *    HELL-SV-10: scratch ALWAYS disposed exactly once (dispose-count assertion)
 *                — on the happy path
 *    HELL-SV-11: scratch ALWAYS disposed exactly once even when a checker throws
 *    HELL-SV-12: multiple checks aggregated (lint + typecheck + test diags merged)
 *    HELL-SV-13: empty checks list ⇒ apply only, ok = applied, no check calls
 *    HELL-SV-14: pre-aborted signal ⇒ honored: no apply/check, applied:false
 *    HELL-SV-15: abort mid-flight (after open, before checks) ⇒ disposed, NO throw
 *    HELL-SV-16: testTarget forwarded verbatim to the "test" check only
 *    HELL-SV-17: handle forwarded verbatim to applier + every checker call
 *    HELL-SV-18: diagnostics preserve order + are returned as a flat readonly array
 *    HELL-SV-19: mixed error+warning across checks ⇒ ok:false (any error wins)
 *    HELL-SV-20: signal propagated to scratch.open / applier.apply / checker.run
 */

import { describe, expect, test } from "bun:test"
import {
  createShadowVerify,
  type ShadowApplyPort,
  type ShadowCheck,
  type ShadowCheckPort,
  type ShadowDiagnostic,
  type ShadowScratchPort,
  type ShadowVerifyRequest,
} from "@/agent/shadow-verify"

// --- fakes -----------------------------------------------------------------

interface ScratchProbe {
  port: ShadowScratchPort
  opened: number
  disposed: number
  lastHandle: string | undefined
  openSignals: Array<AbortSignal | undefined>
}

const fakeScratch = (opts?: {
  handle?: string
  openThrows?: Error
  disposeThrows?: Error
}): ScratchProbe => {
  const probe: ScratchProbe = {
    opened: 0,
    disposed: 0,
    lastHandle: undefined,
    openSignals: [],
    port: {
      async open(signal?: AbortSignal) {
        probe.opened++
        probe.openSignals.push(signal)
        if (opts?.openThrows) throw opts.openThrows
        const handle = opts?.handle ?? "scratch-1"
        probe.lastHandle = handle
        return {
          handle,
          dispose: async () => {
            probe.disposed++
            if (opts?.disposeThrows) throw opts.disposeThrows
          },
        }
      },
    },
  }
  return probe
}

interface ApplyProbe {
  port: ShadowApplyPort
  calls: Array<{ handle: string; patch: string; signal: AbortSignal | undefined }>
}

const fakeApplier = (opts?: { ok?: boolean; error?: string; throws?: Error }): ApplyProbe => {
  const probe: ApplyProbe = {
    calls: [],
    port: {
      async apply(handle: string, patch: string, signal?: AbortSignal) {
        probe.calls.push({ handle, patch, signal })
        if (opts?.throws) throw opts.throws
        return opts?.error === undefined
          ? { ok: opts?.ok ?? true }
          : { ok: opts?.ok ?? true, error: opts.error }
      },
    },
  }
  return probe
}

interface CheckProbe {
  port: ShadowCheckPort
  calls: Array<{ handle: string; check: ShadowCheck; testTarget: string | undefined }>
}

const fakeChecker = (
  byCheck: Partial<Record<ShadowCheck, readonly ShadowDiagnostic[] | Error>>,
): CheckProbe => {
  const probe: CheckProbe = {
    calls: [],
    port: {
      async run(
        handle: string,
        check: ShadowCheck,
        testTarget: string | undefined,
        _signal?: AbortSignal,
      ) {
        probe.calls.push({ handle, check, testTarget })
        const out = byCheck[check]
        if (out instanceof Error) throw out
        return out ?? []
      },
    },
  }
  return probe
}

const diag = (over: Partial<ShadowDiagnostic> & { source: ShadowCheck }): ShadowDiagnostic => ({
  file: "a.ts",
  line: 1,
  severity: "error",
  message: "boom",
  ...over,
})

const req = (over?: Partial<ShadowVerifyRequest>): ShadowVerifyRequest => ({
  patch: "*** Begin Patch\n*** End Patch\n",
  checks: ["lint"],
  ...over,
})

// --- HELL-SV-01 ------------------------------------------------------------

describe("ShadowVerify — happy path (HELL-SV-01)", () => {
  test("clean apply + no diagnostics ⇒ ok:true, applied:true, no diags", async () => {
    const scratch = fakeScratch()
    const applier = fakeApplier({ ok: true })
    const checker = fakeChecker({ lint: [] })
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: applier.port,
      checker: checker.port,
    })

    const r = await sv.verify(req({ checks: ["lint"] }))

    expect(r.ok).toBe(true)
    expect(r.applied).toBe(true)
    expect(r.diagnostics).toEqual([])
    expect(scratch.disposed).toBe(1)
  })
})

// --- HELL-SV-02 ------------------------------------------------------------

describe("ShadowVerify — apply failure (HELL-SV-02)", () => {
  test("apply fails ⇒ ok:false, applied:false, error diag with first-check source, disposed", async () => {
    const scratch = fakeScratch()
    const applier = fakeApplier({ ok: false, error: "hunk #2 failed" })
    const checker = fakeChecker({})
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: applier.port,
      checker: checker.port,
    })

    const r = await sv.verify(req({ checks: ["typecheck", "lint"] }))

    expect(r.applied).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]?.severity).toBe("error")
    expect(r.diagnostics[0]?.source).toBe("typecheck") // first requested check
    expect(r.diagnostics[0]?.message).toContain("hunk #2 failed")
    expect(checker.calls).toHaveLength(0) // no checks run when apply fails
    expect(scratch.disposed).toBe(1) // still disposed
  })

  test("apply fails with empty checks ⇒ source defaults to lint", async () => {
    const scratch = fakeScratch()
    const applier = fakeApplier({ ok: false, error: "no such file" })
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: applier.port,
      checker: fakeChecker({}).port,
    })

    const r = await sv.verify(req({ checks: [] }))
    expect(r.applied).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]?.source).toBe("lint")
    expect(scratch.disposed).toBe(1)
  })
})

// --- HELL-SV-03 / 04 / 05 --------------------------------------------------

describe("ShadowVerify — severity gating (HELL-SV-03/04/05)", () => {
  test("lint error ⇒ ok:false", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: [diag({ source: "lint", severity: "error" })] }).port,
    })
    const r = await sv.verify(req({ checks: ["lint"] }))
    expect(r.applied).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(scratch.disposed).toBe(1)
  })

  test("warning-only ⇒ ok:true (warnings don't fail)", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: [diag({ source: "lint", severity: "warning" })] }).port,
    })
    const r = await sv.verify(req({ checks: ["lint"] }))
    expect(r.applied).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toHaveLength(1) // still surfaced
  })

  test("info-only ⇒ ok:true", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: [diag({ source: "lint", severity: "info" })] }).port,
    })
    const r = await sv.verify(req({ checks: ["lint"] }))
    expect(r.ok).toBe(true)
  })
})

// --- HELL-SV-06 ------------------------------------------------------------

describe("ShadowVerify — checker throws (HELL-SV-06)", () => {
  test("checker throw ⇒ converted to error diag, NO throw to caller", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ test: new Error("tsserver crashed") }).port,
    })

    const r = await sv.verify(req({ checks: ["test"] }))
    expect(r.applied).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]?.severity).toBe("error")
    expect(r.diagnostics[0]?.source).toBe("test")
    expect(r.diagnostics[0]?.message).toContain("tsserver crashed")
    expect(scratch.disposed).toBe(1)
  })

  test("one checker throws, another returns clean ⇒ only the throw becomes an error diag", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: [], typecheck: new Error("oom") }).port,
    })
    const r = await sv.verify(req({ checks: ["lint", "typecheck"] }))
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]?.source).toBe("typecheck")
  })
})

// --- HELL-SV-07 ------------------------------------------------------------

describe("ShadowVerify — applier throws (HELL-SV-07)", () => {
  test("applier throw ⇒ error diag, applied:false, disposed, NO throw", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ throws: new Error("patch engine panic") }).port,
      checker: fakeChecker({}).port,
    })

    const r = await sv.verify(req({ checks: ["lint"] }))
    expect(r.applied).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]?.severity).toBe("error")
    expect(r.diagnostics[0]?.message).toContain("patch engine panic")
    expect(scratch.disposed).toBe(1)
  })
})

// --- HELL-SV-08 ------------------------------------------------------------

describe("ShadowVerify — scratch.open throws (HELL-SV-08)", () => {
  test("open throw ⇒ ok:false, applied:false, error diag, NO dispose (never opened)", async () => {
    const scratch = fakeScratch({ openThrows: new Error("disk full") })
    const applier = fakeApplier({ ok: true })
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: applier.port,
      checker: fakeChecker({}).port,
    })

    const r = await sv.verify(req({ checks: ["lint"] }))
    expect(r.applied).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]?.message).toContain("disk full")
    expect(applier.calls).toHaveLength(0)
    expect(scratch.disposed).toBe(0) // nothing to dispose — open failed
  })
})

// --- HELL-SV-09 ------------------------------------------------------------

describe("ShadowVerify — dispose throws (HELL-SV-09)", () => {
  test("dispose throw is swallowed; result still returned", async () => {
    const scratch = fakeScratch({ disposeThrows: new Error("rmdir EBUSY") })
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: [] }).port,
    })

    const r = await sv.verify(req({ checks: ["lint"] }))
    expect(r.ok).toBe(true)
    expect(r.applied).toBe(true)
    expect(scratch.disposed).toBe(1) // dispose was attempted
  })
})

// --- HELL-SV-10 / 11 -------------------------------------------------------

describe("ShadowVerify — dispose-count no-leak (HELL-SV-10/11)", () => {
  test("disposed exactly once on happy path", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: [], typecheck: [], test: [] }).port,
    })
    await sv.verify(req({ checks: ["lint", "typecheck", "test"] }))
    expect(scratch.disposed).toBe(1)
    expect(scratch.opened).toBe(1)
  })

  test("disposed exactly once when a checker throws", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({ lint: new Error("x") }).port,
    })
    await sv.verify(req({ checks: ["lint"] }))
    expect(scratch.disposed).toBe(1)
  })
})

// --- HELL-SV-12 ------------------------------------------------------------

describe("ShadowVerify — aggregation (HELL-SV-12)", () => {
  test("multiple checks ⇒ diagnostics merged in check order", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({
        lint: [diag({ source: "lint", severity: "warning", file: "l.ts" })],
        typecheck: [diag({ source: "typecheck", severity: "error", file: "t.ts" })],
        test: [diag({ source: "test", severity: "info", file: "x.ts" })],
      }).port,
    })

    const r = await sv.verify(req({ checks: ["lint", "typecheck", "test"] }))
    expect(r.ok).toBe(false) // typecheck error wins
    expect(r.diagnostics).toHaveLength(3)
    expect(r.diagnostics.map((d) => d.source)).toEqual(["lint", "typecheck", "test"])
    expect(r.diagnostics.map((d) => d.file)).toEqual(["l.ts", "t.ts", "x.ts"])
  })
})

// --- HELL-SV-13 ------------------------------------------------------------

describe("ShadowVerify — empty checks (HELL-SV-13)", () => {
  test("no checks ⇒ apply only, ok = applied, no checker calls", async () => {
    const scratch = fakeScratch()
    const checker = fakeChecker({})
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: checker.port,
    })

    const r = await sv.verify(req({ checks: [] }))
    expect(r.applied).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toEqual([])
    expect(checker.calls).toHaveLength(0)
    expect(scratch.disposed).toBe(1)
  })
})

// --- HELL-SV-14 / 15 -------------------------------------------------------

describe("ShadowVerify — abort (HELL-SV-14/15)", () => {
  test("pre-aborted signal ⇒ applied:false, NO apply/check, NO throw", async () => {
    const scratch = fakeScratch()
    const applier = fakeApplier({ ok: true })
    const checker = fakeChecker({})
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: applier.port,
      checker: checker.port,
    })

    const ac = new AbortController()
    ac.abort()
    const r = await sv.verify(req({ checks: ["lint"] }), ac.signal)

    expect(r.applied).toBe(false)
    expect(r.ok).toBe(false)
    expect(applier.calls).toHaveLength(0)
    expect(checker.calls).toHaveLength(0)
  })

  test("abort after open, before checks ⇒ disposed, NO throw", async () => {
    const scratch = fakeScratch()
    const ac = new AbortController()
    // applier aborts the controller mid-flight, then reports a clean apply
    const applier: ShadowApplyPort = {
      async apply() {
        ac.abort()
        return { ok: true }
      },
    }
    const checker = fakeChecker({ lint: [] })
    const sv = createShadowVerify({ scratch: scratch.port, applier, checker: checker.port })

    const r = await sv.verify(req({ checks: ["lint"] }), ac.signal)
    expect(checker.calls).toHaveLength(0) // aborted before checks
    expect(scratch.disposed).toBe(1)
    expect(r.applied).toBe(true)
  })
})

// --- HELL-SV-16 ------------------------------------------------------------

describe("ShadowVerify — testTarget forwarding (HELL-SV-16)", () => {
  test("testTarget forwarded only to the 'test' check; undefined for others", async () => {
    const scratch = fakeScratch()
    const checker = fakeChecker({ lint: [], typecheck: [], test: [] })
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: checker.port,
    })

    await sv.verify(req({ checks: ["lint", "typecheck", "test"], testTarget: "tests/foo.test.ts" }))

    const lintCall = checker.calls.find((c) => c.check === "lint")
    const tcCall = checker.calls.find((c) => c.check === "typecheck")
    const testCall = checker.calls.find((c) => c.check === "test")
    expect(lintCall?.testTarget).toBeUndefined()
    expect(tcCall?.testTarget).toBeUndefined()
    expect(testCall?.testTarget).toBe("tests/foo.test.ts")
  })
})

// --- HELL-SV-17 ------------------------------------------------------------

describe("ShadowVerify — handle forwarding (HELL-SV-17)", () => {
  test("scratch handle forwarded verbatim to applier and every checker call", async () => {
    const scratch = fakeScratch({ handle: "OVERLAY-XYZ" })
    const applier = fakeApplier({ ok: true })
    const checker = fakeChecker({ lint: [], typecheck: [] })
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: applier.port,
      checker: checker.port,
    })

    await sv.verify(req({ checks: ["lint", "typecheck"] }))

    expect(applier.calls[0]?.handle).toBe("OVERLAY-XYZ")
    expect(checker.calls.every((c) => c.handle === "OVERLAY-XYZ")).toBe(true)
    expect(applier.calls[0]?.patch).toBe(req().patch)
  })
})

// --- HELL-SV-18 ------------------------------------------------------------

describe("ShadowVerify — flat readonly array (HELL-SV-18)", () => {
  test("diagnostics returned as a flat array preserving per-check insertion order", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({
        lint: [
          diag({ source: "lint", line: 1, message: "L1" }),
          diag({ source: "lint", line: 2, message: "L2" }),
        ],
        typecheck: [diag({ source: "typecheck", line: 9, message: "T1" })],
      }).port,
    })
    const r = await sv.verify(req({ checks: ["lint", "typecheck"] }))
    expect(r.diagnostics.map((d) => d.message)).toEqual(["L1", "L2", "T1"])
    expect(Array.isArray(r.diagnostics)).toBe(true)
  })
})

// --- HELL-SV-19 ------------------------------------------------------------

describe("ShadowVerify — any error wins (HELL-SV-19)", () => {
  test("mixed error+warning across checks ⇒ ok:false", async () => {
    const scratch = fakeScratch()
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: fakeApplier({ ok: true }).port,
      checker: fakeChecker({
        lint: [diag({ source: "lint", severity: "warning" })],
        test: [diag({ source: "test", severity: "error" })],
      }).port,
    })
    const r = await sv.verify(req({ checks: ["lint", "test"] }))
    expect(r.ok).toBe(false)
  })
})

// --- HELL-SV-20 ------------------------------------------------------------

describe("ShadowVerify — signal propagation (HELL-SV-20)", () => {
  test("the caller's signal is threaded to open / apply / run", async () => {
    const scratch = fakeScratch()
    const applier = fakeApplier({ ok: true })
    const checker = fakeChecker({ lint: [] })
    // capture the signal that run() receives
    let runSignal: AbortSignal | undefined
    const capturingChecker: ShadowCheckPort = {
      async run(handle, check, testTarget, signal) {
        runSignal = signal
        return checker.port.run(handle, check, testTarget, signal)
      },
    }
    let applySignal: AbortSignal | undefined
    const capturingApplier: ShadowApplyPort = {
      async apply(handle, patch, signal) {
        applySignal = signal
        return applier.port.apply(handle, patch, signal)
      },
    }
    const sv = createShadowVerify({
      scratch: scratch.port,
      applier: capturingApplier,
      checker: capturingChecker,
    })

    const ac = new AbortController()
    await sv.verify(req({ checks: ["lint"] }), ac.signal)
    expect(scratch.openSignals[0]).toBe(ac.signal)
    expect(applySignal).toBe(ac.signal)
    expect(runSignal).toBe(ac.signal)
  })
})
