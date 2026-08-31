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

Goal pursuit has a separate production-composition smoke:

```sh
bun run smoke:goal
```

`tests/smoke/goal/` composes the objective authority, attributed-attempt slot,
strict verifier runner, wake controller, runtime host, and deterministic replay
LLM. It asserts authority snapshots, receipts, and exact spawn/wake counts. It
does not use the generic fixture runner because that runner has no Goal
authority/verifier/wake composition.

**Catalog (15 scenarios — single 4 · medium 4 · tikitaka 7):**
- single — `01-read-summarize` · `02-glob-list` · `03-grep-symbol` · `04-bash-inspect`
- medium — `05-read-then-edit` · `06-grep-then-fix` · `07-test-then-impl` · `08-plan-then-go`
- tikitaka — `09-multi-file-rename` · `10-iterative-debug` · `11-context-callback` · `12-correction-undo` · `13-spec-clarify` · `14-refusal-handled` · `15-refusal-mid-tool`

The coverage report (`bun run smoke --report`) is the source of truth — run it any time the catalog grows.

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
| `judge` | LLM-as-judge rubric + threshold — `cached.score` gates tier-0 sync; live judge runs in tier-1 with fail-closed JSON parse |

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
4. Record the trajectory: `bun run smoke:record <id>` (live provider call;
   needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Until you record, hand-author
   `trajectory.jsonl` from a known-good live run — but note edit `old_string`
   MUST be unique in the (post-prior-edits) seed unless `replace_all:true`,
   otherwise the edit is a silent no-op.

## Tiers

- **tier-0 replay** — implemented. Hermetic, $0, <1s/scenario. CI default; folded
  into `bun test` via `tests/unit/smoke-battery.test.ts`.
- **tier-1 live** — implemented. `bun run smoke --tier=live` (or
  `QUANTA_SMOKE_LIVE=1`) hits the real provider via the public `@/llm` adapters.
  Polite-skip when the key is absent (no hard fail). Live LLM-judge runs on
  scenarios that carry a `judge` block.
- **record mode** — implemented. `smoke:record <id>` wraps the live provider
  (`QUANTA_LLM_PROVIDER` openai|anthropic, `QUANTA_SMOKE_MODEL` to override),
  captures the trajectory to `trajectory.jsonl`, and prints a field-level diff
  of the existing `expect.json` vs an expectation PROPOSED from the observed run
  (stopReason / turns / tool counts). Requires the provider key. **Overwrites
  `trajectory.jsonl` without confirmation** unless `--dry`.
- **coverage report** — `bun run smoke --report` (or `bun run smoke:report`)
  prints a tool × depth matrix plus forbidden-sentinel / context-retention /
  judge counts. Designed to surface use-case gaps as the catalog grows.

## Caveats / sharp edges

- `trajectory.jsonl` only scripts the model's decisions — the **tools run for
  real** against the tmp workspace. Never paste a destructive `bash` command
  into a recording you intend to replay.
- Default permission is `bypass` (hermetic sandbox); a scenario can opt in to
  `acceptEdits` / `default` via `config.json` to exercise the gate itself.
- The smoke harness uses `QUANTA_SMOKE_MODEL` (default `gpt-4o`) for live tier;
  the runtime CLI uses `QUANTA_MODEL` (Justfile default `gpt-5`). These are
  deliberately separate envs — record/replay should be cheap, the runtime CLI
  benefits from the strongest model.
