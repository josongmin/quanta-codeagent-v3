import { gateOn } from "./env-flag"

/**
 * C5059-05 — single-agent-first delegation policy (SSOT, shared leaf).
 *
 * Lives in `@/shared` (not `@/subagent`) so ALL delegation surfaces can project
 * the SAME atom without a slice-boundary violation: `@/subagent` (`agent` +
 * `spawn_agent`), `@/tool` (`spawn_batch` + `spawn_agents_on_csv`), and
 * `@/agent` (the system-prompt tool-routing atom) all import `@/shared`.
 *
 * The two spawn tool families described fan-out as a first-class default
 * ("launch several workers in parallel", "Fan out one child per row") while the
 * system prompt actively told the model to "fan out independent exploration
 * subagents", and NOTHING stated when NOT to delegate. Evidence this is the wrong
 * default: Google's 180-config study — multi-agent REGRESSES sequential reasoning
 * 39–70% and amplifies error; Codex `multi_agent_v2` ships explicit default
 * suppression.
 *
 * This module is the ONE source; every surface prepends EXACTLY
 * {@link DELEGATION_SUPPRESSION_POLICY} (never a paraphrase). Enablement is
 * resolved from `runtimeConfig().subagentDelegateSuppress` (knob
 * `QUANTA_SUBAGENT_DELEGATE_SUPPRESS`, default-OFF ⇒ byte-identical prompt).
 * Flip to default-ON only after the eval-corpus A/B holds (ticket §rollout).
 */

/** The single policy atom. Every spawn/delegation surface prepends EXACTLY this
 *  string so the model sees one consistent rule (no drift between surfaces). */
export const DELEGATION_SUPPRESSION_POLICY =
  "DELEGATION POLICY: default to completing the task yourself in this single " +
  "agent. Do NOT spawn subagents unless the user, applicable repo rules, or an " +
  "activated skill EXPLICITLY asks for subagents, delegation, or parallel agent " +
  "work — requests for depth, research, investigation, thoroughness, or detailed " +
  "analysis are NOT authorization. When delegation is authorized, spawn only for " +
  "independent, meaningful subtasks whose write sets are disjoint (or children " +
  "are read-only), with explicit parent-synthesis ownership, and only when the " +
  "expected wall-time benefit exceeds coordination cost."

/** Resolve the knob from an env map. Uses the SAME `gateOn` vocab
 *  (`1`/`on`/`true`/`yes`) as `runtimeConfig().subagentDelegateSuppress` so the
 *  two resolutions never diverge. Reading here (env-flag is a pure `@/shared`
 *  leaf) instead of importing `@/shared/runtime-config` keeps the `@/tool`
 *  spawn-batch surfaces free of the features.ts import cycle. Default (unset) ⇒
 *  false. The knob stays registered in runtime-config (inventory + default-off
 *  completeness guard); this is the same env var, one resolution rule. */
export const delegationSuppressEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => gateOn(env, "QUANTA_SUBAGENT_DELEGATE_SUPPRESS")

/** Pure projection: prepend the policy atom to a tool description when enabled.
 *  Disabled ⇒ the description is returned UNCHANGED (byte-identical guarantee).
 *  Enabled ⇒ `policy + "\n\n" + description`, so the policy appears exactly once
 *  and leads. Callers pass {@link delegationSuppressEnabled}(). */
export const withDelegationPolicy = (description: string, enabled: boolean): string =>
  enabled ? `${DELEGATION_SUPPRESSION_POLICY}\n\n${description}` : description
