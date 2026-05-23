# ADR-0113 — `pre_tool_use` hook `updatedInput` (Cursor parity)

- **Status**: Accepted
- **Date**: 2026-05-23
- **Related**: ADR-0013 (HookBus minimal in-process), ADR-0026 (admissibility-gate SSOT), ADR-0055 (AWF 2-matcher hook channel), [[cursor-3.2-absorption]] (Tier-S4)

## Context

Cursor 3.2's `preToolUse` hook supports a third return shape beyond `allow`/`deny`: `updated_input`, which REWRITES the tool arguments before execution. Use cases include policy-driven argument normalization (`rm -rf` → `rm -ri`), workspace-relative path rewriting, and secret redaction at the argument boundary.

quanta's `HookHandler<"pre_tool_use">` previously supported only `{deny: string}` | void. A repo-local hook could refuse a tool call but could not refine its arguments — operators wanting argument hygiene had to fork the tool itself.

## Decision

1. `src/agent/hooks.ts` — add a SECOND optional return channel `HookUpdatedInput = {updatedInput: unknown}` orthogonal to `HookDeny`.
2. `HookEmitResult` carries:
   - `deny: HookDeny | null` (first deny wins, unchanged)
   - `updatedInput?: unknown` (KEY-PRESENCE is the signal — a rewrite to `null`/`undefined` is still an explicit rewrite, distinct from a no-op return)
3. Composition: in `emitPreToolUse`, each handler observes the LATEST input — handler #2 sees handler #1's rewrite as its `event.input`. Last rewrite wins. Matchers gate as before.
4. `src/agent/admissibility-gate.ts` — `runPreToolUseHook` surfaces the composed rewrite via an outbound `opts.onInputMutation(next)` sink (one outbound channel — the gate stays control-flow-pure).
5. `src/agent/dispatch.ts` — captures the mutation into a `{value: unknown}` wrapper (so falsy rewrites still propagate) and executes the tool with the rewritten `ToolUseBlock.input`.

### Precedence

`deny > updatedInput > pass`. A handler that returns `{deny, updatedInput}` denies (rewrite is moot). A later handler's deny supersedes an earlier handler's rewrite.

### Security

The rewrite is applied AFTER the permission / HARD_DENY gates ran on the ORIGINAL input. A hook is operator-authored local code at the trust level of the permission config itself — the model and untrusted content cannot reach it. This is intentional (and documented in `hooks.ts#emit` security note); it is NOT a sandbox-escape vector for any caller below the operator's trust boundary.

### Default behaviour

`AgentConfig.hooks` absent ⇒ no construction, no call, no behavioural delta. A hook that returns nothing (or only `deny`) is byte-identical to the pre-ADR path. The dispatch wrapper `{value}` stays undefined when no rewrite fires, so the executed `effectiveCall` is `=== call` by reference.

## Consequences

**Positive**
- Operator-authored argument hygiene without forking the tool surface.
- Composes orthogonally with ADR-0055 matchers — an FS-only rewriter can scope to `FS_TOOLS_MATCHER` and never touch `bash`.
- Composable across handlers: a normalizer + a redactor can stack in registration order.

**Trade-offs**
- The rewrite bypasses re-running the admissibility gate against the new input — by design, since a hook is at operator trust and a re-gate would create a deny→rewrite→deny ping-pong surface. Mitigated by the tool's own `inputSchema` safeParse (proven by unit test `(f)` — a rewrite to a schema-invalid shape becomes a normal validation error, NOT a silent bypass).
- `updatedInput`-by-presence (not by truthiness) requires `"updatedInput" in result` checks — slightly more ceremony than `if (result.updatedInput)` but necessary so `null`/`undefined` rewrites are honoured.

## Negative invariants

- A `pre_tool_use` handler MUST NOT change behaviour for any other event type. Rewrite path is gated on `event.type === "pre_tool_use"`.
- `post_tool_use` MUST NOT honour `updatedInput` — the seam is one-way (pre only). Asserted by the type system (`HookEmitResult.updatedInput` only set by `emitPreToolUse`).
- A throwing handler MUST NOT leak — caught + logged via `StructuredLogger`, treated as if it returned `undefined`.
- A rewrite to a tool-schema-INVALID shape MUST surface as a normal `tool_result.ok=false` validation error, NOT a silent bypass and NOT an unhandled throw. Asserted by `hook-updated-input.test.ts (f)`.
- Default path (no hooks) MUST stay byte-identical — `effectiveCall === call` by reference when no rewrite fires.

## Files touched

- `src/agent/hooks.ts` — `HookUpdatedInput` type, `isUpdatedInput` guard, `HookEmitResult.updatedInput` key, `emitPreToolUse` composition loop.
- `src/agent/admissibility-gate.ts` — `AdmissibilityWaveAOptions.onInputMutation` sink, `runPreToolUseHook` surfaces the rewrite.
- `src/agent/dispatch.ts` — captures rewrite, builds `effectiveCall` with mutated input.
- `tests/unit/hooks-updated-input.test.ts` — HookBus.emit composition matrix.
- `tests/unit/agent/hook-updated-input.test.ts` — dispatch seam (a)-(g) matrix.
- `tests/integration/hook-args-rewrite-e2e.test.ts` — runAgent loop e2e (4-case matrix, bash shape).
