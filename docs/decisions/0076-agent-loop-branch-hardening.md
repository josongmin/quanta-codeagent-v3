# ADR-0076 — Agent-loop branch hardening (refusal / reasoning / submission-op / deny-and-steer)

## Status
Accepted (2026-05-21)

## Context
Three-document gap analysis (`docs/analysis/code-agent-loop/{claude,codex,cursor}.md`)
identified four convergent or single-source weaknesses in our `runAgent`
loop. The cursor and codex analyses both confirmed (via code grep, not
speculation) that the gates already shipped — `stop-category.ts`,
`submission.ts`, `conversation-action.ts`, `ThinkingBlock`,
`admissibility-gate.ts` — provide most of the *types* needed, but the
*loop wiring* and a few branch arms are missing. The pre-ADR loop:

1. **Routes every unrecognized `stop_reason` to `proceed`→`completed`**
   (loop.ts:726-767). A model `refusal` (Anthropic) or content-policy
   stop (OpenAI) is **disguised as a normal completion** — the refusal
   text is reported as the task answer. This is the highest-ROI fix
   in the entire matrix.
2. **Drops every `thinking_delta` / `signature_delta` event** —
   `StreamEvent` has no thinking variants, `assembleFromEvents` has no
   thinking case, and `ThinkingBlock` (types.ts:36) is defined but
   never constructed. Extended-thinking turns lose signature and break
   multi-turn carry-over when re-enabled.
3. **Has `SubmissionOp` 6-variant types** (submission.ts:53-77) — `interrupt`,
   `cancel_subagent`, `reload_user_config`, `shutdown` — that **nothing
   consumes**. Mid-turn interrupt depends solely on `config.signal.aborted`
   polling; there is no active op dispatcher.
4. **Treats `onConfirm` as `Promise<boolean>`** (types.ts:79). A user
   who declines a tool call cannot atomically attach *what to do
   differently*. Cursor's `REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY`
   verb (cursor.md §4 D4) is the missing posture.

This ADR ships fixes to (1), (2), (4) immediately and **defers (3)** —
the submission-op dispatch — to a follow-up because it requires loop
entry-point restructuring that conflicts with concurrent co-development
on `loop.ts`.

## Decision

### Gap-1 — Provider refusal / abnormal stop (✅ shipped)
- `decideOnAssembled` (loop.ts:726) gets ONE new branch BEFORE the
  `max_tokens` / `tool_use` / empty branches: `stopReason === "refusal"`
  → `{ do: "error", reason: "Model refused to continue …" }`.
- The branch is **terminal** — does NOT consume any of `rec.outputContinues`
  / `rec.malformedRetries` / `rec.consecutiveEmpties` (test asserts).
- `pause_turn` (server-tool resume) is intentionally NOT handled — we ship
  no server-side tools, so the provider never emits it. Adding a dead
  branch would be cargo. Re-evaluate when a server-tool absorption ADR
  lands.
- `content_filtered` / `guardrail_intervened` — same reasoning: Bedrock
  guardrail integration is not in scope; the branch would be dead code.

### Gap-2 — Reasoning / thinking carry-over (✅ shipped via sub-agent A)
- `StreamEvent` gains `{ type: "thinking_delta"; text; redacted? }` and
  `{ type: "signature_delta"; signature }`.
- `assembleFromEvents` accumulates thinking text and signature into
  `ThinkingBlock` and prepends it to the assistant message (provider
  order: thinking before text/tool_use). When no thinking events arrive
  (the `thinking` budget is unset on the StreamInput), no block is added
  — byte-identical to the pre-ADR assembled message.
- Adapter emits (Anthropic `thinking_delta` / `signature_delta` SSE
  events → quanta `StreamEvent`; OpenAI reasoning summary delta →
  `thinking_delta`). Encrypted / redacted reasoning is preserved as an
  opaque text block with `redacted: true`.
- **Multi-turn carry-over** is automatic: the ThinkingBlock rides in
  the assistant `Message`, `wm.append` keeps it, the next turn's
  `StreamInput.messages` includes it, and the adapter re-serializes it
  to the provider's expected on-wire format (Anthropic sees
  `signature`, OpenAI re-encodes).

### Gap-4 — `deny_and_steer` approval verb (✅ shipped via sub-agent B)
- New `ConfirmDecision` discriminated union (`confirm-decision.ts`):
  `{decision:"allow"} | {decision:"deny"} | {decision:"deny_and_steer"; steer: string}`.
  `steer` is non-empty enforced; empty steer throws `ConfirmDecisionError`.
- `AgentConfig.onConfirm` widens to
  `(action) => Promise<boolean | ConfirmDecision>`. `normalizeConfirm()`
  bridges the legacy boolean shape (`true` → `{decision:"allow"}`,
  `false` → `{decision:"deny"}`) so every existing call site stays
  byte-identical without edits.
- `admissibility-gate.ts` always-confirm branch consults the normalized
  decision. `deny_and_steer` emits a deny `DispatchResult` AND attaches
  the steer text to the result envelope (`steerInjection?: string`) so
  the loop can hand it to the next turn as a user message — atomic
  coupling of "no, do X instead".
- **Loop wiring of `steerInjection`** is described in §Integration seam
  below but NOT shipped in this ADR (depends on the deferred Gap-3
  dispatch refactor).

