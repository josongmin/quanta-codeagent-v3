/**
 * HELLGATE — the web's stop-presentation mirror cannot drift from core
 * (aug-23 §13 follow-up)
 *
 * The web bundle does not import from `@/` (it consumes the protocol only), so
 * the stop-reason copy is mirrored in
 * `apps/web-frontend/src/lib/stop-presentation.ts`. A mirror with no contract is
 * how a codebase ends up with eight independent classifications — the exact
 * failure the objective audit warned about. This is the contract.
 *
 * Invariants:
 *
 *  H1  SAME KEYS — every core `STOP_REASON_CODE` has a web entry and vice
 *      versa. Adding a code to core without web copy fails HERE.
 *  H2  SAME TONES — a code's tone is identical on both sides. Divergent tones
 *      mean two surfaces disagree about whether a stop was a failure.
 *  H3  SAME LABELS — the copy matches, so the CLI and the web name a stop the
 *      same way.
 *  H4  UNKNOWN FALLBACK AGREES — both degrade an unrecognized code to a
 *      non-success tone (never to `success`).
 */

import { describe, expect, test } from "bun:test"
import {
  stopPresentationFor as coreStopPresentationFor,
  STOP_PRESENTATION_BY_REASON_CODE,
  STOP_REASON_CODE,
} from "@/agent/stop-category"
import {
  STOP_PRESENTATION as WEB_STOP_PRESENTATION,
  stopPresentationFor as webStopPresentationFor,
} from "../../../apps/web-frontend/src/lib/stop-presentation"

describe("H1 — the two tables cover the same codes", () => {
  test("core codes all exist on the web side", () => {
    const missing = Object.values(STOP_REASON_CODE).filter(
      (code) => WEB_STOP_PRESENTATION[code] === undefined,
    )
    expect(missing).toEqual([])
  })

  test("the web side has no codes core does not know", () => {
    const known = new Set<string>(Object.values(STOP_REASON_CODE))
    const extra = Object.keys(WEB_STOP_PRESENTATION).filter((code) => !known.has(code))
    expect(extra).toEqual([])
  })
})

describe("H2/H3 — tone and label agree for every code", () => {
  test("no divergence", () => {
    const divergent: string[] = []
    for (const code of Object.values(STOP_REASON_CODE)) {
      const core = STOP_PRESENTATION_BY_REASON_CODE[code]
      const web = WEB_STOP_PRESENTATION[code]
      if (web === undefined) continue
      if (core.tone !== web.tone || core.label !== web.label) divergent.push(code)
    }
    expect(divergent).toEqual([])
  })
})

describe("H4 — the unknown fallback agrees and is never success", () => {
  test("both degrade to a non-success tone", () => {
    const code = "some.future.code"
    expect(coreStopPresentationFor(code).tone).not.toBe("success")
    expect(webStopPresentationFor(code).tone).not.toBe("success")
    expect(coreStopPresentationFor(code).tone).toBe(webStopPresentationFor(code).tone)
  })
})
