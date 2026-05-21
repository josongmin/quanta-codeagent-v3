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
- **Baseline tests** (Gap-1/2/4 happy-path + key edges): 98 pass / 0 fail / 170 expects
  - `recovery.test.ts` ADR-0076 block (4 cases: refusal terminal, no budget
    consumption, byte-identical for non-refusal, tool blocks ignored)
  - `assemble-thinking.test.ts` + `anthropic-thinking.test.ts` +
    `openai-thinking.test.ts` (44 cases — ThinkingBlock assembly, signature
    carry-over, redacted variant, OpenAI signature-never invariant,
    end-to-end roundtrip)
  - `confirm-decision.test.ts` + `admissibility-deny-steer.test.ts`
    (~52 cases — boolean byte-identical, union round-trip, malformed →
    ConfirmDecisionError, deny_and_steer steerInjection emit at gate)
- **Hell-gate tests** (181 pass / 0 fail / 260 expects across 6 files): see §Hell-gate below.
- **E2E smoke** (`tests/smoke/`): two scenarios — `14-refusal-handled`
  (text refusal → `reason:"error"`) and `15-refusal-mid-tool` (tool_use
  block in same turn as refusal → still `reason:"error"`, malicious
  command never executes). Both PASS in `bun run smoke` (15 total smoke
  fixtures pass, 0 regression vs pre-ADR baseline).

## Hell-gate (181 adversarial cases across 6 files)

Six dedicated `*-hell.test.ts` files pin attack vectors, edge cases,
and the partial-wiring guard:

