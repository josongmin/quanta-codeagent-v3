/**
 * C5059-05 — single-agent-first delegation policy (SSOT).
 *
 * The `agent` trio tool and the 6-tool `spawn_agent` BOTH described fan-out as a
 * first-class default ("launch several workers in parallel", "reach for
 * spawn_agent when you need multiple concurrent children"), while NOTHING stated
 * when NOT to delegate. That biases routine analysis toward unnecessary fan-out.
 *
 * Evidence this is the wrong default: Google's 180-config study — multi-agent
 * REGRESSES sequential-reasoning tasks 39–70%, and unchecked independent agents
 * amplify error; Codex `multi_agent_v2` ships an explicit default-suppression
 * ("Do not spawn sub-agents unless the user or AGENTS.md/skill instructions
 * explicitly ask; requests for depth/thoroughness/research do NOT count").
 *
 * This module is the ONE source both surfaces project, so the policy text can
 * never be duplicated or drift between the two tool descriptions. Wiring is
 * knob-gated (rollout step 1 = opt-in measurement arm): default-OFF is
 * byte-identical to the pre-C5059-05 prompt; flip to default-ON only after the
 * A/B holds on the eval corpus (ticket §rollout).
 */

/** Opt-in knob (C5059-05 rollout step 1). `"1"` prepends the suppression policy
 *  to the subagent tool descriptions; anything else ⇒ byte-identical legacy. */
export const DELEGATION_SUPPRESS_ENV = "QUANTA_SUBAGENT_DELEGATE_SUPPRESS"

/** The single policy atom. Both spawn surfaces prepend EXACTLY this string (never
 *  a paraphrase) so the model sees one consistent rule. */
export const DELEGATION_SUPPRESSION_POLICY =
  "DELEGATION POLICY: default to completing the task yourself in this single " +
  "agent. Do NOT spawn subagents unless the user, applicable repo rules, or an " +
  "activated skill EXPLICITLY asks for subagents, delegation, or parallel agent " +
  "work — requests for depth, research, investigation, thoroughness, or detailed " +
  "analysis are NOT authorization. When delegation is authorized, spawn only for " +
  "independent, meaningful subtasks whose write sets are disjoint (or children " +
  "are read-only), with explicit parent-synthesis ownership, and only when the " +
  "expected wall-time benefit exceeds coordination cost."

/** True when the opt-in knob is set. Reads the injected env map (closed over a
 *  record so tests need no global mutation). Default (unset) ⇒ false. */
export const delegationSuppressEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => env[DELEGATION_SUPPRESS_ENV] === "1"

/** Pure projection: prepend the policy atom to a tool description when enabled.
 *  Disabled ⇒ the description is returned UNCHANGED (byte-identical guarantee).
 *  Enabled ⇒ `policy + "\n\n" + description`, so the policy appears exactly once
 *  and leads. Idempotent is NOT assumed — call once per description. */
export const withDelegationPolicy = (description: string, enabled: boolean): string =>
  enabled ? `${DELEGATION_SUPPRESSION_POLICY}\n\n${description}` : description
