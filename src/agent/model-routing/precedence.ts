/**
 * The precedence tables, as executable functions (MR-00).
 *
 * These are the ONLY place the three orderings are spelled. They are pure: no
 * env, no clock, no IO, no port construction — so the rules can be tested
 * exhaustively and every root provably shares them instead of re-deriving one in
 * a composition root where it cannot be reached by a test.
 *
 * The BOOT table (`explicit flag > QUANTA_MODEL > provider default`) is NOT here:
 * it needs the env and the provider's default table, so it lives in
 * `@/llm/boot-selection#resolveBootSelection`. This module consumes its OUTPUT
 * (`pinned`) rather than restating the rule.
 */

import type { ModelSelectionSource } from "./types"

/**
 * Which model seeds a session's selection at boot.
 *
 *   explicit boot pin > runnable persisted pick > boot model
 *
 * `pinned` means the operator named a model for THIS invocation (`--model` or
 * `QUANTA_MODEL`). A pin must beat a stored preference: `QUANTA_MODEL=x quanta …`
 * in CI, cron or a git hook otherwise ran whatever a human last picked with
 * `/model`, and the one-shot path paints no banner, so nothing said so.
 *
 * `persistedPick` must ALREADY be vetted by the caller (plausible slug, in-scope
 * key, and a port that can actually be built). An unrunnable pick is passed as
 * `undefined`: this function decides precedence, not admissibility — keeping the
 * two apart is what stopped one bad entry from erasing every other mode's pick.
 */
export const resolveInitialSelection = (input: {
  readonly bootModelId: string
  readonly pinned: boolean
  readonly persistedPick?: string | undefined
}): { readonly modelId: string; readonly source: Exclude<ModelSelectionSource, "skill"> } => {
  const pick = input.persistedPick
  if (input.pinned || pick === undefined || pick.length === 0) {
    return { modelId: input.bootModelId, source: "boot" }
  }
  // A pick EQUAL to the boot model is still a SESSION choice, not "no preference".
  // The boot model is not a fixed identity across sessions — change `QUANTA_MODEL`
  // and it moves — so "the user chose gpt-5.6-terra, which happens to be today's
  // default" and "the user chose nothing" must stay distinguishable, or tomorrow's
  // session silently runs a different model than the one they picked. It costs
  // nothing here: the port for it is the boot port by identity (invariant A).
  return { modelId: pick, source: "session" }
}

/**
 * Which model ONE request runs.
 *
 *   skill override > session selection > boot model
 *
 * Returns the SOURCE as well as the id because the two can name the same string
 * for different reasons, and the reason is what a report needs: a request that
 * ran the boot model because nothing was selected is a different fact from one
 * that ran it because a skill asked for exactly that model.
 *
 * A skill override is returned VERBATIM even if no port exists for it — the
 * caller then fails closed (`UnroutableModelError`). Substituting a fallback here
 * is precisely the silent-void-contract behaviour this replaces.
 */
export const resolveRequestModel = (input: {
  readonly bootModelId: string
  readonly selectedModelId?: string | undefined
  readonly skillModel?: string | undefined
}): { readonly modelId: string; readonly source: ModelSelectionSource } => {
  const skill = input.skillModel
  if (skill !== undefined && skill.length > 0) return { modelId: skill, source: "skill" }
  const selected = input.selectedModelId
  if (selected !== undefined && selected.length > 0 && selected !== input.bootModelId) {
    return { modelId: selected, source: "session" }
  }
  return { modelId: input.bootModelId, source: "boot" }
}
