/**
 * §5 PROMPT-LEVEL DIRECTIVE BUNDLE (jun-06).
 *
 * A bundle of seven cheap, high-value behavioral PROMPT DIRECTIVES, each an
 * independent DEFAULT-OFF gated section. They mirror the C3 brief-mode mechanism
 * (`./brief.ts` + `BRIEF_NOTICE` in `./prompt-body.ts`): each directive's text is
 * spliced into the per-turn DYNAMIC `<system-reminder>` slot by
 * `buildDynamicContext` (`./prompt.ts`) ONLY when its knob is ON — never into the
 * static cached prefix. So:
 *   - flipping any knob never perturbs the provider cache prefix, and
 *   - all knobs unset ⇒ this module contributes ZERO bytes ⇒ the per-turn
 *     reminder is byte-for-bit identical to the pre-bundle output (the headline
 *     safety invariant, proven by the all-OFF golden test).
 *
 * Each directive is a CONSTANT string (no `Date.now`/`Math.random`/`process.env`
 * here — the texts are static). The selector {@link selectActiveDirectives} is a
 * PURE function of a small config slice ({@link DirectiveConfig}): it returns the
 * active-directive texts concatenated in a STABLE, source-declared order
 * (`DIRECTIVE_ORDER`), or the empty string when none are active. The loop layer
 * (`./prompt.ts`) resolves the config slice from `runtimeConfig()` — the texts and
 * the selection are kept pure/injected so the bundle is fully testable without env.
 *
 * Defang safety: like `BRIEF_NOTICE`, every directive text is a plain
 * newline-joined string and carries NO `<system-reminder>` tokens, so it survives
 * the outer `embedUntrusted` wrap unchanged.
 *
 * Authority: these are BEHAVIORAL nudges layered BELOW the static correctness
 * rails (`BODY_AFTER_PROMPT_PACK`). They never relax verification, error
 * reporting, the honesty/claim ladder, or file:line evidence.
 */

/** 1. Autonomous-loop preamble (`QUANTA_DIRECTIVE_AUTONOMOUS`). Behavior guidance
 *  for unattended / automation ticks: when running headless with no human to ask,
 *  bias to SAFE forward progress, do not block on a question, checkpoint often. */
export const AUTONOMOUS_PREAMBLE: string = [
  "AUTONOMOUS MODE: you are running unattended (no human is watching this tick).",
  "Bias to safe forward progress instead of stopping to ask. When a choice is",
  "reversible and low-risk, make the conservative call and proceed; record the",
  "assumption so it can be reviewed later. Reserve hard stops for genuinely",
  "irreversible or destructive actions. Checkpoint progress frequently (commit",
  "intent, write state) so an interrupted run resumes cleanly. Do NOT invent",
  "requirements or fabricate results to appear finished — if blocked, stop and",
  "report the blocker precisely rather than guessing.",
].join("\n")

/** 2. Read-completeness (`QUANTA_DIRECTIVE_READ_COMPLETE`). When reading a large
 *  file, read it COMPLETELY before concluding — do not truncate-and-guess. */
export const READ_COMPLETENESS: string = [
  "READ COMPLETENESS: before drawing a conclusion about a file's behavior, read",
  "the RELEVANT span in full — do not stop at the first screenful and guess at",
  "the rest. If a file is large, page through it (offset/limit) until you have",
  "seen every part your conclusion depends on. Truncate-and-guess is a defect:",
  "an unread branch, guard, or late override can invert your answer. State what",
  "you actually read, and flag any region you did NOT read as UNKNOWN.",
].join("\n")

/** 3. Progress-narration discipline (`QUANTA_DIRECTIVE_PROGRESS`). Text-output /
 *  narration rules: concise status, no filler. */
