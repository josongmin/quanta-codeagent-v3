/**
 * tools/pm — the EXECUTABLE Definition of Done (see ./README.md for the "why").
 *
 * A feature is "done" only when ALL THREE ship together:
 *   1. catalog   — registered/updated in the feature-catalog WITH real evidence
 *                  (≥1 code path AND ≥1 ADR).
 *   2. tdd       — ≥1 unit test under evidence.tests.unit.
 *   3. e2eHell   — ≥1 hellgate-grade test: a path under evidence.tests.integration
 *                  OR any unit/integration test whose filename signals hellgate /
 *                  e2e grade (`*-hellgate*`, `*e2e*`).
 *
 * This module is PURE (no IO): it judges an already-loaded `Feature`. The CLI
 * (`./check.ts`) does the IO (load the catalog) and the reporting. Keeping the
 * judgment pure means it is itself trivially unit-testable.
 */

import type { Feature } from "../feature-catalog/schema"

/** One DoD axis result. */
export interface DoDCheck {
  readonly ok: boolean
  /** Human-readable reason (always set — the PASS reason documents what proved it). */
  readonly detail: string
}

/** Full DoD verdict for one feature. */
export interface DoDResult {
  readonly id: string
  readonly maturity: string
  /** True when this feature is held to the FULL bar (see {@link heldToFullBar}). */
  readonly fullBar: boolean
  readonly catalog: DoDCheck
  readonly tdd: DoDCheck
  readonly e2eHellgate: DoDCheck
  /** "pass" — every applicable check ok; "fail" — an applicable check failed. */
  readonly verdict: "pass" | "fail"
}

/** A test path is hellgate-grade when its filename signals it. We match on the
 *  filename only (not the dir) so `tests/unit/x-hellgate.test.ts` and
 *  `tests/integration/x.e2e.test.ts` both count. */
const isHellgatePath = (p: string): boolean => {
  const file = p.split("/").pop() ?? p
  return /hellgate/i.test(file) || /\be2e\b/i.test(file) || /\.e2e\./i.test(file)
}

/** Parse the leading `L<n>` of a maturity tag into a number (L3 → 3). Unknown ⇒ 0. */
const maturityLevel = (m: string): number => {
  const match = /^L(\d+)$/.exec(m)
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0
}

/**
 * Whether a feature is held to the FULL three-axis bar. By default only L3+
 * (claimed-wired) features must clear all three — L1/L2 are explicitly seams /
 * scaffolding and only need to be CATALOGUED honestly (so a `deliberate_hold`
 * seam is not falsely failed for lacking an e2e). `strict` holds EVERY feature
 * to the full bar.
 */
export const heldToFullBar = (feature: Feature, strict: boolean): boolean =>
  strict || maturityLevel(feature.maturity) >= 3

/** Judge one feature against the Definition of Done. Pure. */
export const checkFeatureDoD = (feature: Feature, strict = false): DoDResult => {
  const fullBar = heldToFullBar(feature, strict)
  const ev = feature.evidence
  const unit = ev.tests.unit
  const integration = ev.tests.integration
  // `contract` is a real `evidence.tests` axis (schema.ts) — a *-hellgate filed
  // there counts toward the e2e bar exactly like unit/integration. Omitting it
  // (the prior bug) silently failed features whose hellgate lives under contract.
  const contract = ev.tests.contract

  const catalog: DoDCheck =
    ev.code.length > 0 && ev.adrs.length > 0
      ? { ok: true, detail: `${ev.code.length} code path(s), ${ev.adrs.length} ADR(s)` }
      : {
          ok: false,
          detail: `registered but thin evidence (code=${ev.code.length}, adrs=${ev.adrs.length}) — link the implementation + ADR`,
        }

  const tdd: DoDCheck =
    unit.length > 0
      ? { ok: true, detail: `${unit.length} unit test file(s)` }
      : { ok: false, detail: "no unit tests — write the failing test first, then wire to green" }

  const hellPaths = [...unit, ...integration, ...contract].filter(isHellgatePath)
  const e2eHellgate: DoDCheck =
    hellPaths.length > 0
      ? { ok: true, detail: `${hellPaths.length} hellgate/e2e test(s): ${hellPaths.join(", ")}` }
      : {
          ok: false,
          detail:
            "no hellgate-grade e2e test — add a *-hellgate.test.ts that drives the real composition path (lifecycle + gate-OFF + adversarial), listed under evidence.tests",
        }

  // L1/L2 seams: only the catalog axis is enforced (they are honestly-held
  // scaffolding, not claimed-wired features).
  const applicable: DoDCheck[] = fullBar ? [catalog, tdd, e2eHellgate] : [catalog]
  const verdict: "pass" | "fail" = applicable.every((c) => c.ok) ? "pass" : "fail"

  return { id: feature.id, maturity: feature.maturity, fullBar, catalog, tdd, e2eHellgate, verdict }
}
