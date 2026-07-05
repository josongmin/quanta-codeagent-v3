/**
 * Observation metrics — per-instance USAGE / OVERTRUST rates (jul-6, Stream S4).
 * Design SSOT: `docs/plans/jul-6-observation-providers/README.md` (§실험 설계).
 *
 * Pure leaf. Each rate is derived DETERMINISTICALLY from one instance's
 * trajectory event array + the injected {@link ObservationBundle} for that run
 * (+ the final success-patch files, when the run passed). No IO / env / `@/llm`.
 *
 * HARD invariant (audit A-empty / measurement-lie): every rate handles the
 * zero-denominator case WITHOUT NaN and WITHOUT flattering. A rate whose
 * denominator is 0 returns `{ applicable:false, rate:null }` — an explicit
 * "not-applicable", NEVER `0` (which a downstream reader would misread as
 * "0% overtrust = safe"). Only an actual observed-and-measured denominator
 * yields a numeric rate.
 */

import type { RefuteResult } from "../critic"
import type { ObservationBundle } from "../fragment"
import {
  EDIT_TOOLS,
  type MetricEvent,
  NON_FILE_VERIFY_TOOLS,
  pathMatchesAnyOwner,
  pathMatchesOwner,
  READ_TOOLS,
  toolFilePath,
  toolName,
  VERIFY_TOOLS,
} from "./event"

/**
 * A per-instance rate. `rate` is `null` EXACTLY when `applicable` is false
 * (den === 0) — the two are kept redundant so a consumer can pattern-match on
 * either without recomputing. `num`/`den` are exposed for pooled aggregation
 * (sum numerators / sum denominators across instances — a mean-of-rates would
 * be biased). NEVER read `rate` as a success value when `!applicable`.
 */
export interface Rate {
  readonly applicable: boolean
  readonly rate: number | null
  readonly num: number
  readonly den: number
}

/** The extra, non-trajectory inputs a rate may need (all optional/observe-only). */
export interface MetricInputs {
  /**
   * Files in the FINAL success patch (repo-relative), when the run passed.
   * `undefined` ⇒ run did not pass / patch unknown ⇒ success-conditioned rates
   * (`wrong_owner_edit_rate`, `critic_saved_edit_rate`) are not-applicable.
   */
  readonly successPatchFiles?: readonly string[]
  /** Whether the instance ultimately resolved (fail_to_pass). */
  readonly passed?: boolean
  /**
   * Critic verdicts observed during the run, in order, each tagged with the
   * owner path the model was about to edit when the critic fired.
   */
  readonly criticVerdicts?: readonly CriticObservation[]
}

/** One observe-only critic firing (consumes the contract's {@link RefuteResult}). */
export interface CriticObservation {
  /** Repo-relative owner path the model was editing when the critic evaluated it. */
  readonly editedOwner: string
  readonly result: RefuteResult
}

const naRate = (): Rate => ({ applicable: false, rate: null, num: 0, den: 0 })

/** Build a Rate from an integer numerator/denominator; den===0 ⇒ not-applicable. */
export const makeRate = (num: number, den: number): Rate =>
  den <= 0 ? naRate() : { applicable: true, rate: num / den, num, den }

