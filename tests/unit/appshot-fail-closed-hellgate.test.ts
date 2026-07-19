/**
 * Hellgate — appshot verify-loop FAIL-CLOSED contract (DOF-40, G1).
 *
 * The loop must NEVER claim a passing verdict without a REAL judge result, and
 * must return a TYPED refusal (never a fabricated pass, never a crash, never an
 * unbounded run) when the BrowserPort or judge is structurally unavailable.
 *
 * RED (pre-hardening, captured):
 *   - a stub `verify` returning a plain `{ pass: true }` literal produced
 *     `outcome: "pass"` — the loop trusted ANY object shaped like a verdict.
 *   - an unavailable arrow (`verify: undefined`) crashed into a `verify_failed`
 *     whose message was `"deps.port.verify is not a function…"` — fail-closed by
 *     ACCIDENT (caught crash), not by a typed contract, and indistinguishable
 *     from a genuine runtime judge failure.
 *
 * Seals here:
 *   P1. a FABRICATED (unbranded) pass ⇒ `refused` / `unverified_pass`, NOT `pass`
 *   P2. a REAL-judge (branded) pass ⇒ `pass` (paired control — proves P1 refuses
 *       ONLY the unbranded case, not every pass)
 *   P3. the brand can NOT be forged by a hand-rolled object with a look-alike key
 *   U1. availability judge:false ⇒ `refused` / `judge_unavailable`, NO effects
 *   U2. availability browser:false ⇒ `refused` / `browser_unavailable`, NO effects
 *   U3. a THROWING availability probe ⇒ `refused` / `judge_unavailable` (fail-closed)
 *   U4. no `availability()` ⇒ fully-wired assumed (backward-compatible)
 *   B1. min floor — a request of 0 still runs exactly APPSHOT_MIN_ITER
 *   B2. max ceiling — a never-pass real judge runs EXACTLY APPSHOT_MAX_ITER
 *   R1. tool surface: a fabricated pass ⇒ ok:false rejected (model can't read it
 *       as a success)
 */

import { describe, expect, test } from "bun:test"
import {
  APPSHOT_MAX_ITER,
  APPSHOT_MIN_ITER,
  type AppSpec,
  type AppshotAvailability,
  type AppshotPort,
  appshotVerifyTool,
  isRealJudgePass,
  judgeVerdict,
  runAppshotLoop,
  type ScaffoldResult,
  type Tool,
  type ToolContext,
  type ToolEvent,
  type ToolResult,
  type VerifyVerdict,
} from "@/tool"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const clock = (): (() => number) => {
  let t = 0
  return () => (t += 1)
}

interface PortOpts {
  readonly verdict?: VerifyVerdict
  readonly availability?: () => AppshotAvailability
  readonly verifyMissing?: boolean
}

/** A port whose arrows all succeed; `verify` returns the given verdict (defaults
 *  to a REAL-judge pass). Records effect counts so a refusal can prove NO effect
 *  ran. `availability` / `verifyMissing` model the unavailable paths. */
class Port implements AppshotPort {
  scaffolds = 0
  renders = 0
  screenshots = 0
  verifies = 0
  constructor(private readonly opts: PortOpts = {}) {
    if (opts.verifyMissing === true) {
      ;(this as { verify?: unknown }).verify = undefined
    }
  }
  availability(): AppshotAvailability {
    // Default: fully wired. Overridden per-test via opts.
    return this.opts.availability?.() ?? { browser: true, judge: true }
  }
  async scaffold(_s: AppSpec, outDir: string): Promise<ScaffoldResult> {
    this.scaffolds++
    return {
      entryUrl: `file://${outDir}/i.html`,
      entryPath: `${outDir}/i.html`,
      mediaType: "text/html",
    }
  }
  async render(): Promise<void> {
    this.renders++
  }
  async screenshot(): Promise<Uint8Array> {
    this.screenshots++
    return PNG
  }
  async verify(): Promise<VerifyVerdict> {
    this.verifies++
    return this.opts.verdict ?? judgeVerdict(true, "real pass")
  }
}

/** A port WITHOUT an availability() method (backward-compat probe). */
class NoAvailPort implements AppshotPort {
  verifies = 0
  constructor(private readonly verdict: VerifyVerdict = judgeVerdict(true, "ok")) {}
  async scaffold(_s: AppSpec, outDir: string): Promise<ScaffoldResult> {
    return {
      entryUrl: `file://${outDir}/i.html`,
      entryPath: `${outDir}/i.html`,
      mediaType: "text/html",
    }
  }
  async render(): Promise<void> {}
  async screenshot(): Promise<Uint8Array> {
    return PNG
  }
  async verify(): Promise<VerifyVerdict> {
    this.verifies++
    return this.verdict
  }
}

const REQ = { prompt: "x", outDir: "/jail/app", maxIter: 3 } as const

/* ------------------------------------------------------------------ */
/* P — a pass REQUIRES a real judge result                            */
/* ------------------------------------------------------------------ */

