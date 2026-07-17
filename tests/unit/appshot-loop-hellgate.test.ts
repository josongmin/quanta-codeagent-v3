/**
 * Hellgate — appshot verify-loop CORE (G1, RFC jun-6-appgen-appshot Phase 1).
 *
 * Seal (FakeAppshotPort — scripted renders + deterministic verdicts, NO Chrome,
 * NO network, NO disk; injected clock):
 *   A. pass verdict ⇒ loop STOPS EARLY (one iteration), outcome `pass`
 *   B. never-pass verdict ⇒ loop runs EXACTLY the iteration cap then stops
 *      (`exhausted`, bounded — no infinite loop), carries the last verdict
 *   C. iteration cap is CLAMPED to [MIN, MAX] (a huge / zero / NaN request can
 *      never produce an unbounded or empty loop)
 *   D. a scaffold throw ⇒ typed `failed`/`scaffold_failed`, NO-THROW
 *   E. a render throw ⇒ typed `failed`/`render_failed`, NO-THROW
 *   F. a screenshot throw ⇒ typed `failed`/`screenshot_failed`, NO-THROW
 *   G. an oversize screenshot ⇒ typed `screenshot_over_cap` (cap invariant)
 *   H. a verify throw ⇒ typed `failed`/`verify_failed`, NO-THROW
 *   I. an aborted signal ⇒ typed `failed`/`aborted` on the first iteration
 *   J. the produced artifact is registered EXACTLY ONCE per scaffold (final id
 *      surfaced); a throwing sink never breaks the loop
 *   K. failing verdicts are threaded back as scaffold feedback (the edit arrow)
 */

import { describe, expect, test } from "bun:test"
import {
  APPSHOT_MAX_ITER,
  APPSHOT_MAX_SCREENSHOT_BYTES,
  APPSHOT_MIN_ITER,
  type AppSpec,
  type AppshotArtifactSink,
  type AppshotPort,
  clampIter,
  isRealJudgePass,
  judgeVerdict,
  runAppshotLoop,
  type ScaffoldResult,
  type VerifyVerdict,
} from "@/tool/appshot"

/** A REAL-judge PASS — the ONLY verdict the loop honors as success (branded via
 *  `judgeVerdict`). A plain `{ pass: true, notes }` literal is a fabricated pass
 *  the loop MUST refuse (see the fail-closed suite below). */
const realPass = (notes: string): VerifyVerdict => judgeVerdict(true, notes)
/** A real-judge FAIL (branding a fail is harmless; the adapter has one path). */
const realFail = (notes: string): VerifyVerdict => judgeVerdict(false, notes)

/* ------------------------------------------------------------------ */
/* fakes                                                              */
/* ------------------------------------------------------------------ */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

interface FakeOpts {
  /** Verdict to return each verify call (by iteration index). */
  readonly verdicts?: readonly VerifyVerdict[]
  /** Default verdict when `verdicts` is exhausted/absent. */
  readonly defaultVerdict?: VerifyVerdict
  readonly throwOn?: "scaffold" | "render" | "screenshot" | "verify"
  /** Bytes the screenshot returns (default a tiny PNG). */
  readonly shot?: Uint8Array
}

/** Records every call so the test can assert counts + feedback threading. */
class FakeAppshotPort implements AppshotPort {
  readonly scaffoldSpecs: AppSpec[] = []
  renderCount = 0
  screenshotCount = 0
  verifyCount = 0
  private verifyIdx = 0
  constructor(private readonly opts: FakeOpts = {}) {}

  async scaffold(spec: AppSpec, outDir: string): Promise<ScaffoldResult> {
    this.scaffoldSpecs.push(spec)
    if (this.opts.throwOn === "scaffold") throw new Error("chrome dir locked")
    return {
      entryUrl: `file://${outDir}/index.html`,
      entryPath: `${outDir}/index.html`,
      mediaType: "text/html",
    }
  }
  async render(): Promise<void> {
    this.renderCount++
    if (this.opts.throwOn === "render") throw new Error("navigate failed")
  }
  async screenshot(): Promise<Uint8Array> {
    this.screenshotCount++
    if (this.opts.throwOn === "screenshot") throw new Error("transport drop")
    return this.opts.shot ?? PNG
  }
  async verify(): Promise<VerifyVerdict> {
    this.verifyCount++
    if (this.opts.throwOn === "verify") throw new Error("judge 500")
    const scripted = this.opts.verdicts?.[this.verifyIdx]
    this.verifyIdx++
    // Default = a REAL-judge fail (branded) so the fake models a genuine judge;
    // tests that need a fabricated (unbranded) pass pass a literal via `verdicts`.
    return scripted ?? this.opts.defaultVerdict ?? realFail("not yet")
  }
}