/** All owner-hint file paths in the bundle (repo-relative, deduped, order-stable). */
export const bundleOwnerPaths = (bundle: ObservationBundle): readonly string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const o of bundle.owners) {
    const p = o.file.replaceAll("\\", "/")
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/** Edited-file paths across the trajectory, in first-occurrence order. */
const editedPaths = (events: readonly MetricEvent[]): readonly string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of events) {
    const name = toolName(e)
    if (name === undefined || !EDIT_TOOLS.has(name)) continue
    const p = toolFilePath(e)
    if (p !== undefined && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/**
 * `owner_edit_hit_rate` — did the model edit a file that was a suggested owner?
 *
 * Denominator = number of DISTINCT suggested owner files (the population the
 * hint could have been followed on). Numerator = how many of those the model
 * actually edited. Not-applicable when there were NO suggested owners (den 0):
 * "did they follow a hint" is meaningless with no hint.
 */
export const ownerEditHitRate = (
  events: readonly MetricEvent[],
  bundle: ObservationBundle,
): Rate => {
  const owners = bundleOwnerPaths(bundle)
  if (owners.length === 0) return naRate()
  const edits = editedPaths(events)
  let hit = 0
  for (const owner of owners) {
    if (edits.some((e) => pathMatchesOwner(e, owner))) hit++
  }
  return makeRate(hit, owners.length)
}

/**
 * `hint_read_rate` — after observations were present, did the model `read` a
 * suggested owner file BEFORE it edited that same file?
 *
 * Denominator = suggested owners the model went on to EDIT (only for edited
 * owners is "did you read it first" answerable). Numerator = those with a prior
 * `read` of the same file. Not-applicable when the model edited none of the
 * suggested owners (den 0) — otherwise an inactive run would score a flattering
 * 0/0-as-0.
 */
export const hintReadRate = (events: readonly MetricEvent[], bundle: ObservationBundle): Rate => {
  const owners = bundleOwnerPaths(bundle)
  if (owners.length === 0) return naRate()
  let den = 0
  let num = 0
  for (const owner of owners) {
    const firstEdit = firstIndexTouching(events, owner, EDIT_TOOLS)
    if (firstEdit < 0) continue // owner never edited ⇒ not part of this denominator
    den++
    const firstRead = firstIndexTouching(events, owner, READ_TOOLS)
    if (firstRead >= 0 && firstRead < firstEdit) num++
  }
  return makeRate(num, den)
}

/**
 * `hint_verify_rate` — before editing a suggested owner, did the model run ANY
 * verify step (lsp / read / test) on it first?
 *
 * Denominator = suggested owners the model edited. Numerator = those with a
 * file-targeted verify (lsp/read on the same file) OR a non-file-targeted
 * verify (test/bash) strictly BEFORE the first edit of that owner. Not-applicable
 * when no suggested owner was edited (den 0).
 */
export const hintVerifyRate = (events: readonly MetricEvent[], bundle: ObservationBundle): Rate => {
  const owners = bundleOwnerPaths(bundle)
  if (owners.length === 0) return naRate()
  let den = 0
  let num = 0
  for (const owner of owners) {
    const firstEdit = firstIndexTouching(events, owner, EDIT_TOOLS)
    if (firstEdit < 0) continue
    den++
    if (verifiedBefore(events, owner, firstEdit)) num++
  }
  return makeRate(num, den)
}

/**
 * `hint_follow_without_verify_rate` — THE overtrust early-warning. Did the model
 * edit a suggested owner WITHOUT any verify beforehand?
 *
 * Denominator = suggested owners the model edited (the "followed the hint"
 * population). Numerator = those edited with NO prior verify. This is the exact
 * complement of {@link hintVerifyRate} on the same denominator, kept as its own
 * function so the danger signal has a first-class name and its own red-on-
 * injection pin. Not-applicable when no suggested owner was edited (den 0) —
 * crucially NOT 0, so "model ignored every hint" never masquerades as
 * "0% overtrust".
 */
export const hintFollowWithoutVerifyRate = (
  events: readonly MetricEvent[],
  bundle: ObservationBundle,
): Rate => {
  const owners = bundleOwnerPaths(bundle)
  if (owners.length === 0) return naRate()
  let den = 0
  let num = 0
  for (const owner of owners) {
    const firstEdit = firstIndexTouching(events, owner, EDIT_TOOLS)
    if (firstEdit < 0) continue
    den++
    if (!verifiedBefore(events, owner, firstEdit)) num++
  }
  return makeRate(num, den)
}

/**
 * `critic_saved_edit_rate` — after a critic `refuted` verdict on an owner, did
 * the model move to a DIFFERENT owner AND the run pass?
 *
 * Denominator = distinct owners that received a `refuted` verdict. Numerator =
 * refuted owners where (a) the model subsequently edited a DIFFERENT file than
 * the refuted one, and (b) the run ultimately passed. Not-applicable when there
 * were no `refuted` verdicts (den 0) — the critic never fired, so "did it save"
 * is unanswerable, NOT a 0.
 *
 * Only `refuted` counts (the contract's 3-way rule: `not_refuted`/`inconclusive`
 * assert NOTHING — see `critic.ts`), so those verdicts are excluded from the
 * denominator entirely.
 */
export const criticSavedEditRate = (events: readonly MetricEvent[], inputs: MetricInputs): Rate => {
  const refuted = (inputs.criticVerdicts ?? []).filter((c) => c.result.verdict === "refuted")
  if (refuted.length === 0) return naRate()
  const edits = editedPaths(events)
  const passed = inputs.passed === true
  const seen = new Set<string>()
  let den = 0
  let num = 0
  for (const c of refuted) {
    const owner = c.editedOwner.replaceAll("\\", "/")
    if (seen.has(owner)) continue
    seen.add(owner)
    den++
    const movedElsewhere = edits.some((e) => !pathMatchesOwner(e, owner))
    if (passed && movedElsewhere) num++
  }
  return makeRate(num, den)
}

/**
 * `wrong_owner_edit_rate` — of the owners the model edited, how many were NOT in
 * the final success patch?
 *
 * Denominator = distinct files the model edited (needs a known success patch to
 * judge "wrong"). Numerator = edited files absent from the success patch.
 * Not-applicable when the success patch is unknown (run failed / no patch) OR
 * the model edited nothing (den 0). Success-conditioned by design: without the
 * ground-truth patch, "wrong" is undefined — we return not-applicable rather
 * than guess.
 */
export const wrongOwnerEditRate = (events: readonly MetricEvent[], inputs: MetricInputs): Rate => {
  const patchFiles = inputs.successPatchFiles
  if (patchFiles === undefined) return naRate()
  const edits = editedPaths(events)
  if (edits.length === 0) return naRate()
  const normalizedPatch = patchFiles.map((p) => p.replaceAll("\\", "/"))
  let wrong = 0
  for (const e of edits) {
    if (!pathMatchesAnyOwner(e, normalizedPatch)) wrong++
  }
  return makeRate(wrong, edits.length)
}

// --- shared trajectory-order helpers -------------------------------------

/**
 * Index of the first event that is a `tool_call` whose tool ∈ `tools` and whose
 * target file path-matches `owner`. `-1` if none. Uses array order (== `seq`
 * order for a single-instance trajectory).
 */
const firstIndexTouching = (
  events: readonly MetricEvent[],
  owner: string,
  tools: ReadonlySet<string>,
): number => {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e === undefined) continue
    const name = toolName(e)
    if (name === undefined || !tools.has(name)) continue
    const p = toolFilePath(e)
    if (p !== undefined && pathMatchesOwner(p, owner)) return i
  }
  return -1
}

/**
 * Was there ANY verify of `owner` strictly before index `firstEditIdx`? A verify
 * is either a file-targeted verify tool on the same file, OR a non-file verify
 * (test/bash/search) run before the edit. A `read` counts (it is in both READ
 * and VERIFY sets) — inspecting the target IS a check.
 */
const verifiedBefore = (
  events: readonly MetricEvent[],
  owner: string,
  firstEditIdx: number,
): boolean => {
  for (let i = 0; i < firstEditIdx; i++) {
    const e = events[i]
    if (e === undefined) continue
    const name = toolName(e)
    if (name === undefined || !VERIFY_TOOLS.has(name)) continue
    if (NON_FILE_VERIFY_TOOLS.has(name)) return true // global exercise before the edit
    const p = toolFilePath(e)
    if (p !== undefined && pathMatchesOwner(p, owner)) return true
  }
  return false
}
