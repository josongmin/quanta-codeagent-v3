# ADR-0319 — Cache-control thread-stability audit

Status: Accepted
Date: 2026-05-27

## Context

Codex hard-pins server-side prompt-cache identity by passing
`prompt_cache_key = thread_id` on every request
(`codex-rs/core/src/client.rs:751`, per the audit charter). Anthropic's
Messages API offers no equivalent key — its prompt cache is decided by
hashing the prefix bytes up to (and including) the block carrying the
`cache_control: { type: "ephemeral" }` marker. A single drifting byte
between turns of the same thread invalidates the cache and pushes those
tokens back to standard input rate.

Quanta routes dynamic per-turn context (date, cwd, plan-mode notice,
memory recall, working state) through a trailing
`<system-reminder>` user message so the cached system prefix is never
disturbed (`src/agent/prompt.ts:22-31`, comment on the cache lever).
Nothing in our codebase had verified that the discipline actually held
end-to-end; the worry was that some downstream caller might have folded
dynamic data into the cached prefix without anyone noticing.

This ADR records the audit finding + ships a passive audit primitive
the bench / future regression suites can use to lock the invariant.

## Audit method

Read-only inspection of the call chain that produces an Anthropic
request:

1. `src/agent/prompt.ts` — `buildSystemPrompt()` (lines 40-70) +
   `buildTurnContext()` (lines 397-441).
2. `src/agent/prompt-sections.ts` — 4-section preset
   (`fourSectionPreset`, lines 113-149) + `MAX_CACHE_BREAKPOINTS = 4`
   (line 25).
3. `src/agent/prompt-body.ts`, `src/agent/persona.ts`,
   `src/agent/identity.ts` — searched for `Date`, `now`, `random`,
   `timestamp`, `uuid`. None present in any static prompt source.
4. `src/llm/adapters/anthropic.ts` — `toAnthropicSystem()`
   (lines 200-207, attaches `cache_control: ephemeral` only when the
   `SystemBlock.cache` flag is set) + `cacheConversationPrefix()`
   (lines 227-248, attaches a SECOND ephemeral marker on the LAST text
   block of the LAST message).
5. `src/agent/loop.ts` — `runTurn` (around line 950) feeds
   `buildTurnContext` with `config.system` (static), `repoRules`,
   `sessionCtx`, and routes the date through `now` for replay
   determinism (`prompt.ts:293-294`).

## Findings — Case C (already stable)

The cached prefix is byte-stable across turns of the same session by
construction:

- **Static system blocks**: `buildSystemPrompt()` composes intro lines,
  persona body, prompt-pack rules, and identity slot from compile-time
  string arrays. No clock read, no random source, no per-turn input —
  the only inputs are `opts.persona`, `opts.promptPack`,
  `opts.identity`, all session-static.
  (`src/agent/prompt.ts:40-70`)

- **`cache:true` marker placement**: legacy path emits one block
  `{ type:"text", text:basePrompt, cache:true }`
  (`prompt.ts:423`). Sectioned path emits 1..4 blocks via
  `buildSectionedSystemBlocks` (`prompt-sections.ts:40-45`), each
  flagged `cache:true` and capped at `MAX_CACHE_BREAKPOINTS = 4`
  (`prompt-sections.ts:25`) — Anthropic's limit.

- **Adapter mapping**: `toAnthropicSystem` writes the
  `cache_control: { type: "ephemeral" }` field only when `b.cache` is
  truthy (`anthropic.ts:205`). Order is preserved, no synthetic blocks
  injected.

- **Conversation-prefix breakpoint**: `cacheConversationPrefix`
  attaches a second ephemeral marker on the LAST text block of the
  LAST message (`anthropic.ts:227-248`). That last message is the
  trailing `<system-reminder>` — which is EXPECTED to drift turn over
  turn (date, mode notice, hook context, memory snapshot). The
  breakpoint sits on the tail BECAUSE the tail drifts: it lets the
  conversation prefix (everything before the tail) be cached on the
  next turn even when the tail changes.

- **Date drift**: `todayDateLine` reads
  `(opts.now ?? Date.now)()` (`prompt.ts:293-294`) and the line is
  appended INSIDE `buildDynamicContext` (`prompt.ts:358-387`), which
  in turn is wrapped via `embedUntrusted("system-reminder", ...)` and
  pushed as a `role:"user"` message (`prompt.ts:435-438`). The date
  never enters the cached `system` array.

- **Hook injects**: `hookPromptInjects[].injectAfterSystem` is appended
  to the dynamic block tail (`prompt.ts:320-327`), and
  `injectBeforeUser` rides as a separate user-side message
  (`prompt.ts:334-344`). Neither path mutates the static system.

No drift hazards found in the cached prefix path.

## Decision

1. Add a passive audit primitive — `src/llm/cache-control-audit/` —
   that future callers (bench replay recorder, regression suite) can
   use to capture per-turn snapshots and assert prefix byte-stability.
   The primitive is default-OFF: nothing in production code
   instantiates the analyzer.

2. Record this audit's finding (Case C — already stable) as the
   baseline. Future drift will be detected by wiring `analyzePrefixStability`
   to bench replay traces (follow-up, not in this slice).

3. Keep the static prompt sources locked: no per-turn data may be
   folded into `buildSystemPrompt`, `INTRO_LINES`, persona, identity,
   or prompt-pack bodies. The trailing `<system-reminder>` is the ONLY
   sanctioned channel for per-turn drift.

## Non-goals

- This ADR does NOT change any production code path. The audit slice
  is read-only diagnostic infrastructure.
- This ADR does NOT wire the analyzer into the loop or bench. Wiring
  is a follow-up (a bench-side recorder collecting snapshots from
  `buildTurnContext` output, plus a regression test on the replay
  corpus).
- This ADR does NOT add a `prompt_cache_key`-style server-side handle —
  Anthropic does not expose one; the byte-stability discipline is the
  enforcement mechanism we have.

## Implementation

New files under `src/llm/cache-control-audit/`:

- `types.ts` — `CachePrefixSnapshot`, `DriftFinding`, `DriftKind`,
  `PositionReport`, `StabilityReport`.
- `hash.ts` — `sha256Hex(content)` via `node:crypto` (no external lib).
- `analyzer.ts` — `analyzePrefixStability(batches)` — returns a
  conservative report (any drift ⇒ unstable; per-position rollup +
  per-finding samples).
- `index.ts` — barrel re-export.

Hellgate at `tests/unit/llm/cache-control-audit-hellgate.test.ts`:
9 cases covering identical prefix (5 batches), 1-byte content drift,
marker-drop detection, empty input, simulated date-drift,
4-breakpoint independence, 100 KB hash determinism, missing-position
detection, and single-batch trivial-stable.

Slice fence: the audit module imports ONLY `node:crypto` (in
`hash.ts`). No imports from `@/agent/prompt`, `@/llm/adapters/...`, or
`@/observability/prompt-cache` — those are future callers, never
collaborators.

## Follow-up

- Wire `analyzePrefixStability` to the bench replay recorder so the
  invariant is asserted on every replay run. Recorder responsibility:
  on each `buildTurnContext` invocation, walk `system` blocks +
  capture the per-turn snapshot list; pass to the analyzer at session
  end.
- Optionally surface the `StabilityReport` to the prompt-cache
  observability slice (`src/observability/prompt-cache/`) so operators
  can correlate cache miss rate with detected drift events.
