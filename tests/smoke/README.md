# Smoke battery

End-to-end fixtures that exercise common coding-agent shapes against the **real
agent loop + real tools**, with the LLM replayed from a recorded trajectory
(tier-0, deterministic) or hit live (tier-1, opt-in).

```
bun run smoke                   # all scenarios, tier-0 replay (CI default)
bun run smoke --depth=single    # filter by depth (single|medium|tikitaka)
bun run smoke 05-read-then-edit # one scenario by id

bun run smoke:record <id>       # capture a LIVE trajectory + propose expect diff
bun run smoke:record <id> --dry # record + print, write nothing
```

The battery also runs inside `bun test` via `tests/unit/smoke-battery.test.ts`,
so every PR gates on tier-0.

**Catalog (13 scenarios):**
- single — `01-read-summarize` · `02-glob-list` · `03-grep-symbol` · `04-bash-inspect`
- medium — `05-read-then-edit` · `06-grep-then-fix` · `07-test-then-impl` · `08-plan-then-go`
- tikitaka — `09-multi-file-rename` · `10-iterative-debug` · `11-context-callback` · `12-correction-undo` · `13-spec-clarify`

## Layout

```
fixtures/<depth>/<NN-name>/
  seed/             files copied into a tmp workspace before the run
  prompts.jsonl     one user message per line (N lines ⇒ N-turn tikitaka)
  trajectory.jsonl  recorded LLM events, one per line, keyed by {run, turn}
                    (missing ⇒ scenario is SKIPPED — pending recording)
  expect.json       declarative assertion spec (see tests/smoke/types.ts)
  config.json?      optional { permission, maxTurns } — default permission is
                    "bypass" (hermetic sandbox); override to exercise the gate
  tags.json?        optional string[] tags for coverage reporting
```

`depth` ∈ `single` (1 Q-A) · `medium` (2-3 turns) · `tikitaka` (4-6 turns,
conversation-context recall).

## Assertion spec (`expect.json`)

Industry-SOTA blend (Inspect AI / promptfoo / Braintrust). All blocks optional:

| block | checks |
|---|---|
| `stopReason` | terminal reason equals |
| `turns.count` | total LLM turns in `{min,max}` |
| `toolCalls` | `required` (≥1) · `forbidden` (0, safety sentinel) · `orderedPrefix` · `counts` |
| `files[]` | `contains` / `notContains` / `absent` / `linesAdded` (vs seed) |
| `finalText` | `contains` / `containsAny` / `notContains` / `regex` |
| `contextRetention[]` | a given run's assistant text mentions a prior fact (tikitaka recall) |
| `budget` | `wallSeconds` / `tokensInput` / `tokensOutput` max |
| `judge` | LLM-as-judge rubric + threshold (Phase 2; `cached` score honoured now) |

## Trajectory format

One JSON object per line:

```json
{"run":0,"turn":0,"event":{"type":"tool_use_start","id":"r1","name":"read"}}
{"run":0,"turn":0,"event":{"type":"tool_use_end","id":"r1","input":{"path":"README.md"}}}
{"run":0,"turn":0,"event":{"type":"message_stop","stop_reason":"tool_use"}}
{"run":0,"turn":1,"event":{"type":"text_delta","delta":"요약 ..."}}
{"run":0,"turn":1,"event":{"type":"message_stop","stop_reason":"end_turn"}}
```

- `run`  = which user message (0-indexed). Advances between prompts.
- `turn` = which LLM call within that run (0-indexed). Advances per `stream()`.
- `event` = a raw `StreamEvent` (`@/llm`). **Tools run for real** — the
  trajectory only scripts the model's decisions, not the tool outputs.

Exhausting a trajectory mid-run throws (a stale fixture FAILS loud → re-record).

## Adding a scenario

1. `mkdir -p fixtures/<depth>/<NN-name>/seed` and drop seed files in.
2. Write `prompts.jsonl` (one user message per line).
3. Write `expect.json`.
4. Record the trajectory (Phase 2: `bun run smoke:record <id>`); until then,
   hand-author `trajectory.jsonl` from a known-good live run.

## Tiers

- **tier-0 replay** — implemented. Hermetic, $0, <1s/scenario. CI default; folded
  into `bun test`.
- **record mode** — implemented. `smoke:record <id>` wraps the live provider
  (`QUANTA_LLM_PROVIDER` openai|anthropic, `QUANTA_SMOKE_MODEL` to override),
  captures the trajectory to `trajectory.jsonl`, and prints a field-level diff
  of the existing `expect.json` vs an expectation PROPOSED from the observed run
  (exact stopReason / turns / tool counts). Requires the provider key.
- **tier-1 live battery** — roadmap. A `QUANTA_SMOKE_LIVE=1` mode that runs the
  whole battery against the real provider in nightly cron, skipping politely
  when the key is absent.
