# RFC — `permission_request` hook event (fires BEFORE the permission decision)

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/agent` (the `HookEvent` union + `HookBus` in `src/agent/hooks.ts`) + the
dispatch gate ordering in `src/agent/dispatch.ts` + the admissibility gate in
`src/agent/admissibility-gate.ts`. No new slice — one new variant on an existing union,
wired exactly like the existing `pre_tool_use` event.
**Default posture:** OFF, byte-identical. With **no handler** registered for
`permission_request`, the bus fast-paths the empty-handler-list case and the gate runs the
existing steps 4–11 unchanged.

> Scope note: the audit confirmed quanta has **8 hook events** and a `pre_tool_use` event
> that fires as the **LAST** gate (step 11, AFTER the permission decision). There is **no
> hook BEFORE the decision** — that is the one gap. A `permission_request` hook lets an
> operator-authored script programmatically gate (allow/deny/ask) before the built-in
> policy stack runs, mirroring Claude Code's `PreToolUse`→permission-decision hook.

---

## 1. 요약 (Summary)

quanta's hook bus has 8 events but **none fires before a permission decision**:
`pre_tool_use` is documented as the **LAST gate** (step 11), running only AFTER the
permission stack (steps 4–10) already decided. So a hook script today can deny a call, but
**only after** the policy stack has already run — it cannot *programmatically supply* the
allow/deny/ask decision the stack would otherwise compute.

This RFC adds one event:

```ts
| { type: "permission_request"; name: string; input: unknown; tier: HITLTier; cwd: string }
```

fired by the admissibility gate **immediately before** it consults the policy stack. A
handler may return one of three decisions:

```ts
{ permission: "allow" }            // short-circuit: admit without running the stack
{ permission: "deny"; reason }     // short-circuit: terminal deny
{ permission: "ask" }              // force the human/reviewer path regardless of policy
// (nothing) ⇒ fall through to the existing stack — byte-identical
```

This is the **programmatic gate** a user hook script wants: "for any `bash` whose command
matches X, auto-deny without bothering the policy stack" or "always ask for `write` under
`/etc`". It mirrors `pre_tool_use`'s wiring exactly (composition, first-wins, isolation,
caps) but sits at a **different point in the pipeline** (before the decision, not after).

What it deliberately is NOT: a way to bypass `HARD_DENY` (the denylist still wins — §4.4),
a replacement for `pre_tool_use` (that one rewrites *input* and denies AFTER policy; this
one *supplies the decision* BEFORE policy), or a new slice.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **Claude Code** ships a `PreToolUse` hook whose JSON response can carry a
  `permissionDecision` of `allow` / `deny` / `ask` that **feeds the permission engine**
  before the built-in rules run — the exact shape this RFC adopts. quanta's existing
  `pre_tool_use` already absorbed the *input-rewrite + deny* half of Claude's `PreToolUse`
  (`hooks.ts:21-27`, "mirrors the permission-deny path in dispatch.ts"); this RFC absorbs
  the **decision-feed** half it left on the table by placing the new event **before** the
  policy stack instead of after it.
- **Codex** routes approvals through its own approval policy; the cue we take is the
  three-valued `allow | deny | ask` decision surface, which already matches quanta's
  `PermissionInspectionOutcome` (`src/permission/inspector.ts:61`,
  `outcome: "allow" | "deny" | "ask"`). The hook's return type reuses that vocabulary.

---

## 3. 현재 quanta 상태 (grep-verified, cite file:line)

### 3.1 The 8 existing hook events — and the gap

`src/agent/hooks.ts:126-200`, the `HookEvent` union:

1. `session_start` (`:127`)
2. `session_end` (`:128`)
3. `pre_tool_use` (`:129`) — **the closest, but it is step 11, AFTER permission**
4. `post_tool_use` (`:130`)
5. `post_tool_use_failure` (`:138`)
6. `pre_compact` (`:144`) / `post_compact` (`:153`)
7. `subagent_start` (`:161`) / `subagent_stop` (`:171`)
8. `turn_start` (`:182`) / `user_prompt_submit` (`:190`)

**None fires before a permission decision.** `grep -rn "permission_request\|pre_permission\|
permission_decision" src/agent/hooks.ts` → 0 hits. This is the one enumerable gap.

### 3.2 The dispatch gate ordering proves the gap

`src/agent/dispatch.ts:209-230`, the verbatim step list:

