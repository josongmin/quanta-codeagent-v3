# ADR-0271: `/why <toolCallId|last>` — meta-LLM reasoning query for a recorded tool call

## Context

ADR-0239 added the `/debug` runtime tracer (single-line per-event) and ADR-0267 widened decision-emit so that every gate (`permission` / `rule` / `hook` / `cap` / `jail` / `budget`) writes a decision envelope to the session JSONL alongside the existing `tool_invoke` / `tool_result` events. The follow-up `/inspect <toolCallId>` surface re-reads those envelopes and renders a multi-section panel showing **what** happened: tool name, input, gate decisions, output.

Users still cannot answer the more important question — **why** did the agent make that call?

- Earlier message asked something specific?
- Why pick `Read` over `Bash grep`?
- Why stop on line N?
- Did the agent consider alternatives?

The recorded facts alone do not answer this. The model's reasoning is not stored on disk (extended-thinking blocks survive only the turn that produced them). We need to issue **one additional LLM call** to introspect the recorded record and emit a reasoning chain.

## Decision

Ship `/why <toolCallId | last>` as a default-OFF CLI slash command (`src/apps/cli/why-cmd.ts`) that:

1. **Resolves the target** — explicit `toolCallId` or `last` (most-recent decision / custom tool-call id, scanning envelopes newest-first).
2. **Builds a sanitised meta-query** containing:
   - turn id,
   - the LAST 3 preceding user/assistant snippets (each capped to 600 chars),
   - the tool name + redacted input,
   - decision rows (gate=outcome 'reason' [rule_id, hook_name]),
   - the most-recent tool result summary (status + 200-char preview).
3. **Issues ONE LLM call** through the active `LLMPort` with a fixed system prompt asking for JSON of shape:
   ```
   {goal: string, reasoning: [string], alternatives_considered: [string], confidence: 'high'|'medium'|'low'}
   ```
4. **Renders a panel** — header (model, elapsed, tokens), `goal`, numbered `reasoning`, bulleted `considered`, `confidence`. Markdown-fence-wrapped JSON is unwrapped before parsing.
5. **Fails soft** — JSON parse failure ⇒ "(LLM returned unstructured prose)" fallback panel with raw text. LLM throw ⇒ exit 1 + `meta query failed: <reason>`.

Wired into the REPL surface via `BuildReplSlashCtxArgs.{llm, sessionId, model}` ⇒ `WhySlashState` ⇒ `SlashContext.why`. One-shot / shell surfaces that lack an LLMPort omit the slot ⇒ slash prints "not wired in this surface" + exit 0 (parity with the rest of the surface-only commands).

## Invariants

- **One LLM call per invocation.** No caching layer; callers who want memoisation wrap. The rendered header always tells the user how many tokens were consumed.
- **Secret/PII sanitisation BEFORE the wire.** Every payload (preceding snippets, tool input, decision metadata) passes through `redactValue` (shared trajectory redactor) — Bearer tokens, `sk-…` keys, `Authorization` / `apiKey` / `email` / canonical PII keys never leave the host.
- **Context cap.** Only the LAST 3 message snippets reach the LLM; each is truncated to ~600 chars. The full session is never shipped.
- **JSON parse failure does NOT throw.** The fallback path is well-trodden — model misbehaviour degrades gracefully.
- **Meta-query isolated from the live conversation.** The `/why` LLM call uses a private one-shot `Message[]` (single user prompt + private system prompt). It never mutates the active session JSONL or the prompt history — Phase 2's recorded facts vs the model's *meta* reasoning stay distinct.

## Posture

- **Default-OFF in the BUILTIN registry** via the `ctx.why === undefined` "not wired" branch. The REPL surface wires it automatically once `LLMPort` + `sessionId` + `model` are resolved.
- **Slice-clean.** `src/apps/cli/why-cmd.ts` imports `@/llm` (LLMPort + assembleFromEvents + StreamEvent), `@/session` (envelope types), `@/session/inspect-source` (findByToolCallId — reused with `/inspect`), and `@/shared` (redactValue). No `@/agent` reach-through.

## ENV knobs

None. The cost is one LLM call per invocation; further policy (sample rate, model override, max tokens) is left to future ADRs once on-the-ground usage signals a need.

## Test pin

`tests/unit/cli/why-cmd-hellgate.test.ts` — 21 adversarial cases pinning:
- argument resolution (`last`, explicit, unknown, empty, no-session),
- LLM response parsing (clean JSON, invalid JSON fallback, markdown fences, LLM throw, low confidence, long reasoning lists),
- output shaping (ANSI off, long goal truncation, tokens-used accounting),
- prompt cap (only last 3 preceding messages reach the LLM, secret-shape values redacted on the wire),
- helper white-box (`stripFences`, `parseReasoning`, unknown-confidence coercion).