### Gap-3 — `Submission` op dispatcher (⏳ deferred)
- `submission.ts` already defines the 6-variant union. The deferred work
  is `runAgent`'s entry-point switch:
  `interrupt` → `AbortController.abort()`,
  `cancel_subagent` → `conversation-action.decideAction`,
  `reload_user_config` → re-read at turn boundary,
  `shutdown` → graceful close.
- Reason for deferral: `loop.ts` is under heavy concurrent co-development
  (multiple file-modified notices in this session). Restructuring the
  entry-point switch alongside ongoing edits risks regressions in
  unrelated work. The op shape is stable; the dispatcher is a small
  isolated addition that can land cleanly when the file is quiescent.

## Rationale
- **Two channels for stop_reason hardening.** Codex (D8 — `tool error
  status reroute`) and Cursor (cursor.md §3 — `TurnEndedUpdate`
  structural transfer) both surface non-tool stops structurally. We had
  the structural type (`StopCategory`) but no branch arm. One line of
  code closes the highest-ROI gap.
- **Thinking carry-over is a pre-condition for cheap multi-turn
  reasoning.** The block already exists in `ContentBlock`; without
  carry-over the runtime silently amputates a $0.50–$5/turn input
  channel.
- **`deny_and_steer` is a small union widening, not a rewrite.** Boolean
  → `boolean | ConfirmDecision` is a structural-supertype change; every
  existing host that returns `true` / `false` keeps compiling and
  behaving identically.
- **Defer the op dispatcher consciously.** The ADR records exactly what
  the dispatcher should do (§Integration seam) so the follow-up is
  mechanical, not exploratory.

## Trade-offs
- `decideOnAssembled` adds one branch; the test surface grows by 4
  cases. Negligible.
- `StreamEvent` widens — every event consumer must handle the new
  variants OR ignore them (the `assemble` switch ignores unknown
  variants by design).
- `onConfirm` widening: hosts that *want* `deny_and_steer` must return
  the new union; hosts that don't get free byte-identical fallback.
- `steerInjection` plumbing through `DispatchResult` is the cost of
  atomic deny+steer; an alternative ("two separate events") was
  rejected because it can interleave across turns.

## Negative invariants
1. **Refusal must never be `proceed` / `completed`.** Any new
   stop_reason branch that lands above the refusal check breaks this.
   Tests (`recovery.test.ts` ADR-0076 block) pin the rule.
2. **`pause_turn` / `content_filtered` / `guardrail_intervened` stay
   un-branched** until the relevant provider integration ADR lands.
   Don't add dead branches.
3. **`onConfirm` must never narrow back to `Promise<boolean>` only.**
   The union widening is the public contract.
4. **`thinking_delta` events with no `signature_delta` are valid** —
   OpenAI reasoning summary has no signature. Adapters MUST NOT
   synthesize a fake signature.
5. **`steerInjection` is a one-shot** — the next turn consumes it and
   clears it; it never persists across two turns of inactivity.

## Integration seam (Gap-3 follow-up + Gap-4 loop wiring)

**`runAgent` entry-point (loop.ts:962-1015)**: a `for await (const sub of cfg.submissions)`
loop (or a single `Submission` argument switch) routes each op:
```ts
switch (sub.op.kind) {
  case "user_input":
  case "user_input_with_turn_context":
    /* drive the turn */ break;
  case "interrupt":            cfg.abort?.abort(); break;
  case "cancel_subagent":      await conversationAction.decideAction({ kind: "cancel_subagent", subagentId: sub.op.subagentId }); break;
  case "reload_user_config":   await reloadAtBoundary(); break;
  case "shutdown":             return finish("completed", turn);
}
```

**`steerInjection` consumption (Gap-4 follow-up)**: in the turn-loop
between `runTurn` and `wm.append(metaUser(result.resultBlocks))`,
inspect each `DispatchResult` for `steerInjection`; when present,
inject `{role:"user", content:[{type:"text", text: steer}]}` BEFORE
the next LLM call. One-shot — cleared after injection.

## Verification
- `tsc --noEmit` clean
- `biome check src/agent tests/unit src/llm` exit 0
- New unit tests:
  - `recovery.test.ts` ADR-0076 block (4 cases, refusal terminal, no
    budget consumption, byte-identical for non-refusal)
  - `assemble-thinking.test.ts` + adapter thinking emit (≥35 cases)
  - `confirm-decision.test.ts` + `admissibility-deny-steer.test.ts`
    (≥30 cases)
- E2E smoke (`tests/smoke/`): a planted-refusal scenario must finish
  with `reason:"error"`, not `reason:"completed"`.

## Related
- ADR-0030 mid-turn steer (steer primitive — `deny_and_steer` reuses)
- ADR-0048 `response_in_progress` heartbeat (orthogonal — partial vs stop)
- ADR-0066 model-swap retry (orthogonal — failure mode classification)
- ADR-0073 stop-category matrix (this ADR adds a *branch*, not a new code)
- ADR-0072 submission-op envelope (this ADR's Gap-3 is its loop wiring)
- ADR-0071 conversation-action steering (Gap-4 uses the same steer
  primitive but at the admissibility seam, not the user_message seam)
- `docs/analysis/code-agent-loop/{codex,cursor}.md` — gap evidence
