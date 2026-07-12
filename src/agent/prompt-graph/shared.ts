/**
 * Shared prompt constants + the `agentOpener` primitive (2-tier prompt design
 * system, jul-13).
 *
 * PURE LEAF: this module imports NOTHING from the prompt system so it can be
 * consumed by both the main-agent recipe (`prompt-body.ts` INTRO) and every
 * auxiliary/sub-agent prompt (repro-gen, localize, judges, …) without a cycle.
 *
 * Rationale (measured, not assumed): a full "token tier" was rejected — only a
 * HANDFUL of prompt values actually repeat across call sites. `"Quanta"` occurs
 * in 18 prompt strings; the role NOUN in ~7. Those are the only values that earn
 * central ownership. Everything else (each sub-agent's task description) is a
 * one-off passed as a literal `tail` to {@link agentOpener} — NOT centralized.
 *
 * This is the SINGLE home for the agent name and the seniority word, which had
 * drifted: the main prompt said "principal", the repro-gen / localize sub-agents
 * said "senior". Centralizing here makes the drift unrepresentable — there is one
 * `ROLE` map and one `AGENT_NAME`.
 */

/** The agent's proper name. One source for the ~18 prompt strings that name it. */
export const AGENT_NAME = "Quanta" as const

/** Seniority-qualified role nouns. The main-agent recipe uses `principal`; the
 *  sub-agent recipes pick the role that fits their task. Closed map so a new
 *  caller cannot invent a fourth spelling of the same idea. */
export const ROLE = {
  principal: "principal software engineer",
  senior: "senior software engineer",
  pyEngineer: "senior Python engineer",
} as const

export type RoleKey = keyof typeof ROLE

/**
 * The opener primitive — the one place a "You are …" agent-identity line is
 * shaped. Two forms:
 *   - named   (`name` present): `You are {name}, a {role} {tail}` — the main agent.
 *   - unnamed (`name` absent) : `You are a {role} {tail}`         — sub-agents.
 *
 * `tail` is the caller's one-off remainder (e.g. "working autonomously in a" or
 * "doing precise file-level fault localization."). Pure string function — no IO.
 */
export const agentOpener = (opts: {
  readonly name?: string
  readonly role: string
  readonly tail: string
}): string =>
  opts.name !== undefined
    ? `You are ${opts.name}, a ${opts.role} ${opts.tail}`
    : `You are a ${opts.role} ${opts.tail}`
