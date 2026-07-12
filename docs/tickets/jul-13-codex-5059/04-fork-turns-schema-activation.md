# C5059-04 — Activate `fork_turns` on the 6-tool schema

- **Priority:** P0
- **Class:** TRUE-GAP (model-visible activation); core already landed
- **Effort:** XS
- **Status:** READY
- **Dependencies:** none

## Goal

Make the existing live-WM/redacted `fork_turns: none | all | positive-N` implementation reachable through the strict 6-tool `spawn_agent` input schema.

## Existing authority — do not duplicate

- `src/agent/fork-turns.ts`: selection and preamble composition.
- `src/agent/tier1/subagent.ts`: live working-memory source and shared `forkPrompt` closure.
- `src/subagent/dispatch-6.ts`: `forkPrompt` dependency.
- `src/subagent/handlers-6.ts`: reads `fork_turns` and composes the child prompt.
- Existing trio/6-tool parity and live-WM tests are green but currently bypass schema parsing with a cast.

## Work

1. Add to `SpawnAgentInputSchema`:

```ts
fork_turns: z.union([
  z.enum(["none", "all"]),
  z.number().int().positive(),
]).optional()
```

2. Remove the defensive cast at the handler boundary; consume the inferred field directly.
3. Replace cast-based test setup with an actual `SpawnAgentInputSchema.parse` path.
4. Keep absent → `"none"` byte-identical.

## Acceptance

- Strict schema accepts `none`, `all`, `1`, and `2`.
- It rejects `0`, negatives, fractions, NaN/non-finite values, strings such as `"2"`, and unknown fields.
- `fork_turns:2` through schema → dispatch → handler produces the same redacted live-WM preamble as the trio `agent` tool.
- A turn appended after tool construction is inherited, proving the source is live WM rather than the seed transcript.
- `none` and absent leave the raw child prompt byte-identical.

## Proof rail

```sh
bun test tests/unit/fork-turns-hellgate.test.ts \
  tests/unit/subagent-6-fork-parity-hellgate.test.ts \
  tests/unit/subagent-fork-live-wm-hellgate.test.ts
```

Add a schema-to-handler integration case; a direct handler call with `as never` is not sufficient closeout evidence.