```
 4. mode-posture block .......... plan/review/audit (admissibility-gate §1)
 5. earlyHardDeny ............... HARD_DENY pulled ahead
 6. pattern auto-pass ........... ADR-0061 rememberPatterns
 7. prefix-rule DSL gate ........ ADR-0031 allow→hook / deny→terminal / ask→reviewer
 8. HITL 4-tier gate ............ ADR-0047 hand-off→deny / always-confirm→onConfirm / …
 9. permission stack ............ ADR-0046 per-thread/per-host/post-denial
10. mode policy (legacy) ........ evaluate() + classifier
11. pre_tool_use hook .......... ADR-0133 (LAST gate, can deny OR rewrite input)
```

And the invariant (`dispatch.ts:238`): "**Permission denial (steps 4-10) ⇒ `pre_tool_use`
hook NEVER fires.**" So `pre_tool_use` is *downstream* of the decision — by design it never
even runs if policy already denied. A hook that wants to **influence** the decision has no
hook point. The `permission_request` event slots in **before step 4** (the new step "3b").

### 3.3 The decision vocabulary already exists

- `src/permission/inspector.ts:61` — `outcome: "allow" | "deny" | "ask"` is the existing
  three-valued decision type. The hook return mirrors it.
- The gate consumes deny/allow/ask today: `noMatchPolicy?: "deny" | "fallthrough"`
  (`admissibility-gate.ts:150`), rules `allow ⇒ admit, deny ⇒ terminal, ask ⇒ reviewer`
  (`admissibility-gate.ts:131-132`). The hook's three outcomes route into these *existing*
  arms — `allow` ⇒ admit, `deny` ⇒ the gate's `deny()` helper
  (`admissibility-gate.ts:443`), `ask` ⇒ the reviewer/`onConfirm` path
  (`admissibility-gate.ts:135-136`).

### 3.4 `pre_tool_use` is the wiring template

`emitPreToolUse` (`src/agent/hooks.ts:508-555`) is the exact composition pattern to mirror:
iterate matched handlers (`matchTool(stored.matcher, event.name)`), first-deny-wins
(`if (denied === null && isDeny(result))`), per-handler timeout tracker, accumulate
`promptHook`/`abort`, return a `HookEmitResult`. `emitUserPromptSubmit`
(`hooks.ts:562+`) is a second, near-identical mirror — proving this is a well-trodden
extension shape.

---

## 4. 설계 (Design — closed-port DI)

### 4.1 The event variant

```ts
// src/agent/hooks.ts — NEW arm on HookEvent (after pre_tool_use)
| {
    type: "permission_request"
    name: string          // tool name (matcher target, like pre_tool_use)
    input: unknown         // the tool args (read-only here — NOT rewritten)
    tier: HITLTier         // the inferred HITL tier the gate is about to apply
    cwd: string            // for path-scoped policies in the handler
  }
```

`tier` is included because the gate has *already* inferred it by this point (the
HITL-4-tier classifier, `dispatch.ts:222`), so the handler can reason about it (e.g.
"only gate `always-confirm` calls").

### 4.2 The response + `emitPermissionRequest`

A new `HookPermissionDecision` field on `HookEmitResult` (presence-not-truthiness, OMITTED
when no handler set it — so legacy `{deny, updatedInput?}` readers are byte-identical, same
discipline as `promptHook`/`abort`, `hooks.ts:50-56`):

```ts
permissionDecision?: { outcome: "allow" } | { outcome: "deny"; reason: string } | { outcome: "ask" }
```

`emitPermissionRequest(event, list)` mirrors `emitPreToolUse` (`hooks.ts:508-555`):
- iterate `matchTool(stored.matcher, event.name)` handlers;
- **first decision wins** (like first-deny-wins) — once a handler returns any of the three
  outcomes, later handlers do not override it (deterministic, registration-ordered);
- `deny` reason is carried; `allow`/`ask` carry no payload;
- `abort` / per-handler timeout / `MAX_HANDLERS_PER_EVENT` / `MAX_PAYLOAD_BYTES` apply
  identically (reuse the same `runHandler` + accumulator path);
- a handler that returns **nothing** ⇒ no `permissionDecision` ⇒ fall through.

### 4.3 Where it fires + how the decision feeds the gate

The admissibility gate fires `permission_request` as a **new step 3b — BEFORE step 4**
(mode-posture), via an **injected** duck-typed hook port (closed-port DI — the gate already
takes injected ports like `reviewerPort`, `admissibility-gate.ts:151`):

1. Gate in>fers `tier`, builds the event, `await hookPort.emitPermissionRequest(event)`.
2. On `{ outcome: "allow" }` ⇒ **short-circuit admit** — but ONLY for non-`HARD_DENY` calls
   (§4.4). The gate skips steps 4–10 and proceeds to step 11 (`pre_tool_use` still fires —
   the input-rewrite channel is independent) then `execute`.