/** Deterministic monotonic clock (no Date.now). */
const fakeClock = (): (() => number) => {
  let t = 0
  return () => (t += 1000)
}

/** Recording artifact sink — counts register calls + mints stable ids. */
class RecordingSink implements AppshotArtifactSink {
  readonly registered: Array<{ path: string; mediaType: string }> = []
  private n = 0
  register(spec: { kind: "other"; path: string; mediaType: string; label?: string }): {
    id: string
  } {
    this.registered.push({ path: spec.path, mediaType: spec.mediaType })
    this.n++
    return { id: `app-${this.n}` }
  }
}

/* ------------------------------------------------------------------ */
/* A — early stop on pass                                             */
/* ------------------------------------------------------------------ */

describe("appshot loop — A. pass stops early", () => {
  test("a pass verdict ends the loop after ONE iteration", async () => {
    const port = new FakeAppshotPort({ defaultVerdict: realPass("looks right") })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "a red button",
        outDir: "/jail/app",
        maxIter: 5,
      },
    )
    expect(r.outcome).toBe("pass")
    expect(r.iterations.length).toBe(1)
    expect(port.verifyCount).toBe(1)
    expect(r.lastVerdict?.pass).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* B — bounded: never-pass hits the cap                              */
/* ------------------------------------------------------------------ */

describe("appshot loop — B. bounded (no infinite loop)", () => {
  test("a never-pass verdict runs EXACTLY maxIter then exhausts", async () => {
    const port = new FakeAppshotPort({ defaultVerdict: realFail("off-center") })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "centered button",
        outDir: "/jail/app",
        maxIter: 4,
      },
    )
    expect(r.outcome).toBe("exhausted")
    expect(r.iterations.length).toBe(4)
    expect(port.scaffoldSpecs.length).toBe(4)
    expect(port.verifyCount).toBe(4)
    expect(r.lastVerdict?.notes).toBe("off-center")
  })
})

/* ------------------------------------------------------------------ */
/* C — clamp                                                          */
/* ------------------------------------------------------------------ */

describe("appshot loop — C. iteration cap clamped", () => {
  test("clampIter floors/ceils/floors NaN into [MIN, MAX]", () => {
    expect(clampIter(0)).toBe(APPSHOT_MIN_ITER)
    expect(clampIter(-100)).toBe(APPSHOT_MIN_ITER)
    expect(clampIter(99999)).toBe(APPSHOT_MAX_ITER)
    // Non-finite requests (NaN / ±Infinity) are NOT trusted as a "huge" cap —
    // they floor to MIN (the safe minimum), never an unbounded run.
    expect(clampIter(Number.NaN)).toBe(APPSHOT_MIN_ITER)
    expect(clampIter(Number.POSITIVE_INFINITY)).toBe(APPSHOT_MIN_ITER)
    expect(clampIter(3.9)).toBe(3)
  })

  test("a huge maxIter request can never exceed the hard cap of iterations", async () => {
    const port = new FakeAppshotPort({ defaultVerdict: realFail("n") })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 1_000_000,
      },
    )
    expect(r.iterations.length).toBe(APPSHOT_MAX_ITER)
  })

  test("a zero maxIter still runs the MIN (never an empty loop)", async () => {
    const port = new FakeAppshotPort({ defaultVerdict: realPass("ok") })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 0,
      },
    )
    expect(r.iterations.length).toBe(APPSHOT_MIN_ITER)
  })
})

/* ------------------------------------------------------------------ */
/* D–F, H — effect throws → typed failed, NO-THROW                    */
/* ------------------------------------------------------------------ */

describe("appshot loop — effect throws map to typed failures (NO-THROW)", () => {
  test("D. scaffold throw ⇒ failed/scaffold_failed", async () => {
    const port = new FakeAppshotPort({ throwOn: "scaffold" })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 3,
      },
    )
    expect(r.outcome).toBe("failed")
    expect(r.error?.kind).toBe("scaffold_failed")
    expect(r.iterations.length).toBe(1) // ends on first error
  })

  test("E. render throw ⇒ failed/render_failed", async () => {
    const port = new FakeAppshotPort({ throwOn: "render" })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 3,
      },
    )
    expect(r.outcome).toBe("failed")
    expect(r.error?.kind).toBe("render_failed")
  })

  test("F. screenshot throw ⇒ failed/screenshot_failed", async () => {
    const port = new FakeAppshotPort({ throwOn: "screenshot" })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 3,
      },
    )
    expect(r.outcome).toBe("failed")
    expect(r.error?.kind).toBe("screenshot_failed")
  })

  test("H. verify throw ⇒ failed/verify_failed", async () => {
    const port = new FakeAppshotPort({ throwOn: "verify" })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 3,
      },
    )
    expect(r.outcome).toBe("failed")
    expect(r.error?.kind).toBe("verify_failed")
  })
})

