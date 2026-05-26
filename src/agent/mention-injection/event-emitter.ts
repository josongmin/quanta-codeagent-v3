/**
 * ADR-0325 — Bridge from {@link InjectionFragment} to the ADR-0320
 * `TypedHistoryEventStore`.
 *
 * Variant-coverage decision (documented in ADR-0325 §3.2):
 *   - skill mention ⇒ emit `skill_activation` event (`trigger = "user"`).
 *     Matches Codex `build_skills_and_plugins` where a user `@skill`
 *     mention is recorded as a user-triggered activation.
 *   - plugin mention ⇒ NO typed event in this ADR. Plugin activation
 *     does not map to any of the five frozen variants (cwd / mode /
 *     repo_rules / active_skills / model). A new variant
 *     (`plugin_activation`) is the proper fix; deferred to a follow-up
 *     ADR (variant extension is closed-port behaviour).
 *   - app mention ⇒ NO typed event in this ADR. Same reason as plugin.
 *
 * The inject-message channel (see `inject-messages.ts`) DOES handle all
 * three kinds. Only the typed-history side-channel is variant-limited.
 *
 * Pure-ish: the emitter is side-effecting because it calls
 * `store.append(...)`, but contains no clock read / no I/O of its own.
 * `at` and `turnId` are caller-supplied.
 *
 * NO-THROW: a hostile / partial store implementation (missing `append`,
 * throwing `append`) does NOT crash the emitter. Bad calls are swallowed.
 * Rationale: this is a side-channel; dropping a typed-event is preferable
 * to aborting the user-visible turn.
 */

import type { SkillActivationEvent, TypedHistoryEventStore } from "@/memory/typed-event"
import type { InjectionFragment } from "./types"

/** Build the `skill_activation` event for a single skill fragment. The
 *  `trigger` is fixed to `"user"` because mention parsing only fires on
 *  text the user typed (not auto-injected ambient state). */
const buildSkillEvent = (
  fragment: InjectionFragment,
  at: number,
  turnId: string | undefined,
): SkillActivationEvent => {
  const base = {
    kind: "skill_activation",
    skillId: fragment.target,
    trigger: "user",
    at,
  } as const
  return turnId === undefined ? base : { ...base, turnId }
}

/** Safe-call wrapper around `store.append` so a partial / hostile
 *  TypedHistoryEventStore impl does not crash the pipeline. */
const safeAppend = (store: TypedHistoryEventStore, event: SkillActivationEvent): void => {
  if (typeof store.append !== "function") return
  try {
    store.append(event)
  } catch {
    /* swallow — side-channel, never crash the turn */
  }
}

/**
 * Emit typed-history events for the resolvable subset of fragments.
 *
 * - `skill` fragments produce one `skill_activation` event each.
 * - `plugin` / `app` fragments are silently SKIPPED at the typed-event
 *   layer (the inject-message layer handles them). See module docstring
 *   for the rationale and the follow-up ADR plan.
 *
 * Order of `store.append(...)` calls matches the input order of `skill`
 * fragments (a `plugin` between two skills does NOT change the relative
 * order of the surviving skill events).
 *
 * @param fragments  Pre-resolved fragments from {@link buildInjectionFragments}.
 * @param store      ADR-0320 typed history event store.
 * @param at         Epoch milliseconds for the events. Caller-supplied
 *                   (purity — no clock read here).
 * @param turnId     Optional turn correlation id. Forwarded to events.
 *                   If `undefined`, the field is omitted (matching the
 *                   `SkillActivationEvent` optional-property semantics).
 */
export const emitMentionEvents = (
  fragments: readonly InjectionFragment[],
  store: TypedHistoryEventStore,
  at: number,
  turnId: string | undefined,
): void => {
  if (fragments.length === 0) return
  for (const f of fragments) {
    if (f.kind !== "skill") continue
    safeAppend(store, buildSkillEvent(f, at, turnId))
  }
}
