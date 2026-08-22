/**
 * Persona slot — Codex `{{ personality }}` Handlebars absorption (ADR-0068).
 *
 * Four named tonal registers selectable at REPL startup via `QUANTA_PERSONA`:
 *   - `default`    — empty body, byte-identical to the pre-ADR base prompt
 *   - `friendly`   — collaborative partner register
 *   - `pragmatic`  — terse engineering register
 *   - `codex`      — faithful port of Codex's default personality: concise /
 *                    direct / friendly teammate + the preamble ("Responsiveness")
 *                    discipline (announce grouped tool calls in one brief note).
 *                    Interactive/CLI surfaces only — the persona knob EXCLUDES
 *                    `bench` (preamble chatter has no value to a hidden grader
 *                    and shifts the prefix-cache key / trajectory length).
 *
 * Per-session static by design (ADR-0068 §Rationale): resolved once, baked
 * into the cached base prompt section. Mid-session switching would force a
 * prefix-cache re-prefill on every change, which is out of scope for v1.
 *
 * Each non-default body ends with a single guardrail line that re-binds tone
 * to the honesty/evidence/trust ladders that follow in the base prompt. The
 * guardrail prevents `friendly` from sliding into hedging and `pragmatic`
 * from sliding into curt-and-wrong. The guardrails are part of the body —
 * not optional decoration — and the unit test asserts their presence.
 *
 * Error policy (ADR-0067 §C — Production code conduct, four prohibitions):
 *   - No silent fallback: unknown `QUANTA_PERSONA` ⇒ `PersonaInvalidError`.
 *   - No env access in `buildSystemPrompt`: resolution lives here; the prompt
 *     builder takes a typed `PersonaKind`.
 *   - No heuristic match: the enum is closed, equality-checked.
 */

/** Closed enum of persona kinds. Adding a new persona requires updating
 *  `ALL_PERSONAS`, `PERSONA_PROMPTS`, and `isPersonaKind` together — the
 *  type system makes a partial change a tsc error. */
export type PersonaKind = "default" | "friendly" | "pragmatic" | "codex"

/** Iteration order for the enum (deterministic; used by tests and any
 *  future `/persona` slash command). */
export const ALL_PERSONAS: ReadonlyArray<PersonaKind> = [
  "default",
  "friendly",
  "pragmatic",
  "codex",
] as const

/** Persona body text, indexed by kind. `default` is the empty string so
 *  the rendered prompt is byte-identical to the pre-ADR base prompt — every
 *  existing snapshot test and prefix-cache hit holds. The non-default bodies
 *  end with a guardrail line that re-binds the tone to the honesty/evidence
 *  ladders that follow. */
const PERSONA_PROMPTS: Record<PersonaKind, string> = {
  default: "",
  friendly: [
    "Persona: collaborative partner.",
    'Bring a warm, curious presence to the conversation. Use "we" / "let\'s"',
    "when collaboration is natural; acknowledge progress when the user lands a",
    "step. Stay intellectually engaged — show interest in the user's problem,",
    "not just the task surface. Warmth never overrides the honesty rail below.",
  ].join("\n"),
  pragmatic: [
    "Persona: deeply pragmatic software engineer.",
    "Optimize for the user's actual outcome. No cheerleading, no padding, no",
    '"great question." State conclusions directly, name trade-offs, leave room',
    "for the user to push back. Clarity > Pragmatism > Rigor.",
  ].join("\n"),
  // Faithful port of Codex's default personality + `## Responsiveness /
  // ### Preamble messages` mechanic (openai/codex `codex-rs/core`). Codex's
  // signature is the brief pre-tool-call preamble; quanta had the tonal cue
  // (concise/direct/friendly) via `friendly`/`pragmatic` but NOT the preamble
  // discipline. This register carries both. Prompt-text-only — no new runtime.
  codex: [
    "Persona: Codex-style teammate — concise, direct, and friendly.",
    "You and the user share the same workspace and collaborate toward their",
    "goal; you optimize for team morale and being a supportive teammate as much",
    "as for code quality. Communicate efficiently — keep the user clearly",
    "informed about what you are doing, without unnecessary detail, and always",
    "prioritize actionable guidance over commentary.",
    "Preamble discipline (Responsiveness): before a group of tool calls, send",
    "ONE brief preamble — 1-2 sentences, roughly 8-12 words — that says what you",
    "are about to do and builds on what you already did. Logically group related",
    "actions into a single note rather than one preamble per call; skip it",
    "entirely for a single trivial read (e.g. reading one file). Keep the tone",
    "light and curious, never verbose.",
    "Warmth and momentum never override the honesty rail below: no success word",
    "without its command + exit + output, and never announce work you did not do.",
  ].join("\n"),
}

/** Render the persona body for `buildSystemPrompt` to splice between the
 *  agent intro and the Policy stack. Returns the body text WITHOUT a
 *  trailing newline (the caller controls separation via array `join`).
 *  `default` returns `""` — the caller should drop the empty entry from
 *  the rendered prompt entirely (spread the result of {@link personaLines}
 *  instead of calling this directly for that pattern). */
export const renderPersonaBlock = (persona: PersonaKind): string => PERSONA_PROMPTS[persona]

/** Helper for the `buildSystemPrompt` array literal: returns the lines to
 *  spread BETWEEN the intro section and the Policy stack. For `default`,
 *  returns an empty array (no extra lines, no extra newlines). For the
 *  other personas, returns `[body, ""]` so the persona block is followed
 *  by one blank line before "Policy stack:" — matching the rest of the
 *  prompt's section separators. */
export const personaLines = (persona: PersonaKind): readonly string[] => {
  const body = renderPersonaBlock(persona)
  return body === "" ? [] : [body, ""]
}

/** Type guard for the closed enum. Used by `resolvePersona` and any future
 *  RPC or slash-command parser. */
export const isPersonaKind = (s: unknown): s is PersonaKind =>
  s === "default" || s === "friendly" || s === "pragmatic" || s === "codex"

/** Thrown by {@link resolvePersona} when `QUANTA_PERSONA` is set to a value
 *  outside the closed enum. No silent fallback (ADR-0067 §C). */
export class PersonaInvalidError extends Error {
  public readonly received: string
  constructor(received: string) {
    super(
      `QUANTA_PERSONA must be one of: ${ALL_PERSONAS.join(" | ")}. Got: ${JSON.stringify(received)}`,
    )
    this.name = "PersonaInvalidError"
    this.received = received
  }
}

/** Resolve the persona from a `process.env`-shaped object. Absent ⇒
 *  `"default"` (the explicit choice, not a heuristic). Unknown ⇒ throw
 *  {@link PersonaInvalidError} — no silent fallback. */
export const resolvePersona = (env: NodeJS.ProcessEnv): PersonaKind => {
  const raw = env.QUANTA_PERSONA
  if (raw === undefined) return "default"
  if (isPersonaKind(raw)) return raw
  throw new PersonaInvalidError(raw)
}