/* ------------------------------------------------------------------ */
/* G — screenshot over cap                                            */
/* ------------------------------------------------------------------ */

describe("appshot loop — G. oversize screenshot refused", () => {
  test("a shot over MAX_SCREENSHOT_BYTES ⇒ screenshot_over_cap, never judged", async () => {
    const big = new Uint8Array(APPSHOT_MAX_SCREENSHOT_BYTES + 1)
    const port = new FakeAppshotPort({ shot: big, defaultVerdict: { pass: true, notes: "x" } })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 3,
      },
    )
    expect(r.outcome).toBe("failed")
    expect(r.error?.kind).toBe("screenshot_over_cap")
    expect(port.verifyCount).toBe(0) // refused BEFORE the judge call
  })
})

/* ------------------------------------------------------------------ */
/* I — aborted                                                        */
/* ------------------------------------------------------------------ */

describe("appshot loop — I. aborted signal", () => {
  test("an already-aborted signal ⇒ failed/aborted with no effects run", async () => {
    const ac = new AbortController()
    ac.abort()
    const port = new FakeAppshotPort({ defaultVerdict: { pass: true, notes: "x" } })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 3,
        signal: ac.signal,
      },
    )
    expect(r.outcome).toBe("failed")
    expect(r.error?.kind).toBe("aborted")
    expect(port.scaffoldSpecs.length).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* J — artifact registered exactly once per scaffold                 */
/* ------------------------------------------------------------------ */

describe("appshot loop — J. artifact registration", () => {
  test("the final scaffold is registered; id surfaced; one register per scaffold", async () => {
    const sink = new RecordingSink()
    // Two iterations (fail then pass) ⇒ two scaffolds ⇒ two register calls.
    const port = new FakeAppshotPort({
      verdicts: [realFail("fix it"), realPass("good")],
    })
    const r = await runAppshotLoop(
      { port, now: fakeClock(), artifactSink: sink },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 5,
        label: "my-app",
      },
    )
    expect(r.outcome).toBe("pass")
    expect(sink.registered.length).toBe(2)
    expect(sink.registered[0]?.mediaType).toBe("text/html")
    expect(r.artifactId).toBe("app-2") // the FINAL scaffold's id
    expect(r.entryUrl).toContain("index.html")
  })

  test("no sink ⇒ no registration, no artifactId (byte-identical)", async () => {
    const port = new FakeAppshotPort({ defaultVerdict: realPass("ok") })
    const r = await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 2,
      },
    )
    expect(r.artifactId).toBeUndefined()
  })

  test("a throwing sink never breaks the loop", async () => {
    const port = new FakeAppshotPort({ defaultVerdict: realPass("ok") })
    const throwingSink: AppshotArtifactSink = {
      register() {
        throw new Error("sink down")
      },
    }
    const r = await runAppshotLoop(
      { port, now: fakeClock(), artifactSink: throwingSink },
      {
        prompt: "x",
        outDir: "/jail/app",
        maxIter: 2,
      },
    )
    expect(r.outcome).toBe("pass")
    expect(r.artifactId).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* K — feedback threaded back (the edit arrow)                        */
/* ------------------------------------------------------------------ */

describe("appshot loop — K. feedback threading (edit arrow)", () => {
  test("each failing verdict's notes are fed into the NEXT scaffold's feedback", async () => {
    const port = new FakeAppshotPort({
      verdicts: [realFail("button too small"), realFail("wrong color"), realPass("good")],
    })
    await runAppshotLoop(
      { port, now: fakeClock() },
      {
        prompt: "a button",
        outDir: "/jail/app",
        maxIter: 5,
      },
    )
    // iter 0: no feedback; iter 1: ["button too small"]; iter 2: both notes.
    expect(port.scaffoldSpecs[0]?.feedback).toEqual([])
    expect(port.scaffoldSpecs[1]?.feedback).toEqual(["button too small"])
    expect(port.scaffoldSpecs[2]?.feedback).toEqual(["button too small", "wrong color"])
  })
})
