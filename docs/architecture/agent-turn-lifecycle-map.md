# Agent Turn Lifecycle Map

Purpose: reduce file-hopping when tracing one turn through the agent loop.

## Top-level control flow

1. `src/agent/loop/entry.ts`
   - Builds `RunAgentContext`
   - Hands control to `runAgentTurnLoop(ctx)`

2. `src/agent/loop/turn-loop.ts`
   - Owns the outer `for (turn=1..maxTurns)` loop
   - Runs the five stable phases:
     - `prepareTurnIteration(...)`
     - pre-turn stop conditions
     - `runTurn(...)`
     - `resolveTurnLoopOutcome(...)`
     - post-continue stop conditions
   - Owns final `max_turns` finish

3. `src/agent/loop/turn-iteration.ts`
   - Pre-turn admission and setup
   - Syncs queued inputs / focus-chain / control requests
   - Resolves “do we even start this turn?”

4. `src/agent/loop/context-assembler.ts`
   - Owns prompt assembly for one same-turn attempt
   - Builds `TurnContextInput`
   - Calls `buildTurnContext(...)`
   - Emits prompt-assembled observability

5. `src/agent/loop/same-turn-engine.ts`
   - Owns the inner same-turn `for (;;)`.
   - Repeats:
      - `prepareTurnContext(...)`
      - `streamConsume(...)`
      - `resolveTurnAction(...)`
      - `applyAction(...)`
   - Returns a sealed `TurnResult`

6. `src/agent/loop/stream-consume.ts`
   - Owns one live model stream
   - Tool visibility, tool-call dispatch, usage capture, stream event assembly
   - Converts provider/runtime exceptions into stream result shapes

7. `src/agent/recovery.ts`
   - Owns recovery classification and per-kind caps
   - Answers “given this failure/result, what recovery action is allowed?”

8. `src/agent/loop/recovery-executor.ts`
   - Owns same-turn action application
   - `resolveTurnAction(...)`: maps stream/recovery result to an action
   - `applyAction(...)`: mutates working memory / retries / finishes same turn

9. `src/agent/loop/turn-outcome.ts`
   - Converts `TurnResult` into outer-loop resolution:
     - `continue`
     - `park`
     - `finish`
   - Owns post-turn budget exhaustion on continuation paths
   - Owns pending plan-entry / plan-exit application

## Authority boundary

- Outer-loop authority:
  `entry.ts` -> `turn-loop.ts` -> `turn-outcome.ts` -> `session-lifecycle.ts`
  - Final `AgentOutcome`
  - turn counter / `max_turns`
  - pre-turn and post-continue stop conditions
  - park vs finish vs continue

- Same-turn authority:
  `context-assembler.ts` -> `same-turn-engine.ts` -> `stream-consume.ts` -> `recovery.ts` -> `recovery-executor.ts`
  - one prompt attempt
  - stream consumption
  - same-turn retry / compaction / refusal fallback
  - sealing one `TurnResult`

Read outer-loop files first when the question is “why did the session end this way?”
Read same-turn files first when the question is “why did this stream retry, compact,
or recover instead of ending the turn?”

## Decision ownership by symptom

| Symptom / question | First file to read | Why |
|---|---|---|
| Why did the whole run stop? | `turn-loop.ts` | outer-loop terminal authority |
| Why did this turn never start? | `turn-iteration.ts` | pre-turn admission/setup |
| Why did this prompt contain that reminder / context block? | `context-assembler.ts` | prompt assembly authority |
| Why did the model stream retry inside the same turn? | `same-turn-engine.ts` + `recovery-executor.ts` | same-turn retry loop + action application |
| Why did a stream/provider failure become retry vs error? | `recovery.ts` | recovery classification/caps |
| Why did that recovery action mutate memory / continue / finish? | `recovery-executor.ts` | action execution |
| Why did a finished turn become `continue` vs `finish` vs `park`? | `turn-outcome.ts` | outer-loop resolution SSOT |
| Why did budget exhaustion stop after tools, not before? | `turn-outcome.ts` | post-turn budget check lives there |
| Why did `max_turns` stop differently from other reasons? | `turn-loop.ts` | final loop-owned finish |

## Recovery split

- `src/agent/recovery.ts`
  - Decide layer
  - Classifies failure/result
  - Tracks per-kind retry ceilings
  - No working-memory mutation

- `src/agent/loop/recovery-executor.ts`
  - Apply layer
  - Turns a recovery decision into loop effects
  - Updates memory / emits retry prompts / seals turn result

Use this split when editing:

- “Should this retry?” => start in `recovery.ts`
- “What does retry actually do?” => start in `recovery-executor.ts`

## Fast trace recipes

### Stream failure -> retry or stop

1. `stream-consume.ts` — what result/error shape came back?
2. `same-turn-engine.ts` — where was it handed to recovery?
3. `recovery-executor.ts` — what action was chosen/applied?
4. `turn-outcome.ts` — how did the resulting `TurnResult` affect the outer loop?

### Clean completion -> final session outcome

1. `same-turn-engine.ts` — where did `TurnResult.kind === "completed"` come from?
2. `turn-outcome.ts` — completion vs park decision
3. `turn-loop.ts` — final `ctx.finish(...)`

### Tool turn -> another loop iteration

1. `stream-consume.ts` — tool calls + result blocks
2. `recovery-executor.ts` — how same-turn tool flow sealed
3. `turn-outcome.ts` — append pending tool results, then `continue`
4. `turn-loop.ts` — next outer iteration