export const PROGRESS_NARRATION: string = [
  "PROGRESS NARRATION: keep status updates concise and information-dense. State",
  "what you are about to do or just did in one tight line — no preamble, no",
  "restating the request, no play-by-play of routine tool calls. Narrate only",
  "what advances the task or what the reader could not otherwise infer. This",
  "shapes narration ONLY; it never suppresses error reports, the verification",
  "block, or file:line evidence.",
].join("\n")

/** 4. Memory-drift verify-before-trust (`QUANTA_DIRECTIVE_MEMORY_VERIFY`). Before
 *  acting on a recalled memory that names a file/symbol/flag, VERIFY it still
 *  exists in the current code. */
export const MEMORY_VERIFY: string = [
  "MEMORY VERIFY: a recalled memory is a HINT, not ground truth. Before acting on",
  "a memory that names a file path, symbol, flag, or line number, VERIFY it still",
  "exists in the CURRENT code (read/grep/glob it) — code drifts and memories go",
  "stale. If the named thing is gone or moved, trust the live code, not the",
  "memory, and proceed from what you actually find. Never cite a remembered",
  "file:line as evidence without re-confirming it now.",
].join("\n")

/** 5. Thinking-frequency self-regulation (`QUANTA_DIRECTIVE_THINK_FREQ`).
 *  Self-regulate thinking depth to task complexity. */
export const THINK_FREQUENCY: string = [
  "THINKING BUDGET: match reasoning depth to the task. Spend deliberate thought",
  "on genuinely hard or ambiguous steps — design choices, tricky invariants,",
  "conflicting signals — and move quickly on mechanical or already-decided ones.",
  "Do not over-deliberate the obvious, and do not under-think a load-bearing",
  "decision. Re-think when new evidence contradicts your current plan.",
].join("\n")

/** 6. Anti-platitude voice (`QUANTA_DIRECTIVE_ANTI_PLATITUDE`). No empty
 *  affirmations / filler praise; substance only. */
export const ANTI_PLATITUDE: string = [
  "VOICE: substance only. No empty affirmations, no filler praise, no",
  "'Great question!' / 'You're absolutely right!' preambles, no congratulatory",
  "padding. Lead with the answer or the finding. Disagree plainly when the",
  "evidence warrants it — agreement is earned, not default. Honesty about",
  "uncertainty and limits beats reassuring noise.",
].join("\n")

/** 7. Parallel tool-call nudge (`QUANTA_DIRECTIVE_PARALLEL_TOOLS`). When
 *  independent, batch tool calls in one turn. */
export const PARALLEL_TOOLS: string = [
  "PARALLEL TOOLS: when multiple tool calls are INDEPENDENT (no call depends on",
  "another's output), issue them together in a SINGLE turn rather than one at a",
  "time — batched independent reads/searches are faster and cheaper. Keep calls",
  "sequential only when there is a real data dependency, and never parallelize",
  "writes to the same file.",
].join("\n")

/** 8. Advisor timing rail (RFC jun-6 §5.2 — `QUANTA_ADVISOR_RAIL`). Tells the
 *  model the two canonical moments to consult the read-only `advisor` second
 *  opinion (cc-cli parity). Harmless prose when no advisor tool is wired. */
export const ADVISOR_TIMING_RAIL: string = [
  "ADVISOR: when the `advisor` tool is available, consult it at two moments:",
  "once BEFORE committing to a non-trivial approach (to pressure-test the plan),",
  "and once BEFORE declaring the task done (to catch what you missed). It is a",
  "read-only second opinion — it cannot act, so it is cheap to ask and safe to",
  "ignore. Pass forwardHistory:true to have it review your whole task in context.",
].join("\n")

/** 9. code_mode_only (RFC jun-6-code-mode §2.1 / Phase 3 — `QUANTA_CODE_MODE_ONLY`).
 *  Steers the model to drive ALL multi-step work through the `code_cell` program
 *  interface instead of one-tool-per-turn. The Codex `code_mode_only` analog: the
 *  cell is the PRIMARY tool-calling surface. Each in-cell `tools.X(args)` is STILL
 *  gated EXACTLY like a direct call (permission / HARD_DENY / plan-mode all apply
 *  per call), so this changes the model's CALLING STYLE, never the security
 *  posture. Harmless prose when `code_cell` is not wired (the model simply has no
 *  cell tool to reach for, and the static rails still govern). */
