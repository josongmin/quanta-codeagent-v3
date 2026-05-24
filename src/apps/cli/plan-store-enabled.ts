/**
 * Pure env gate for the `/plan` store wire — peer of `isCostPanelEnabled`,
 * `isLifecyclePillsEnabled`, `isBranchProgressEnabled`.
 *
 * Semantics differ from its peers: the plan store is **opt-IN** (not
 * default-ON), preserving the pre-cleanup `buildPlanStoreOrUndefined` body
 * byte-identically. Unset / empty / `"0"` / `"false"` / `"off"` / `"no"` ⇒
 * disabled; anything else (`"1"`, `"true"`, `"on"`, `"yes"`, etc.) ⇒ enabled.
 *
 * Centralized so a future change to the "falsy string" family flips ALL
 * surface gates together (instead of leaving a stale inline parser behind).
 */

/** True ⇔ the raw env value is one of the standard "off" strings. */
const isOffString = (v: string | undefined): boolean => {
  if (v === undefined) return false
  const n = v.trim().toLowerCase()
  return n === "" || n === "0" || n === "false" || n === "off" || n === "no"
}

/**
 * Pure env gate. Default-OFF; explicit `QUANTA_PLAN_STORE=1|true|on|yes|…`
 * (anything not in the falsy family) enables. Empty / unset ⇒ disabled.
 */
export const isPlanStoreEnabled = (env: NodeJS.ProcessEnv): boolean => {
  const knob = env.QUANTA_PLAN_STORE
  if (knob === undefined) return false
  return !isOffString(knob)
}
