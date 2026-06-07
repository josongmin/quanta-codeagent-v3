# ADR-0511: fork_turns — parent-context inheritance for spawned subagents (GAP8a)

- **상태**: Accepted
- **날짜**: 2026-06-08
- **관련**:
  - `src/agent/fork-turns.ts` (pure selection + redacted preamble)
  - `src/subagent/agent-tool.ts` (`fork_turns` input + `forkPrompt` dep)
  - `src/agent/tier1/subagent.ts` (wiring: transcript + `redactTranscript`)
  - Tests: `tests/unit/fork-turns-hellgate.test.ts`
  - Absorbs: Codex `multi_agents_v2` `fork_turns(none|all|N)`.

## Context

quanta's `agent` spawn started every child COLD — the parent re-explained context each time.
Codex `fork_turns` lets a child inherit the parent's recent turns. (The other peer verbs —
`wait_agent`/`send_message`/`read_messages`/`list_agents`/`followup_task`/bg fork·poll·await —
already exist; `fork_turns` was the real gap. The 3-tool-plane consolidation is a cosmetic
refactor, deliberately NOT done.)

## Decision

A pure core (`selectForkTurns` / `buildForkTurnsPreamble` / `composeForkedPrompt`): the `agent`
tool gains a `fork_turns` input (`none`(default) | `all` | N). A "turn" is a user-message
boundary; `N` keeps the last N user-initiated exchanges. The selected transcript is REDACTED
(secret + PII scrubbed via the advisor's `redactTranscript`) and prepended to the child prompt
framed as DATA, not instructions. Default `none` ⇒ prompt unchanged (byte-identical cold start).
Wired via an injected `forkPrompt` callback (the `@/subagent` leaf stays plane-clean; the tier-1
builder owns the transcript source + redactor).

## Consequences

A delegated child can start with the parent's context (better delegation quality) at a token
cost the model controls per-spawn. The transcript source is `config.messages` (the session
seed — the advisor's convention; the loop's live working-memory is a separate buffer).