export const CODE_MODE_ONLY_DIRECTIVE: string = [
  "CODE MODE: prefer the `code_cell` tool as your PRIMARY way to call tools. When",
  "a task needs more than one tool call — read several files, branch on what you",
  "find, fan out a search, then write a result — author ONE `code_cell` JS program",
  "that does the whole sequence (`await tools.read(...)`, loops/conditionals over",
  "the results, `await tools.write(...)`, then `return` a JSON value) instead of",
  "emitting tool calls one per turn. Each `tools.X(...)` inside the cell is gated",
  "EXACTLY like a direct call (permission, HARD_DENY, and plan-mode all apply per",
  "call) — the cell is N ordinary gated calls, just expressed as one program. Use a",
  "single direct tool call only for a genuinely one-shot action; collapse anything",
  "multi-step into a cell. The cell is sandboxed: only `tools.*` — no require/fetch/",
  "process/filesystem/network.",
].join("\n")

/**
 * The config slice {@link selectActiveDirectives} reads. A flat record of the
 * knob booleans — supplied by the loop layer from `runtimeConfig()`. Kept as a
 * narrow shape (not the whole RuntimeConfig) so the selector stays a pure,
 * trivially-testable function with no env coupling.
 */
export interface DirectiveConfig {
  readonly directiveAutonomous: boolean
  readonly directiveReadComplete: boolean
  readonly directiveProgress: boolean
  readonly directiveMemoryVerify: boolean
  readonly directiveThinkFreq: boolean
  readonly directiveAntiPlatitude: boolean
  readonly directiveParallelTools: boolean
  readonly directiveAdvisorRail: boolean
  /** RFC jun-6-code-mode Phase 3 — `code_mode_only` steering (`QUANTA_CODE_MODE_ONLY`).
   *  Default false ⇒ zero bytes ⇒ byte-identical. */
  readonly codeModeOnly: boolean
}

/**
 * STABLE, source-declared selection order. Determinism is load-bearing: when
 * multiple knobs are ON the directives must concatenate in a fixed order (no
 * `Math.random`, no Set-iteration ambiguity). This is the single source of truth
 * for both ordering and the knob→text mapping.
 */
const DIRECTIVE_ORDER: ReadonlyArray<{
  readonly key: keyof DirectiveConfig
  readonly text: string
}> = [
  { key: "directiveAutonomous", text: AUTONOMOUS_PREAMBLE },
  { key: "directiveReadComplete", text: READ_COMPLETENESS },
  { key: "directiveProgress", text: PROGRESS_NARRATION },
  { key: "directiveMemoryVerify", text: MEMORY_VERIFY },
  { key: "directiveThinkFreq", text: THINK_FREQUENCY },
  { key: "directiveAntiPlatitude", text: ANTI_PLATITUDE },
  { key: "directiveParallelTools", text: PARALLEL_TOOLS },
  { key: "directiveAdvisorRail", text: ADVISOR_TIMING_RAIL },
  { key: "codeModeOnly", text: CODE_MODE_ONLY_DIRECTIVE },
]

/**
 * Pure selector: return the active directive texts joined by a blank line, in
 * {@link DIRECTIVE_ORDER}. Returns the EMPTY STRING when no knob is on — the
 * caller uses that to push NOTHING, preserving byte-identical default-OFF.
 *
 * Pure: depends only on `config`. No `Date.now`/`Math.random`/`process.env`.
 */
export const selectActiveDirectives = (config: DirectiveConfig): string => {
  const active: string[] = []
  for (const { key, text } of DIRECTIVE_ORDER) {
    if (config[key] === true) active.push(text)
  }
  return active.join("\n\n")
}