describe("appshot fail-closed — P. a pass requires a REAL judge", () => {
  test("P1. a FABRICATED (unbranded) pass is REFUSED, never claimed as pass", async () => {
    // The exact RED: a stub judge returns a plain literal `{ pass:true }`.
    const fabricated: VerifyVerdict = { pass: true, notes: "looks great (fabricated)" }
    const port = new Port({ verdict: fabricated })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("refused")
    expect(r.error?.kind).toBe("unverified_pass")
    // The fabricated notes still surface, but the outcome is NOT a pass.
    expect(r.outcome).not.toBe("pass")
  })

  test("P2. a REAL-judge (branded) pass IS honored (paired control)", async () => {
    const port = new Port({ verdict: judgeVerdict(true, "genuine") })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("pass")
    expect(r.lastVerdict?.notes).toBe("genuine")
  })

  test("P3. the brand can NOT be forged by a hand-rolled look-alike object", async () => {
    // An attacker cannot know the module-private symbol; any string/own key they
    // add is not the brand, so isRealJudgePass stays false.
    const forged = {
      pass: true,
      notes: "forged",
      realJudgeVerdict: true,
    } as unknown as VerifyVerdict
    expect(isRealJudgePass(forged)).toBe(false)
    const port = new Port({ verdict: forged })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("refused")
    expect(r.error?.kind).toBe("unverified_pass")
  })

  test("P0 (control) isRealJudgePass: branded pass true, unbranded pass false, branded fail false", () => {
    expect(isRealJudgePass(judgeVerdict(true, "y"))).toBe(true)
    expect(isRealJudgePass({ pass: true, notes: "y" })).toBe(false)
    expect(isRealJudgePass(judgeVerdict(false, "y"))).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* U — unavailable BrowserPort / judge ⇒ typed refusal                */
/* ------------------------------------------------------------------ */

describe("appshot fail-closed — U. unavailable arrows ⇒ typed refusal", () => {
  test("U1. judge unavailable ⇒ refused/judge_unavailable, NO effects run", async () => {
    const port = new Port({ availability: () => ({ browser: true, judge: false }) })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("refused")
    expect(r.error?.kind).toBe("judge_unavailable")
    // Fail-closed BEFORE any effect — nothing was scaffolded/rendered/judged.
    expect(port.scaffolds).toBe(0)
    expect(port.renders).toBe(0)
    expect(port.verifies).toBe(0)
  })

  test("U2. browser unavailable ⇒ refused/browser_unavailable, NO effects run", async () => {
    const port = new Port({ availability: () => ({ browser: false, judge: true }) })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("refused")
    expect(r.error?.kind).toBe("browser_unavailable")
    expect(port.scaffolds).toBe(0)
  })

  test("U3. a THROWING availability probe ⇒ refused/judge_unavailable (fail-closed)", async () => {
    const port = new Port({
      availability: () => {
        throw new Error("probe blew up")
      },
    })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("refused")
    expect(r.error?.kind).toBe("judge_unavailable")
    expect(port.scaffolds).toBe(0)
  })

  test("U4. NO availability() method ⇒ fully-wired assumed (backward-compatible)", async () => {
    const port = new NoAvailPort(judgeVerdict(true, "ok"))
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.outcome).toBe("pass")
    expect(port.verifies).toBe(1)
  })

  test("U5. judge-first: BOTH unavailable ⇒ judge_unavailable (no pass ever possible)", async () => {
    const port = new Port({ availability: () => ({ browser: false, judge: false }) })
    const r = await runAppshotLoop({ port, now: clock() }, REQ)
    expect(r.error?.kind).toBe("judge_unavailable")
  })
})

/* ------------------------------------------------------------------ */
/* B — bounds (min floor, max ceiling) with a REAL judge              */
/* ------------------------------------------------------------------ */

describe("appshot fail-closed — B. bounds enforced", () => {
  test("B1. min floor: maxIter 0 still runs exactly APPSHOT_MIN_ITER", async () => {
    const port = new Port({ verdict: judgeVerdict(true, "ok") })
    const r = await runAppshotLoop({ port, now: clock() }, { ...REQ, maxIter: 0 })
    expect(r.iterations.length).toBe(APPSHOT_MIN_ITER)
    expect(port.verifies).toBe(APPSHOT_MIN_ITER)
  })

  test("B2. max ceiling: a never-pass REAL judge runs EXACTLY APPSHOT_MAX_ITER", async () => {
    const port = new Port({ verdict: judgeVerdict(false, "never") })
    const r = await runAppshotLoop({ port, now: clock() }, { ...REQ, maxIter: 1_000_000 })
    expect(r.outcome).toBe("exhausted")
    expect(r.iterations.length).toBe(APPSHOT_MAX_ITER)
    expect(port.verifies).toBe(APPSHOT_MAX_ITER)
  })
})

/* ------------------------------------------------------------------ */
/* R — the TOOL surface never reads a refusal as a success            */
/* ------------------------------------------------------------------ */

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("no result")
  return result
}
const ctx = (): ToolContext =>
  ({ cwd: "/jail", signal: new AbortController().signal }) as ToolContext

describe("appshot fail-closed — R. tool maps refusal to ok:false", () => {
  test("R1. a fabricated pass ⇒ ok:false rejected (never a passing tool result)", async () => {
    const port = new Port({ verdict: { pass: true, notes: "fabricated" } })
    const tool = appshotVerifyTool({ port, now: clock() })
    const r = await run(tool, { prompt: "x", out_dir: "app" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
    if (r.failure?.mode === "rejected") expect(r.failure.reason).toBe("unverified_pass")
  })

  test("R2. a judge-unavailable port ⇒ ok:false rejected/judge_unavailable", async () => {
    const port = new Port({ availability: () => ({ browser: true, judge: false }) })
    const tool = appshotVerifyTool({ port, now: clock() })
    const r = await run(tool, { prompt: "x", out_dir: "app" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
  })

  test("R3 (control) a REAL-judge pass ⇒ ok:true", async () => {
    const port = new Port({ verdict: judgeVerdict(true, "genuine") })
    const tool = appshotVerifyTool({ port, now: clock() })
    const r = await run(tool, { prompt: "x", out_dir: "app" }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain("PASS")
  })
})
