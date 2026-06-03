# ADR-0467 — Prompt-suggestion + quality reject-gate

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF library slice (`@/agent/prompt-suggestion`).
**Scope:** five new files under `src/agent/prompt-suggestion/` + one hellgate
test + this ADR + one feature-catalog yaml. NO shared file edited.
**Default-OFF:** gated on `QUANTA_ENABLE_PROMPT_SUGGESTION === "1"` (mirrors
Claude's `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`). Unset ⇒ the orchestrator
returns `{kind:"suppress", reason:"gate_off"}` WITHOUT ever calling the injected
`SuggestFn` — zero LLM calls, nothing rendered: byte-identical to today.

## Context

Claude Code 2.1.150 suggests "what the user might naturally type next" after a
turn. The *generation* (a one-shot LLM call) is the cheap part. The real value
is the **reject gate** (`GZ8` in the CLI bundle): a rich, ordered chain of pure
predicates that throws away bad model output BEFORE it is shown — empty,
meta-commentary, error echoes, label prefixes, too-short/long, multi-sentence,
formatted, evaluative, or written in the assistant's own voice. Showing any of
those would be worse than showing nothing.

We absorb the gate verbatim (regexes + word lists transcribed 1:1 from
`.extracted_source/claude-code-cli/_cli-symbols.txt`) because the wording is
load-bearing — it encodes a lot of taste about what a "good next prompt" looks
like. Around it we add the slice plumbing quanta needs: a closed `RejectReason`
enum, a port-inverted model call, a typed suppression-context guard, and a
no-throw `Result`-shaped orchestrator.

## Decision

A pure, reusable slice under `@/agent` (imports ONLY `@/shared`):

1. **`types.ts`** — the **closed `RejectReason` enum** (the crown jewel; each
   member is one predicate), `REJECT_REASONS` (the ordered list), the
   `SHORT_COMMAND_WHITELIST`, the documented `SUGGESTION_LIMITS` constants
   (minWords 2 / maxWords 12 / maxChars 100 — the competitor's exact numbers,
   pinned with provenance, NOT invented thresholds), the typed `AppStateView`
   for suppression, the `SuggestFn` injected port, and the outcome union.

2. **`reject-gate.ts`** — `rejectGate(string) → RejectVerdict`. A
   `Record<RejectReason, Predicate>` table evaluated in `REJECT_REASONS` order;
   first match wins (mirrors the competitor's short-circuit array). PURE &
   TOTAL — never throws, robust to empty / whitespace / unicode / pathological
   length. `describeReason` is an `assertNever`-guarded exhaustive switch so a
   new reason cannot be added without a description.

3. **`sanitize.ts`** — `sanitizeSuggestion(raw) → string`. Strips a matched (or
   lone) `<suggestion>` tag, one short leading `Label:` prefix, and one layer of
   surrounding quotes/backticks, so the gate sees the bare candidate. The label
   strip is deliberately conservative (1–3 leading words only); anything longer
   is left for the gate's own `prefixed_label` predicate.

4. **`suppression.ts`** — `suppressionReason(AppStateView) → SuppressReason |
   null`. Pure guard, fixed precedence: plan_mode → rate_limited →
   elicitation_active → pending_permission. Any hit ⇒ no model call at all.

5. **`orchestrator.ts`** — `runPromptSuggestion(suggest, req) →
   Result<SuggestionOutcome>`. Guard order: gate-OFF → suppression-context →
   pre-aborted signal → (the ONLY model call) → sanitize → reject gate. A
   throwing/rejecting/`undefined` `SuggestFn` degrades to
   `suppress no_output` — the honest "show nothing" path, never a throw. Also
   exports the `SUGGESTION_MODE_SYSTEM_PROMPT` (single source of truth for the
   dedicated tools-denied call) and `promptSuggestionEnabled(env)`.

### Why port inversion for the model call

`@/agent/prompt-suggestion` must not import `@/llm`. The generation is the
injected `SuggestFn` (built at the composition root from an LLM call with ALL
tools denied). This keeps the slice pure and unit-testable with a scripted
double — exactly the `Phase2Summarizer` / `ClassifierPort` pattern.

## Default-OFF / byte-identical proof

- `promptSuggestionEnabled(env)` is strict `=== "1"`; `"0"`/`"true"`/`"on"`/
  absent all keep it OFF.
- OFF ⇒ `runPromptSuggestion` returns `suppress gate_off` on the FIRST line,
  before `suggest` is referenced. Hellgate asserts the `SuggestFn` spy records
  ZERO calls in this path.
- Nothing in `@/apps` imports the barrel today, so the slice is dead code until
  the human wires it (see integration TODOs). Importing it changes nothing
  until both the adapter is wired AND the env flag is set.

## Consequences

- A reusable quality filter (`rejectGate`) any future "propose text to the user"
  feature can call — the enum is closed and exhaustively tested.
- One extra LLM call per turn ONLY when the flag is set AND no suppression
  context holds AND the signal is live. Otherwise zero calls.

## Negative invariants

- The slice MUST NOT import `@/llm` / `@/tool` / `@/permission` / `@/mcp` — the
  model call is the injected `SuggestFn`, the surface state is `AppStateView`.
- `rejectGate` MUST stay PURE and TOTAL — no IO, no env read, no clock, no
  throw. The thresholds live in `SUGGESTION_LIMITS` with provenance; do NOT
  introduce a new magic number.
- A suggestion is shown ONLY when it passes the gate AND no suppression context
  holds AND the flag is on. "Show nothing" is always the safe default; a
  failure of any kind degrades to suppress, never to a thrown error or a
  half-formed suggestion.
- The model is consulted AT MOST ONCE per `runPromptSuggestion` call, and ONLY
  after every cheap pure guard has passed.

## Test

`tests/unit/prompt-suggestion-hellgate.test.ts` — 48 cases: one adversarial trip
per reject reason + an orphan-member completeness assertion; the whitelist +
slash escape + boundary (exactly 2 / 12 words); first-match ordering;
`describeReason` totality; the sanitizer (tag/label/quote strip, empty-pair,
non-mangling, pathological-input no-throw); the suppression precedence; and the
orchestrator (gate-off zero-call, suppression zero-call, pre-abort zero-call,
happy-path show, rejected, undefined, throwing degrade, blank degrade).

## Honest deferred / integration TODOs

These touch shared files this slice is fenced out of — the human applies them:

- **No CLI surface.** A REPL hook that calls `runPromptSuggestion` after a turn
  and renders the `show` text as ghost-input lives in `src/apps/cli/**`.
- **No `SuggestFn` adapter wired.** The composition root (`src/apps/agent/**`)
  must build the tools-denied SUGGESTION-MODE call from
  `SUGGESTION_MODE_SYSTEM_PROMPT` and pass it in.
- **No env flag read at the root.** `src/apps/agent/cli-args.ts` /
  `src/apps/agent/index.ts` should surface `QUANTA_ENABLE_PROMPT_SUGGESTION`.

ADR-number note: 0466 was the highest existing decision number when this slice
was authored; 0467 is the next free number.