3. On `{ outcome: "deny", reason }` ⇒ route into the gate's existing `deny(call.id, reason,
   tag)` helper (`admissibility-gate.ts:443`) — terminal, byte-identical to a policy deny.
4. On `{ outcome: "ask" }` ⇒ force the reviewer/`onConfirm` path
   (`admissibility-gate.ts:135-136`) regardless of what policy would have said.
5. On no decision ⇒ continue to step 4 exactly as today.

### 4.4 `HARD_DENY` precedence (the security floor)

The hook's `allow` MUST NOT route around `HARD_DENY`. The gate already pulls
`earlyHardDeny` ahead "when ANY allow-capable bypass is wired (rules/reviewer/patternStore)
so they cannot route around the denylist" (`dispatch.ts:210-213`,
`admissibility-gate.ts:§2`). The `permission_request` hook is **another allow-capable
bypass**, so it is added to that same `earlyHardDeny`-pull-ahead trigger: when a
`permission_request` handler is registered, `HARD_DENY` is evaluated FIRST and a
`HARD_DENY` call is terminal **before** the hook's `allow` is consulted. This is the exact
precedent set for rules/reviewer — fail-closed, audited by the existing
`permission-hook-ordering.test.ts`.

### 4.5 Why a NEW event, not "move `pre_tool_use` earlier"

Moving `pre_tool_use` before the decision would break its documented contract (it rewrites
*input* and is the LAST gate; the `permission-hook-ordering.test.ts` invariants pin
"permission denial ⇒ pre_tool_use NEVER fires", `dispatch.ts:238`). The two events are
**complementary**: `permission_request` *supplies the decision* (pre-policy, read-only
input), `pre_tool_use` *rewrites input + can veto* (post-policy). Keeping both is the
honest design.

---

## 5. 통합 (Integration)

- **Knob (default-OFF):** no env knob needed for *correctness* (the bus fast-paths the
  empty-handler-list case ⇒ inert when no handler is registered, exactly like every other
  event). The `earlyHardDeny`-pull-ahead is triggered by **handler presence**, not a knob —
  mirroring how rules/reviewer trigger it. (An optional `QUANTA_PERMISSION_HOOK=0` kill-switch
  can be registered to hard-disable emission for paranoid operators; default registered.)
- **Hook wiring:** `permission_request` joins the `HookEvent` union + `HookEventType` +
  `emitPermissionRequest` in the `HookBus.emit` dispatch switch (`hooks.ts:498-508`),
  mirroring `emitPreToolUse`. The gate gains an injected `permissionHookPort` (duck-typed,
  the gate imports nothing new — same shape as `reviewerPort`).
- **Manifest/tool:** none — this is a hook event, not a tool.
- **fc:** one feature-catalog node `permission-request-hook` on the hook-events axis (next
  to the existing `pre_tool_use` / `post_tool_use` nodes); reachability wired through the
  gate emit → decision-route path.
- **Fence:** the gate already takes injected ports; the hook port is one more. No new
  cross-slice import. The `HookEvent` union lives in `@/agent`, where the gate already is.

---

## 6. 테스트 계획 (Hellgate + e2e)

Extend `tests/unit/permission-hook-ordering.test.ts` (the existing ordering oracle) and add
`tests/unit/permission-request-hook-hellgate.test.ts`:

1. **No handler ⇒ byte-identical.** With no `permission_request` handler, the gate's
   decision for a corpus of calls is identical to the pre-feature baseline (snapshot the
   admit/deny/ask outcomes).
2. **`deny` short-circuits the stack.** A handler returns `{ outcome: "deny", reason }`;
   assert steps 4–10 never run (spy the policy stack) and the call is terminal-denied with
   the handler's reason.
3. **`allow` short-circuits — but NOT `HARD_DENY`.** `{ outcome: "allow" }` admits a normal
   mutating call without the stack; the SAME `allow` on a `HARD_DENY` call (e.g. `rm -rf /`)
   is **still terminal-denied** — the hook cannot route around the denylist (the §4.4
   security floor). This is the headline adversarial case.
4. **`ask` forces the human path.** A call policy would auto-allow, with `{ outcome: "ask" }`
   ⇒ the reviewer/`onConfirm` path is invoked; assert the confirm seam fired.
5. **First-decision-wins.** Two handlers, first returns `allow`, second `deny`; assert
   `allow` wins (registration order), second not consulted for the decision.
6. **Ordering vs `pre_tool_use`.** A `permission_request` `allow` + a `pre_tool_use` `deny`
   on the same call ⇒ `pre_tool_use` still runs (step 11) and its deny is honored — proving
   the two events are independent and `pre_tool_use` is downstream.
7. **Isolation + caps.** A throwing `permission_request` handler does not break dispatch
   (falls through); `MAX_HANDLERS_PER_EVENT` and per-handler timeout apply identically to
   `pre_tool_use`.

e2e: register a real handler that denies any `bash` containing `curl`; run a loop turn that
issues such a call → terminal deny with the handler's reason, model recovers; remove the
handler → same call admitted by policy.

---

## 7. 단계 (Phases)

- **Phase 1 (core):** the `permission_request` event variant + `emitPermissionRequest` +
  `HookEmitResult.permissionDecision` + the gate's injected `permissionHookPort` emit at
  step 3b + the three-outcome routing + `earlyHardDeny` pull-ahead trigger. Hellgate 1–5,7.
- **Phase 2 (ordering + fc):** the `pre_tool_use` independence test (6), fc node, the
  optional `QUANTA_PERMISSION_HOOK` kill-switch, docs in the hook-events catalog.
- **Phase 3 (optional):** carry the handler's decision provenance into the permission
  recorder (`src/permission/recorder.ts`) so a `/permission` audit shows "denied by hook
  X" — observability parity with policy-sourced decisions. Backlog.

---

## 8. 리스크 / 대안 (Risks & alternatives)

- **R1 — a hook `allow` escalates privilege.** A malicious/buggy handler could try to
  `allow` a destructive call. *Mitigation:* the §4.4 `HARD_DENY` floor — `allow` can never
  route around the denylist (the gate evaluates `earlyHardDeny` first when the hook is
  wired, exactly as for rules/reviewer). Hellgate 3 locks this. The hook is operator-authored
  local code at the same trust level as the permission config (same trust posture
  `pre_tool_use` already carries, `dispatch.ts:241-243`).
- **R2 — byte-identity.** Inert when no handler is registered (bus empty-list fast-path).
  The decision routing reuses the gate's *existing* deny/admit/reviewer arms — no new
  decision machinery, so a no-decision fall-through is provably identical to today.
- **R3 — ordering confusion with `pre_tool_use`.** Mitigated by keeping them at distinct
  pipeline points (3b vs 11) with distinct purposes (decide vs rewrite+veto) and a dedicated
  ordering test (6). The `permission-hook-ordering.test.ts` invariant set is extended, not
  rewritten.
- **Alternative — overload `pre_tool_use` with a `permissionDecision` return.** Rejected:
  `pre_tool_use` fires AFTER the decision (step 11) and "NEVER fires on a policy deny"
  (`dispatch.ts:238`) — it structurally cannot *supply* a decision the stack already made.
  A pre-decision event is required.
- **Alternative — a config-only rule (no hook).** quanta already has the prefix-rule DSL
  (step 7) for *declarative* allow/deny. The hook's value is **programmatic** gating
  (arbitrary logic: hit a remote policy server, inspect the FS, time-of-day) that a static
  rule cannot express — and it composes with the DSL (the DSL is still step 7 on
  fall-through).

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/agent/hooks.ts:126-200` — the 8-event `HookEvent` union (the gap: no pre-decision event).
- `src/agent/hooks.ts:508-555` — `emitPreToolUse` (the wiring template to mirror).
- `src/agent/hooks.ts:498-508` — the `HookBus.emit` dispatch switch.
- `src/agent/hooks.ts:50-56` — the presence-not-truthiness OMITTED-field discipline.
- `src/agent/dispatch.ts:209-248` — the verbatim gate ordering + the "policy deny ⇒
  pre_tool_use NEVER fires" invariant + the `earlyHardDeny`-pull-ahead rationale.
- `src/agent/admissibility-gate.ts:131-136,150-151,443` — the deny/admit/ask arms, injected
  `reviewerPort`/`noMatchPolicy`, and the `deny()` helper the hook routes into.
- `src/permission/inspector.ts:61` — the `"allow" | "deny" | "ask"` decision vocabulary.

**To add (implementation, NOT in this RFC):**
- `src/agent/hooks.ts` — `permission_request` variant + `emitPermissionRequest` +
  `HookEmitResult.permissionDecision` + emit-switch arm.
- `src/agent/admissibility-gate.ts` — injected `permissionHookPort` + step-3b emit + the
  three-outcome routing + `earlyHardDeny` trigger on handler presence.
- `tools/feature-catalog/…` — `permission-request-hook` node.
- `tests/unit/permission-request-hook-hellgate.test.ts` + extensions to
  `tests/unit/permission-hook-ordering.test.ts`.
