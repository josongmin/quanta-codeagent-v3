# ADR-0465 — AFK away-summary: <40-word recap on user return

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF feature slice (`@/agent/away-summary`).
**Scope:** new files under `src/agent/away-summary/` (`types.ts`, `port.ts`,
`runner.ts`, `index.ts`) + the hellgate `tests/unit/away-summary-hellgate.test.ts`
+ this ADR + the feature-catalog yaml. NO shared files edited.
**Default-OFF:** `QUANTA_ENABLE_AWAY_SUMMARY` unset (or any value other than
`"1"`) ⇒ `runAwaySummary` returns `{kind:"skip",reason:{kind:"gate-off"}}`
WITHOUT consulting the summarizer — zero LLM calls, nothing rendered:
byte-identical to today. Mirrors Claude Code's `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`.

## Context

Claude Code 2.1.150 ships an "away-summary": when the user steps away from an
in-progress session and returns, the CLI prints a tiny recap so they can
re-orient without re-reading the transcript. The implementation shape (observed
faithfully):

- an **isolated single-turn query** (`maxTurns: 1`),
- with **ALL tools denied**,
- `skipTranscript` + `skipCacheWrite` (the recap query does not pollute the
  session transcript or the prompt cache),
- gated behind an env flag (default OFF),
- a **verbatim system prompt** instructing a <40-word, 1-2 plain-sentence,
  no-markdown recap that leads with the goal + current task then the one next
  action, and skips root-cause narrative / fix internals / secondary to-dos /
  em-dash tangents.

`@/agent` is the only slice allowed to cross slices, but per the port-inversion
discipline (ARCHITECTURE §1) a leaf behavior should not reach "up" or sideways
into `@/llm` when an injected callback suffices. The away-summary is exactly a
leaf: it owns a prompt constant, a gate, an activity guard, and an orchestration
— the LLM call is the only external concern, and it is the SAME inversion shape
as `@/permission`'s `ClassifierPort`.

## Decision

Ship `src/agent/away-summary/` as a self-contained slice that imports **only**
`@/shared`. The LLM is injected as a `SummarizeFn` port; the slice never imports
`@/llm`.

1. **`SummarizeFn` port (port.ts)** — `({system, transcript, signal}) =>
   Promise<Result<string>>`. The composition root builds the real impl over
   `LLMPort` with tools denied, `maxTurns: 1`, `skipTranscript`,
   `skipCacheWrite`, then injects it. NO-THROW: transport/abort/refusal resolve
   `Err`, never reject.

2. **`AWAY_SUMMARY_SYSTEM_PROMPT` (port.ts)** — the verbatim Claude prompt. Its
   fidelity is load-bearing; the slice passes it as the system message and the
   adapter MUST use it unchanged.

3. **Gate (`awaySummaryEnabled`, runner.ts)** — strict `env["QUANTA_ENABLE_AWAY_SUMMARY"]
   === "1"`. Strict equality so `"0"`/`"on"`/`"true"`/`" 1"` keep the feature
   OFF (single documented opt-in value, matching Claude's flag semantics). Reads
   the **injected** env record, never `process.env` (slice-boundary invariant).

4. **Activity guard (`shouldEmit`, runner.ts)** — emit only when the transcript
   has **≥1 prior assistant turn with non-blank content**. This is the minimal
   closed-form evidence that the agent actually did something to recap; it is
   NOT a magic threshold (it is "there exists real assistant output"). A fresh
   conversation, a user-only transcript (stepped away before any response), or a
   transcript of only blank/tool-flattened assistant turns all skip with
   `no-activity`.

5. **Runner (`runAwaySummary`, runner.ts)** — guards in cheap-first order so the
   OFF / no-activity / pre-aborted paths make ZERO LLM calls:
   gate-off → aborted (pre) → no-activity → call summarizer once →
   `Err` ⇒ `summarizer-error` (or `aborted` when the signal is the cause) →
   blank text ⇒ `empty-recap` → else `{kind:"ok",text}` (trimmed).
   Returns `Result`-shaped `AwaySummaryOutcome` (`ok`|`skip`); NEVER throws.

6. **`RecapTurn` projection (types.ts)** — the slice sees a minimal
   `{role,text}` projection, NOT the `@/llm` `Message` shape, so it stays
   decoupled from the wire format. The composition root maps the live transcript
   down to `RecapTurn[]`.

### Tools-denied enforcement (how the slice contributes)

The slice owns **no tool surface**: `runAwaySummary` hands the `SummarizeFn`
ONLY `{system, transcript, signal}` — there is no `tools`/`toolChoice` field by
which a tool could leak from here. The hard tool-denial is the adapter's job
(`maxTurns:1` + empty tool set at the composition root); the slice's
contribution is that it never provides a tool surface to deny. HELLGATE pins
that the args object has exactly those three keys.

## Default-OFF / byte-identical proof

- `QUANTA_ENABLE_AWAY_SUMMARY` unset ⇒ `awaySummaryEnabled` is `false` ⇒
  `runAwaySummary` returns `gate-off` BEFORE `summarize(...)` is referenced.
  The summarizer (and therefore any LLM call) is never invoked. No CLI render
  wiring is added in this slice, so an un-integrated deployment is unchanged.
- HELLGATE "GATE-OFF → skip + summarizer NEVER called" is the regression anchor.

## Consequences

- One isolated, tools-denied, single-turn LLM call per on-return event WHEN the
  flag is set, the conversation has activity, and the signal is live. Otherwise
  zero calls.
- The recap text and skip reasons are typed; the CLI branches exhaustively and
  stays silent on any skip (never renders a half-recap).
- `describeSkip` is a no-throw exhaustive narrator (compile-time closed via a
  `never` binding) for optional `--debug` logging.

## Negative invariants

- The slice MUST NOT import `@/llm` / `@/tool` / `@/permission` / `@/apps` — the
  LLM is the injected `SummarizeFn` only.
- The slice MUST NOT read `process.env` — env arrives injected on the request.
- The away-summary MUST NOT write to the session transcript or the prompt cache
  — enforced by the adapter (`skipTranscript`/`skipCacheWrite`); the slice
  passes nothing that would.
- The recap MUST NOT run with any tool available — the slice provides no tool
  surface; the adapter denies tools + caps `maxTurns:1`.
- `shouldEmit` MUST NOT fire on a fresh/empty conversation (no assistant
  activity) — recapping nothing is noise.
- The system prompt is VERBATIM — do not paraphrase.

## Honest deferred (integration TODOs — human applies at integration)

These touch shared files this slice is fenced from editing:

1. **SummarizeFn adapter** — in a composition surface (`src/apps/agent/**` or a
   `src/runner/assemble/**` helper), build `SummarizeFn` over `LLMPort` with an
   empty tool set, `maxTurns:1`, `skipTranscript:true`, `skipCacheWrite:true`,
   shaping `RecapTurn[]` into a single user message. NO-THROW: wrap the call so
   transport/abort/refusal resolve `Err`.
2. **On-return trigger** — in the CLI REPL (`src/apps/cli/repl/**`), detect the
   user's return after an idle/AFK gap and call `runAwaySummary(summarize,
   {transcript: mapToRecapTurns(history), env: process.env, signal})`. (The
   idle-detection mechanism is the surface's; this slice only consumes the
   resulting transcript + env.)
3. **Render** — on `{kind:"ok",text}` print the recap (plain, no markdown box);
   on `{kind:"skip"}` render nothing (optionally `describeSkip(outcome)` under
   `--debug`).