| File | Cases | Focus |
|---|---:|---|
| `tests/unit/recovery-hell.test.ts` | 30 | refusal × tool_use, ThinkingBlock, case-variants (`Refusal`/`REFUSAL`/`refused`/`blocked` → fall-through), priority vs max_tokens/empty, `pause_turn`/`content_filtered`/`guardrail_intervened` as NI #2 dead-branch sentinels, budget non-consumption |
| `tests/unit/llm/assemble-thinking-hell.test.ts` | 27 | signature_delta without preceding thinking_delta, stream_reset mid-thinking, multi-block ordering, redacted+non-redacted mixing, 10MB thinking, signature concat, empty signature behavior PIN |
| `tests/unit/llm/anthropic-thinking-hell.test.ts` | 21 | SSE→StreamEvent edge cases, redacted_thinking start as 1-shot redacted delta, wire-faithful carry-over with `{type:"thinking", thinking, signature}` / `{type:"redacted_thinking", data}`, large signature (4KB), non-ASCII signature, cache_control anchor regression |
| `tests/unit/llm/openai-thinking-hell.test.ts` | 21 | `reasoning`/`reasoning_content` prefer-canonical, **`signature_delta` NEVER emitted** (NI #4 invariant), ThinkingBlock auto-drop on assistant input serialization, `content_filter` finish_reason last-wins behavior PIN |
| `tests/unit/agent/confirm-decision-hell.test.ts` | 55 | malformed unions (null/undefined/number/string/Symbol/Promise/Array), prompt-injection in steer (`</tool_result>`, fake system tags) preserved verbatim, control-chars/newlines/100KB steers, prototype-pollution PIN, ConfirmDecisionError.field debug carry |
| `tests/integration/admissibility-deny-steer-hell.test.ts` | 27 | multi-tool deny_and_steer collection, HARD_DENY > deny_and_steer precedence, mode-block precedence, sticky-denial precedence, **G-1 ~ G-1d regression guard** (see §Partial-wiring guard below) |

**Total: 181 cases / 260 expects / 0 fail.**

## Partial-wiring guard (G-1 ~ G-1d — Gap-4 critical)

The self-audit confirmed `admissibility-gate.ts` emits
`DispatchResult.steerInjection` on `deny_and_steer`, but **the loop
does not yet consume it** — `streaming-dispatch.ts:369`
(`collectResultBlocks`) pushes `res.value.block` only, dropping
`steerInjection`. This is a deliberate deferral (see §Trade-offs and the
Integration-seam patch below), but a silent drift to "wired everywhere
but the consumer" would be invisible without a structural guard.

`admissibility-deny-steer-hell.test.ts §G` pins the state of the wiring
across the dispatch chain by file-grep, so the partial-wiring boundary
is observable as a test invariant:

- **G-1** asserts `readFileSync("src/agent/loop.ts").match(/steerInjection/g) === null`
- **G-1b** asserts the same for `src/agent/dispatch.ts`
- **G-1c** asserts the same for `src/agent/streaming-dispatch.ts`
- **G-1d** asserts `src/agent/admissibility-gate.ts` contains exactly ONE
  positive `steerInjection: steer` assignment (positive control —
  proves the emit seam exists where the ADR promises)

**Drift-detection contract**: the moment a PR lands that wires
`steerInjection` into the loop's consumer side, G-1/G-1b/G-1c will
fail. The PR author MUST then update or delete the guard with an
explicit migration comment — silent partial-wiring is structurally
impossible.

## Newly discovered invariants (PINNED, not yet hardened)

Three behaviors the hell-gate suite revealed and PINNED as
regression tests. They are NOT bugs to fix in this ADR; they are
documented quirks future hardening can address — the PIN means the
hardening change is observable as a test diff.

1. **Empty-string signature in `signature_delta`** — `assemble.ts`
   sets `ThinkingBlock.signature = ""` when an empty
   `signature_delta` arrives. The Anthropic adapter's carry-over guard
   checks only `signature === undefined`, so `signature: ""` flows to
   the wire. A provider rejection here would manifest as a runtime
   400. Test `H-3c` PINs the current behavior; a future hardening
   adding `signature.trim() === ""` guard will surface as the H-3c
   diff.
2. **Prototype-pollution `__proto__:{decision:"allow"}`** —
   `normalizeConfirm` currently uses `'decision' in obj`, which walks
   the prototype chain. The polluted object passes as
   `{decision:"allow"}`. Test `C-10` PINs this. Hardening to
   `Object.hasOwn(obj, "decision")` would flip C-10 to throw — a
   conscious decision flag.
3. **OpenAI `processChunk` finish_reason last-wins** — a trailing
   `finalChunk()` can overwrite an earlier `content_filter`
   finish_reason. The `openai-thinking-hell.test.ts` `content_filter`
   case PINs this. A future change to preserve abnormal finish_reasons
   over trailing benign chunks will surface as a diff there.

## Integration-seam follow-up patch (Gap-4 wiring — separate PR)

The exact minimal patch to consume `steerInjection`, ready to apply
when `loop.ts`/`streaming-dispatch.ts` are quiescent:

1. `streaming-dispatch.ts` `collectResultBlocks`: return
   `{ resultBlocks, steerInjections: readonly string[] }` instead of
   `ResultBlocks`. Push `res.value.steerInjection` (when present) into
   the second array.
2. `streaming-dispatch.ts` `StreamingTurnResult.assembled`: add
   `steerInjections?: readonly string[]`.
3. `streaming-dispatch.ts` `streamingTurn` last `return`: include
   `steerInjections` in the `assembled` payload.
4. `loop.ts` (`TurnResult` propagation around line 1119): after
   `wm.append({ role: "user", content: result.resultBlocks })`, for
   each non-empty `steerInjection` append a
   `metaUser(steer)` so the next LLM call sees the steer as a user
   message. Mark with the `origin="deny_steer"` reminder tag if
   present (Cursor `is_simulated_msg` alignment).
5. Delete G-1/G-1b/G-1c (partial-wiring guard) and replace with a
   positive consumption-side test in `admissibility-deny-steer-hell.test.ts`
   asserting `wm` contains the steer text after a `deny_and_steer`
   turn.

When this PR lands, the seven negative-invariant section's NI #5
("`steerInjection` is a one-shot") becomes enforceable at the loop
level, not just at the test level.

## Related
- ADR-0030 mid-turn steer (steer primitive — `deny_and_steer` reuses)
- ADR-0048 `response_in_progress` heartbeat (orthogonal — partial vs stop)
- ADR-0066 model-swap retry (orthogonal — failure mode classification)
- ADR-0073 stop-category matrix (this ADR adds a *branch*, not a new code)
- ADR-0072 submission-op envelope (this ADR's Gap-3 is its loop wiring)
- ADR-0071 conversation-action steering (Gap-4 uses the same steer
  primitive but at the admissibility seam, not the user_message seam)
- `docs/analysis/code-agent-loop/{codex,cursor}.md` — gap evidence
