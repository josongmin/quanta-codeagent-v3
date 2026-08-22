/**
 * BFND-03 — the UI-ONLY SWE dataset-family view registry.
 *
 * This is presentation state and nothing else: which family gets a tab, what that
 * tab is called, and (optionally) the client bundle that renders it. It
 * deliberately does NOT duplicate the runtime family registry
 * (`src/apps/bench/profiles/*`, which owns parsing, grading and bootstrap) and it
 * grants NO admission — registering a view here does not make the report decoder
 * accept that family. PMX-05 registers `promax` HERE, and that one line is the
 * entire dashboard-side change ProMax needs.
 *
 * ## The family-view client contract
 *
 * A family may ship its own cards/matrix. It registers them into the page's
 * `SWE_FAMILY_VIEWS` table (declared by {@link SWE_FAMILY_CLIENT_PRELUDE} below);
 * the page shell looks the ACTIVE view up in that table and names no family
 * itself. A family view is a FORMATTER: it receives already-aggregated totals off
 * the run and contains no denominator formula.
 */
import type { SuiteClientAssets } from "../types"
import { PROMAX_FAMILY_VIEW } from "./promax"

export interface SweFamilyView {
  /** The `datasetFamily` value this view renders. */
  readonly family: string
  readonly label: string
  /**
   * Optional client bundle. When present it registers
   * `SWE_FAMILY_VIEWS["<family>"] = { cards, matrix }` and the shell dispatches
   * to it for this view; when absent the shell's generic family fold renders.
   */
  readonly client?: SuiteClientAssets
}

/** The family every dashboard always offers, with or without runs. */
export const DEFAULT_SWE_VIEW = "verified"

const VIEWS: SweFamilyView[] = []

export const registerSweFamilyView = (view: SweFamilyView): void => {
  const existing = VIEWS.findIndex((v) => v.family === view.family)
  if (existing >= 0) VIEWS[existing] = view
  else VIEWS.push(view)
}

/** Registration order = display order. */
export const sweFamilyViews = (): readonly SweFamilyView[] => VIEWS

export const sweFamilyLabel = (family: string): string =>
  VIEWS.find((v) => v.family === family)?.label ?? family

export const isRegisteredSweFamilyView = (family: string): boolean =>
  VIEWS.some((v) => v.family === family)

/**
 * The GENERIC dispatch table the page shell reads. Shipped once, ahead of every
 * family bundle, and it mentions no family: `famView()` resolves whatever the
 * ACTIVE view registered, and returns null so the shell falls back to its own
 * family fold for the families that ship no bundle.
 */
export const SWE_FAMILY_CLIENT_PRELUDE = `
// ── SWE dataset-family views (BFND-03 registry; the shell names no family) ───
var SWE_FAMILY_VIEWS = {};
function famView() { return SWE_FAMILY_VIEWS[BENCH] || null; }
// The three rates, ALWAYS together (PMX-05): a flattering valid rate can never be
// rendered without its coverage. Values are PRE-FORMATTED by the report layer's
// one formatter — this builds no percentage of its own.
function ogRateCards(d) {
  return [["공식 유효 해결률", d.official_valid_rate, "resolved / grading-valid"],
          ["커버리지", d.coverage, "grading-valid / assigned"],
          ["raw 해결률", d.raw_rate, "resolved / assigned"]];
}`

/**
 * The SWE suite's client assets: the generic prelude plus every registered
 * family's own bundle, concatenated in registration order. Read once by the SWE
 * projector, so adding a family bundle needs no change in the projector, the page
 * shell, or the server.
 */
export const sweFamilyClientAssets = (): SuiteClientAssets => {
  const style: string[] = []
  const script: string[] = [SWE_FAMILY_CLIENT_PRELUDE]
  for (const view of VIEWS) {
    if (view.client === undefined) continue
    if (view.client.style !== "") style.push(view.client.style)
    if (view.client.script !== "") script.push(view.client.script)
  }
  return { style: style.join("\n"), script: script.join("\n") }
}

// The families that exist today. Order is the dashboard's tab order.
registerSweFamilyView({ family: DEFAULT_SWE_VIEW, label: "SWE-bench Verified" })
registerSweFamilyView({ family: "pro", label: "SWE-bench Pro" })
registerSweFamilyView({ family: "live", label: "SWE-bench Live" })
// PMX-05 — ONE registration is the entire dashboard-side change. ProMax is a
// SEPARATE partition from `pro`: different corpus, evaluator and result
// semantics, so their campaigns and views never merge.
registerSweFamilyView(PROMAX_FAMILY_VIEW)
