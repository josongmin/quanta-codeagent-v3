# RFC-01 — Agent-Attention Navigation (absorb Codex 6662 "thread-attention nav")

**Status:** **R6 ARCHITECTURE FROZEN — question authority BUILD FIRST; implementation NOT READY**
**Author:** (aug-22 흡수계획)
**Source:** Codex 2026-08-13 refresh — `.extracted_source/_deep-codex-ui-high.md` §1 + §4
**North-star fit:** DIRECT — `agent-state-observability-northstar` (which agent is blocked / awaiting-input / has-unread, jump to it).

---

## Final audit incorporation — current-HEAD authority (R5)

> This section and the revised Design/TDD/Sequencing below are authoritative. The older R1–R3
> audit log is historical evidence only where it conflicts with R5.

The prior `READY` decision is withdrawn. `SubagentTurnGate.wait()` is a **follow-up idle-retention
mechanism**, not evidence that a child asked the operator a question. Mapping every parked child to
`awaitingInput` creates false attention for ordinary clean completions. The root session is also not
a `TaskRecord`, so a `parentTaskId` chain cannot manufacture a common session root for direct
children. Finally, `/agents inspect` is a read-only detail view; it neither changes a selected input
target nor delivers an operator response.

### Final disposition

| Slice | Verdict | Admission condition |
|---|---|---|
| Existing TaskRegistry, `/agents`, follow-up gate, keybinding substrate | ALREADY | Reuse verbatim |
| Explicit pending-question authority | **BUILD FIRST** | Producer is an accepted `request_user_input` call bound to a real `subagentTaskId`; clean completion/park is never a producer |
| CLI attention identification | BUILD after authority | Reads the same live registry instance as the agent tools; no second accumulator |
| CLI answer/jump delivery | BUILD after authority | Must route by opaque `requestId` through the existing user-input completion owner; `/agents inspect` alone is not a receipt |
| CLI lineage filter | DROP | CLI registry is session-local already; do not derive a fake root from task ancestry |
| Web multi-session scoping | PARK | Requires explicit `sessionId` on the producer/broadcast contract, never task-chain inference |
| Unread/per-viewer cursor | PARK | Separate client-owned state with its own persistence decision |

### Canonical authority model

1. Add one **pending-question record** to the existing task authority, not a fifth task status:
   `{requestId, askedAt, summary}` or `null`. The opaque `requestId` is minted by the existing
   user-input request owner and is the only response correlation key.
2. Set it only after a child-bound `request_user_input` request is admitted. Clear it in the same
   owner on answer, decline, cancellation, stop, failure, and completion via `try/finally`.
3. A clean child completion followed by `turnGate.wait()` remains `parkedForFollowup`, not
   `awaiting-input`. Do not write attention state at the generic park sites.
4. Composition owns one TaskRegistry instance shared by child tools, `/agents`, `/attention`, and
   delivery. Feature gates must not create a second registry.
5. CLI scope is inherent in that session-local handle. Any future cross-session/web plane carries
   an explicit session identity from its composition root.

### Product closure

The north-star receipt is not “the right id was printed.” It is: child emits a real question → the
operator command selects that exact opaque request → the response reaches that waiting request →
the child resumes → the pending marker clears. Until this rail is RED then GREEN, the feature is
an attention list, not attention navigation.

---

## Architecture integration — R6 (normative)

This section is the implementation authority for placement and wiring. It supersedes R5's
proposal to put a pending-question field on `TaskRecord` and every older park-derived
`awaitingInput` design. Shared rules come from
[`00-architecture-blueprint.md`](./00-architecture-blueprint.md); this section fixes the
RFC-01-specific graph against current HEAD `9d5369d31`.

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Child lifecycle/status | `src/subagent/registry.ts` | Keep `TaskRecord` lifecycle-only; do not add question state |
| Follow-up retention | `src/subagent/turn-gate.ts` | Keep semantically independent from attention |
| Question tool contract | `src/tool/request-user-input.ts`, `src/tool/types/context-seams.ts` | Preserve tool-facing seam; adapt it at `@/agent` |
| CLI question UX | `src/apps/cli/repl/session-host-ports.ts` | Becomes a concrete answer/presentation adapter, not the pending-state owner |
| Session construction | `apps/cli/repl/factories/lifecycle.ts`, `apps/web-daemon/runtime-factory.ts`, `agent/optional-ports.ts`, `subagent/agent-tool.ts` can each mint a registry | Move production construction to session-authority assembly; fallback minting becomes illegal |

The missing authority is a pending question, not a task status. Therefore question lifecycle
belongs to `@/session`, while the task/question join belongs to `@/agent`, the repository's
legal cross-slice bridge.

### Target write set

```text
src/session/user-question/
  types.ts          # QuestionOwner = root | { taskId }; request/outcome closed unions
  broker.ts         # request, answer, decline, cancel, listPending; one atomic owner
  index.ts
src/agent/user-question/
  tool-adapter.ts   # ToolContext requestUserInput <-> broker wait
  task-correlation.ts # only explicit spawnedAsTaskId correlation
src/agent/attention/
  types.ts          # bounded/redacted navigation projection
  resolver.ts       # TaskRegistry x broker join; pure ordering
  port.ts
  index.ts
src/runner/assemble/session-authorities/build-questions.ts
src/apps/cli/repl/factories/lifecycle.ts       # consume assembled registry/broker
src/apps/web-daemon/runtime-factory.ts         # consume assembled registry/broker
src/agent/optional-ports.ts                    # remove registry mint
src/subagent/agent-tool.ts                     # registry required on production path
src/apps/cli/slash/attention.ts
src/protocol/session/{commands,codec,builders}.ts   # extend existing command union
src/host/runtime/session-authority-host.ts          # answer command adapter
tests/unit/{session/user-question,agent/attention}/
tests/integration/cli-attention-navigation.test.ts
```

Do not add an attention store, an event-stream accumulator, `TaskRecord.awaitingInput`, or a
synthetic session root record. `AttentionReader` is a projection over two live authorities.

### Contracts and flow

```ts
type QuestionOwner = { kind: "root" } | { kind: "task"; taskId: string }

interface UserQuestionBroker {
  request(input: QuestionRequest): Promise<QuestionOutcome>
  answer(requestId: string, answer: QuestionAnswer, expectedRevision: number): QuestionResult
  decline(requestId: string, expectedRevision: number): QuestionResult
  cancel(requestId: string, reason: QuestionCancelReason, expectedRevision: number): QuestionResult
  listPending(): readonly PendingQuestion[]
}
```

The accepted flow is:

```text
request_user_input
  -> agent tool-adapter binds root or explicit spawnedAsTaskId
  -> broker atomically publishes pending before awaiting
  -> attention resolver joins task display metadata by exact taskId
  -> CLI session.question.answer(requestId, expectedRevision)
  -> existing kernel/session command serialization
  -> host calls broker.answer with the row's expected question revision
  -> original Promise resolves and pending disappears
```

- `requestId` is opaque and is the only response correlation key. Labels, summaries, list
  positions, PIDs, task ancestry, and “most recent” are never routing authority.
- Root questions use the root union arm and never appear as a fake task.
- Task questions require the explicit child `taskId`; missing/unknown correlation stays root or
  fails at the adapter according to the originating call contract. It is never inferred.
- Broker state is session-lifetime in v1. Teardown cancels every pending waiter. Resume does not
  recreate a wait that has no executable continuation; durable cross-process pending questions
  remain PARKED until continuation persistence exists.
- Projections include request id, owner, asked-at and a bounded redacted preview; raw question
  bodies and answers do not enter generic session descriptions.

### Assembly and slice rules

`buildSessionAuthorities` constructs exactly one `TaskRegistry`, one broker, and one attention
reader. Subagent tools, child configuration, CLI readers and the question adapter receive those
same handles. `buildSessionFeatures` may consume them but may not construct defaults.

`@/session/user-question` imports no `@/subagent`, `@/agent`, app, host, or runner value. The
resolver lives in `@/agent` because it joins session and subagent authorities. CLI owns only
rendering/command parsing. Extend the existing session-command bus; do not add an attention bus.

### Atomic landing plan

1. **A1 — question authority:** broker state machine, cancellation semantics, clock/id injection,
   unit RED rails. No surface yet.
2. **A2 — composition cutover:** construct TaskRegistry and broker in session-authorities;
   remove CLI/web/optional-port/agent-tool production fallback mints in the same commit. Tests that
   need isolation inject an explicit registry fake/instance.
3. **A3 — producer bridge:** bind root/child request paths with `try/finally` cancellation. Prove
   generic follow-up park never calls the broker.
4. **A4 — command/front door:** extend session commands and add CLI `/attention` list/answer.
5. **A5 — receipt:** real child question -> exact answer -> child resumes -> projection clears.

Packets A2 and A3 are atomic: a producer may not land against a second registry/broker. The
default-OFF gate is evaluated at producer and command admission, not merely at rendering.

### Executable work packets

Shared worktree, receipt, merge and stop rules are in
[`01-execution-board.md`](./01-execution-board.md). A packet is not mergeable merely because its
new unit test is green.

#### A1 — question authority (`codex/aug22-a1-question-broker`)

- **Prerequisite/owner:** none; owns only `src/session/user-question/**`, its barrel export, and
  `tests/unit/session/user-question-broker.test.ts`.
- **RED first:** request one question, assert it is visible before the returned Promise settles;
  answer by opaque id, assert exactly one settlement and removal. Add decline, cancel, teardown,
  stale id and double-answer cases.
- **Implement:** injected clock/id factory, immutable snapshots, revisioned atomic transition,
  bounded preview redaction and `cancelAll` lifecycle. No task import or persistence.
- **Verify:**
  `bun test tests/unit/session/user-question-broker.test.ts tests/unit/session-slice-boundary.test.ts --parallel=1`.
- **Receipt:** transition table covers every state/outcome and an injected second settlement is
  rejected. **Stop** if the broker needs task ancestry, a surface callback, or durable resume.

#### A2 — single registry/question composition (`codex/aug22-a2-question-assembly`)

- **Prerequisite/owner:** A1; exclusive lock on
  `runner/assemble/session-authorities/{types,build,build-questions,index}.ts`,
  `apps/cli/repl/factories/lifecycle.ts`, `apps/web-daemon/runtime-factory.ts`,
  `agent/optional-ports.ts`, and `subagent/agent-tool.ts`.
- **RED first:** `tests/integration/session-authorities-task-registry-identity.test.ts` constructs
  CLI and web sessions and proves current fallback instances diverge from the injected handle.
- **Implement:** make the production registry required downstream, build it once with the broker,
  and delete all four production fallback constructors. Explicit unit fakes remain injectable.
- **Verify:** targeted identity test plus
  `bun test tests/unit/{agent,session,subagent,runner}-slice-boundary.test.ts --parallel=1` using
  explicit paths rather than shell brace expansion in the final receipt.
- **Receipt:** source-call ratchet reports exactly one production `new TaskRegistry()` owner.
  **Stop** if a surface cannot accept the assembled narrow handles without importing another app.

#### A3 — producer and attention projection (`codex/aug22-a3-question-producer`)

- **Prerequisite/owner:** A2; owns `agent/user-question/**`, `agent/attention/**`,
  `agent/dispatch/tool-context.ts`, `agent/subagent-runner-child-config.ts`, and their tests.
- **RED first:** `tests/integration/child-question-attention-projection.test.ts` runs one clean parked
  child and one questioning child; only the latter may appear and must carry its exact task id.
- **Implement:** adapt `AgentConfig.userInputPort` through the broker, bind owner from explicit
  `spawnedAsTaskId`, cancel in `try/finally`, and derive ordered attention rows by joining the
  registry. Root questions remain root rows.
- **Verify:** targeted integration test plus agent/session/subagent boundary tests and the ordinary
  follow-up gate suite.
- **Receipt:** removing `spawnedAsTaskId` correlation makes the child row disappear/fail, never
  reassign to the newest task. **Stop** on any proposed parent-chain/root inference.

#### A4 — command and CLI adapter (`codex/aug22-a4-attention-frontdoor`)

- **Prerequisite/owner:** A3; first lock holder for the shared protocol/kernel/CLI chain. Exact
  write-set is `protocol/session/{commands,codec,builders}.ts`, `kernel/session/{ports,scheduler,reducer}.ts`,
  `host/runtime/session-authority-host.ts`, `apps/cli/slash/attention.ts`, and the CLI slash registry.
- **RED first:** codec rejects/does not know `session.question.answer`; CLI cannot select and answer
  an emitted request. Pin both failures before adding the command.
- **Implement:** add versioned command payload `{requestId,answer,expectedRevision}`, typed stale/
  resumed receipt, projection-only reducer state, `/attention` list and explicit answer command.
- **Verify:** protocol codec/builder tests, kernel scheduler tests, CLI slash test, protocol/kernel/
  host/agent slice boundaries.
- **Receipt:** unsupported host capability is a typed rejection, never success/no-op. **Stop** if
  command routing requires prompt text, row index, or newest-request selection.

#### A5 — product closure (`codex/aug22-a5-attention-e2e`)

- **Prerequisite/owner:** A4; test/fixture-only unless the receipt exposes a missing live wire.
- **RED first:** real CLI harness spawns a child that calls `request_user_input`; before A4 merge it
  must time out or lack the answer route for the expected reason.
- **Implement:** only if the RED exposes one, close the narrowest missing composition wire; do not
  add state.
- **Verify:**
  `bun test tests/integration/cli-attention-navigation.test.ts --parallel=1`, then the shared ladder.
- **Receipt:** pending row appears -> answer exact request id -> same child emits a post-answer marker
  -> row clears; attention OFF with subagent panel ON produces no new command/projection bytes.
  **Stop** if any failure occurs before the question is emitted; that is a bad fixture/base rail,
  not a product RED.

### Architectural completion gates

- RED-on-injection: replace explicit task correlation with parent-chain inference; the task-answer
  integration test must fail.
- Anti-vacuum: exercise at least one root question, one child question, one ordinary parked child,
  one cancellation, and one stale/double answer.
- Cross-case: subagent panel ON + attention OFF emits no attention state or protocol delta.
- Registry identity/completeness test proves CLI, web, tool spawn, `/agents`, attention resolver and
  lifecycle share the same instance and source-scan asserts no production `new TaskRegistry()`
  remains outside the authority builder. The scan requires a constructor call, not a bare symbol.
- Run slice-boundary, surface-coupling, terminal-default, typecheck, and the real CLI receipt.

**R6 status:** architecture frozen; implementation remains **REVISE / BUILD FIRST** until A1–A5
are admitted.

---

## Prior review incorporation (R4, superseded where R5 conflicts)

`_review-01.md` verdict = **REVISE**. Its earlier proposal to reinterpret follow-up park as
`awaitingInput` and to derive `rootId` from task ancestry was falsified by R5; retain the remaining
default-OFF and no-new-store observations only.

**정정 1 — byte-identity 교차케이스 게이트 (C2).** park-site emit이 새는 조건은 attention-OFF가 아니라 **panel-ON**이다: emitter 존재 여부는 `QUANTA_WEB_SUBAGENTS`/`onSubagentEvent` 배선이 결정하지(`subagent-runner-lineage.ts:16-19`; source는 `runtime-factory.ts:658`에서 `gateOn(env,"QUANTA_WEB_SUBAGENTS")`로만 생김) `QUANTA_ATTENTION_NAV`가 아니다. 따라서 **subagents 패널 ON + attention OFF** 교차케이스에서 emitter는 present → park-site 갱신이 attention knob을 별도로 체크하지 않으면 샌다. → 새 attention 신호는 **패널 게이트와 독립인 자기 게이트(`QUANTA_ATTENTION_NAV`)**를 park 호출부에서 직접 걸고, default-OFF byte-identity 증명은 **emitter-present / attention-off 교차케이스 테스트**를 반드시 포함한다.

**정정 2 — CLI attention owner = record 필드 (C3).** `TaskRecord`엔 awaiting 상태가 없다(`registry.ts:4` `TaskStatus = "running"|"completed"|"failed"|"stopped"`, 4-valued 확인; park는 이벤트일 뿐 상태 아님). 이벤트 route를 고집하면 CLI 슬래시 표면(스냅샷 소비자)이 park를 못 봐 **신규 stream accumulator**가 필요해진다 = "no new store" 위반 + stream/protocol **3중 mirror** cascade. → **objective substrate로 `TaskRecord.awaitingInput` additive boolean 필드**(status는 4-valued 불변)를 park/unpark 호출부에서 갱신 → `/agents` 스냅샷이 그대로 실어와 CLI `/attention`이 **PURE stateless resolver**로 닫힌다 (신규 CLI accumulator 0, stream/protocol 3중 mirror 0).

**정정 3 — slice 축소 (D/H-3).** MINIMAL vertical slice = **awaiting-input jump only**: record 필드 → pure resolver → CLI `/attention` + `focus-next-attention`(select+drill) → RED e2e. **PARK/DROP**: web focus-jump(프론트엔드 이 트리 밖), unread accumulator + focus cursor, main-session synthetic root row(Q1), Starting/Working split(running row에 `turns` producer 없음), `previousThread`/`focusSideChat`. 이 slice는 per-viewer store 0·web 프론트 0·unread 0으로 CLI에서 진짜 navigation receipt까지 닫는다.

**정정 4 — 공수 (G).** minimal awaiting-jump slice = **~3–4d (M)**. 원래 M은 web focus-jump + unread + parity split까지 포함한 full scope에 대해선 **과소평가**였다 — full scope는 **~5–7d**이고 이제 **PARKED**.

**C1 nuance 정정.** emit seam은 "gate emits"가 아니다 — `SubagentTurnGate`는 PURE로 설계되어(`turn-gate.ts:63`; registry 참조 없음) 아무것도 emit하지 않는다. 진짜 seam은 **child loop의 park 호출부**(`agent/loop/turn-outcome.ts:157`, `turn-loop.ts:218`)이고, child config가 부모 공유 registry(`subagent-runner-child-config.ts:235`) + `spawnedAsTaskId`(:220) + `subagentTurnGate`(:224)를 실어주므로 park 직전 `awaitingInput=true`, `wait()` resolve 후 `false`를 부모 registry에 쓰는 것이 **도달 가능**하다.

---

## Motivation

Codex ships a keyboard/command-palette layer that jumps focus to the "next chat/agent
needing attention", where **needing-attention = (awaiting-input) ∪ (unread-activity)**,
priority **awaiting-input BEFORE unread**. Real command/string corpus (electron-only,
`requiredAccess:codexLocal`):

| Codex command | label | keybinding |
|---|---|---|
| `nextThreadNeedingAttention` | "Next chat needing attention" / "Switch to the next chat awaiting input or with unread activity" | `⌘⌥A` |
| `focusMainChat` | "Focus main chat" | `⌘⌥U` |
| `focusSideChat` | "Focus side chat" | — |
| `markThreadUnread` | "Mark as unread" | `⌘⇧U` |
| `previousThread` | previous chat | — |
| task-row badge | `taskRow.unreadDescription` = "Unread" (`sr-only`) | — |

Companion (parity check): a **created-tasks tracker** side panel — spawned sub-tasks with
live status (Starting/Working/Done/Failed) beside Subagents/Background/Outputs/Environment.

quanta runs many concurrent agents (root session + spawned subagents + parked followup
children) but gives the operator **no way to answer "which one is blocked on me right now,
and take me there."** That is exactly the north-star.

## Non-goals

- **Not** a multi-pane split-composer UI. quanta's CLI is a single-focus REPL; "jump focus"
  degrades honestly per surface (see Design → Surfaces). We do not build Codex's
  main/side split layout.
- **Not** a new persistence/store. Attention state is DERIVED from signals that already
  exist (+ one additive gated observation) and a per-viewer focus cursor.
- **Not** efficacy-claimed. Default-OFF; measure-first before any default flip.
- **Not** a new TaskStatus value. The closed `TaskStatus` union stays 4-valued (`registry.ts:4`,
  confirmed); awaiting rides an ADDITIVE `TaskRecord.awaitingInput` boolean, not a status value (R1, 정정 2).
- **Not** in the minimal (v1) slice — PARKED/DROPPED (see 리뷰 반영 정정 3):
  unread accumulator + per-viewer focus cursor, web focus-jump + web keybindings,
  main-session synthetic root row (Q1), `previousThread`/`focusSideChat` (Q2), and the
  Starting/Working presentational split (DROP — no `turns` producer on a running row).
  v1 = **awaiting-input jump only**, CLI front door. The rest is a separate follow-up RFC.

## Current state (code-grounded)

**Real delta established — quanta has the substrate, none of the attention layer.**

What EXISTS (reuse):
- Subagent registry + lifecycle events: `src/subagent/registry.ts:31` (`TaskRecord`),
  `:71` (`SubagentLifecycleEvent` = `subagent_spawn | subagent_status`), emitted via an
  observer-sink `setEmitter`/`emit` (`:157`, `:163`) wired from `AgentConfig.onSubagentEvent`.
- Lineage substrate already on every record: `TaskRecord.parentTaskId` (`registry.ts:49`),
  `depth` (`:53`), `mailboxLabel` (`:58`); tree reconstruction in `agents-fleet-tree.ts`.
- CLI fleet panel: `src/apps/cli/agents-fleet-panel.ts` (`/agents`, `--tree`, `inspect`),
  status glyphs/colours as **closed `Record<status,…>`** at `:88` / `:97`.
- Web panel source: `src/apps/web-daemon/subagent-source.ts` (broadcasts `subagent` frames
  on `SUBAGENT_WS_TOPIC`, gated `QUANTA_WEB_SUBAGENTS`, `wireSubagentSourceIfGated:145`).
- Activity spine mapping: `src/activity/producers/fleet.ts:28` (closed status map).
- Main-session awaiting-input DOES exist at the kernel level:
  `src/kernel/session/state.ts:35` `status: "idle"|"running"|"awaiting_approval"|"failed"|"closed"`,
  `pendingApproval: PendingApprovalView | null` (`:42`); mirrored onto the wire snapshot
  `src/protocol/session/snapshot.ts:82`.
- Subagent **parked / awaiting-followup** state exists but is INVISIBLE to the registry:
  `src/subagent/turn-gate.ts` parks a child loop idle awaiting a `wake` (`send_input`
  forwards to "a paused child", `tools-6.ts:296`); the `TaskRecord.status` stays `"running"`
  the whole time. Gated behind `QUANTA_SUBAGENT_FOLLOWUP`. **This is ordinary idle retention,
  not an operator-question signal and MUST NOT feed attention.**
- Keybinding layer: closed `KEY_ACTIONS` enum `src/apps/cli/keybindings/types.ts:19`
  (operator-bindable-only actions like `effort-cycle` have NO default chord — `:50`),
  `DEFAULT_KEYBINDINGS` `defaults.ts:27`, gated `QUANTA_KEYBINDINGS`.
- Slash surface: `src/apps/cli/slash-contract.ts:231` (`agents` getter), feature-gate seed
  list `src/apps/cli/cli-feature-gates.ts:37`.

What is ABSENT (the delta):
- **No attention/unread state anywhere.** `rg -i "needingattention|markunread|unread|attention"`
  over `src/` (minus the substrate hits above) returns **zero** attention-domain matches; whole-repo
  `needing.attention|markunread` = **0**.
- **No per-agent `awaiting-input | unread | idle` model.** Subagent status is only
  `running|completed|failed|stopped` (`registry.ts:4`); parked-followup children read as
  `running`; main-session `awaiting_approval` is never joined into the fleet view.
- **No priority-ordered "next needing attention" resolver.**
- **No jump/focus command or keybinding**, no mark-unread, on any surface.
- **Created-tasks tracker** is ~90% already the `/agents` + web panel; the only gaps are
  cosmetic (no Starting/Working split — quanta collapses both to `running`).

> Conclusion: quanta has fleet presentation substrate, but it lacks the load-bearing pending-
> question authority and response-correlation front door. The work is therefore an authority +
> vertical-delivery slice, not a thin presentational resolver.

## Design

> **Scope note (R5):** v1 closes explicit question → operator response → child resume in the CLI.
> `[PARK]`/`[DROP]` are not silently implemented as scaffolding.

### 1. Attention state model (DERIVED, leaf, pure)

New leaf module `src/attention/model.ts` — no `@/agent`/`@/subagent` value import (structural
mirror discipline, same as `activity/producers/fleet.ts`).

**[v1] Minimal slice = awaiting-only, no cursor:**
```
export interface AttentionAgent {
  readonly id: string
  readonly label: string
  readonly pendingQuestion: {
    readonly requestId: string
    readonly askedAt: number
    readonly summary: string
  } | null
}
// CLI input is already session-local. Cross-session consumers add explicit sessionId at their
// own protocol boundary; they never infer it from parentTaskId.
```

- **[v1] awaiting-input** comes only from an admitted child `request_user_input` request bound
  to `subagentTaskId`. The same user-input owner supplies `requestId`, records the pending fact,
  waits for the response, and clears it in `finally`. `TaskStatus` stays 4-valued. Generic
  follow-up park/unpark is explicitly excluded.

**[PARK] unread + focus-cursor** (deferred): the fuller model adds
`lastActivityAt`/`focusedAt`/`markedUnread` and a priority enum
`AttentionState = "awaiting-input" | "unread" | "idle"` with
`attentionOf(a) = a.awaitingInput ? "awaiting-input" : (unread…) ? "unread" : "idle"`. Unread
is a per-viewer cursor (`lastActivityAt > focusedAt`) folded from the EXISTING
`subagent_status`/`item.*` stream — no new backend event, but it introduces a per-viewer
accumulator/owner that the north-star slice does not need. Deferred to the follow-up RFC.

### 2. Resolver (pure, priority + lineage-gated)

`src/attention/resolver.ts`:

```
export const nextNeedingAttention = (
  agents: readonly AttentionAgent[],
  afterRequestId?: string,
): AttentionAgent | undefined
```

- **[v1]** Keep `a.pendingQuestion !== null`; order by `(askedAt, requestId)` for deterministic
  oldest-first selection. `afterRequestId` optionally advances through the immutable snapshot.
- **[v1]** No task-chain root filter exists in CLI. The injected registry handle is the scope.
- **[v1]** Return `undefined` when nothing is awaiting (caller shows "all caught up").
- **[PARK]** the fuller resolver partitions by `attentionOf` and drains the awaiting-input
  bucket fully before the unread bucket. In v1 there is only the awaiting bucket, so this is a
  simple filter — but the MIXED-fixture priority test (TDD #2) still pins the ordering so the
  unread extension can't silently invert it.

### 3. Surfaces

**[v1] CLI (single-focus REPL) — honest degrade, the whole v1 front door:**
- New operator-bindable `KEY_ACTION` `"focus-next-attention"` (NO default chord — mirror
  `effort-cycle`/`open-editor` at `keybindings/types.ts:50-55` so
  `DEFAULT_KEYBINDINGS`/`KEYBIND_TRUTH` stay byte-identical). When bound + pressed, runs the
  resolver over the live `/agents` registry snapshot and (a) prints the top pick as a one-line
  notice and (b) drills it (`/agents inspect <id>`). This is identification only.
- Slash `/attention` — prints agents with real pending questions in oldest-first order and
  exposes the opaque `requestId`. Do not add `/next` as an ungated duplicate registration.
  Wired through `slash-contract.ts:231` like the `agents` getter (reads the registry snapshot
  live each invocation). Because `awaitingInput` is a `TaskRecord` field (정정 2), `/attention`
  is a **PURE stateless resolver over the snapshot** — no new CLI accumulator, no stream/
  protocol consumer, no per-viewer state.
- Add one response verb owned by the same pending-question port, e.g.
  `/attention answer <requestId> <text>`. It rejects unknown, settled, foreign-session, or stale
  ids and never falls back to task id, label, PID, or “latest request.” A successful receipt is
  the waiting child resuming and the marker clearing.

**[PARK] Web (Tauri/embedded):** badge task rows with attention state, `attention.next`
focus-jump to the transcript, `attention.focusMain`, `attention.markUnread`, Codex-mirror
keybindings (`⌘⌥A`/`⌘⌥U`/`⌘⇧U`) under a `QUANTA_WEB_ATTENTION` gate. The true focus-jump
renderer lives in the Tauri/embedded frontend, OUT of this `src/` tree — `subagent-source.ts`
only broadcasts (`web-daemon/subagent-source.ts:42,118`), so a leaf-unit "focus moved"
navigation receipt cannot be closed here (C5). Deferred to the follow-up RFC.

**[DROP] Created-tasks tracker Starting/Working split:** a running row has no `turns`
producer (`result` is populated only after settle — `agents-fleet-panel.ts:36,120`), so
`Starting`(turns===0)/`Working`(turns>0) cannot be derived. Dropped, not parked.

## Default-OFF gate

- **New knob `QUANTA_ATTENTION_NAV`** (CLI). Checked via plain `gateOn(env, …)` —
  **deliberately NOT added to `CLI_FEATURE_GATES` seed list** (`cli-feature-gates.ts:37`; that
  list auto-seeds "1" ⇒ default-ON on interactive CLI; we want default-OFF for a measure-first
  feature; R3). (The web `QUANTA_WEB_ATTENTION` gate is `[PARK]` with the web surface.)
- `QUANTA_ATTENTION_NAV` is resolved once by runtime-config/composition and threaded as an
  explicit optional pending-question port. The loop must not read `process.env` or call a local
  `gateOn(env)` at park sites. Port absent means `request_user_input` behavior and all registry
  bytes remain baseline-identical.
- The pending marker is written at the admitted user-input request owner, not at turn-gate park.
  It is cleared on every terminal outcome. Panel ON / attention OFF remains a required cross-case.
- Composition proves `/agents`, `/attention`, the user-input request owner, and answer delivery
  share the exact same TaskRegistry/pending-question authority instance.
- The resolver/model/CLI-slash are all pure additions reachable only under the gate;
  OFF ⇒ `/agents`, keybindings, subagent frames unchanged byte-for-byte.

## TDD + hellgate

RED e2e first (real `runAgent` × scripted-LLM, `hellgate-implementation-protocol`). v1 slice
= awaiting-input jump only:
1. **[v1] Hellgate RED (delivery receipt):** spawn two children. Child A issues a real
   `request_user_input`; child B completes cleanly and parks for follow-up. Assert only A appears,
   answer A by opaque `requestId`, observe A resume, and observe the pending marker clear. Merely
   rendering A's task id is not sufficient.
2. **[v1] Producer anti-vacuum:** clean completion, interrupted follow-up park, pending wake,
   already-aborted wait, and terminal settle MUST NOT create attention. Injecting a generic
   park-site write must make the test RED.
3. **[v1] Lifecycle race:** answer/decline/cancel/stop/fail/complete each clear exactly once;
   a late answer to a settled request is rejected and cannot resume another child.
4. **[v1] Default-OFF byte-identity — INCLUDING the cross-case (정정 1 / C2)**: two snapshots.
   (a) gate unset ⇒ `renderAgentFleet` output + `subagent` frame bytes identical to baseline.
   (b) **panel-ON (`QUANTA_WEB_SUBAGENTS=1`) + attention-OFF**: drive a real park, assert
   no pending-question field is set and the `subagent` frame / fleet render stay
   byte-identical to the panel-ON baseline. Test #4a alone is vacuous for the leak — 4b is the
   one that catches a park-site write missing its own `QUANTA_ATTENTION_NAV` guard.
5. **[v1] Record-field drift guard:** pending-question metadata is additive and `TaskStatus`
   stays 4-valued — pin that the closed `Record<TaskStatus,…>` GLYPH/colour tables
   (`agents-fleet-panel.ts:88,97`) and `fleet.ts` map are untouched (no new status key). The
   record-field route deliberately avoids the `@/subagent`↔`@/protocol/subagent` event-arm
   mirror, so no 3-mirror drift guard is needed for v1.

Leaf-crate unit only (천공카드 — build is expensive: static-first, leaf units).

## Effort

**v1 explicit-question navigation — M/L, estimate only after owner trace.** Breakdown:
- Pending-question authority + request correlation + lifecycle cleanup: M.
- Shared registry composition and CLI identification: S/M.
- CLI response delivery and real child-resume hellgate: M.
- Web/unread remain separately unestimated and PARKED.

> **Effort correction (정정 4):** the original **M** silently assumed CLI-only awaiting; it was
> understated for the scope the Design once carried. **Full scope** — web focus-jump + unread
> per-viewer cursor + parity split — is **~5–7d and is now PARKED** to a follow-up RFC. Only the
> M-sized awaiting-jump slice above is in scope.

## Risks + traps

- **T1 (R1):** adding a 5th `TaskStatus` value would compile-cascade through every
  `=== "running"` branch (`pendingIds`, `evictIfOverCap`, `ordered`, `countFleet`,
  `fleet.ts` map, panel `GLYPH`/`colourFor`) and silently change settled/running semantics.
  MITIGATION: additive `TaskRecord.awaitingInput` boolean field (정정 2), status stays 4-valued.
- **T2 (R2):** `subagent-source.ts` broadcasts to multiple connections. Task ancestry is not a
  session boundary. MITIGATION: CLI uses its injected session-local registry; a future web
  contract carries explicit session identity and rejects missing/mismatched scope.
- **T3 (R3):** `CLI_FEATURE_GATES` auto-seeds "1" ⇒ accidental default-ON. MITIGATION: use
  plain `gateOn`, keep out of the seed list; verify byte-identity test #4.
- **T7 (정정 1 / C2 — the byte-identity cross-case):** the emitter/registry mirror is present
  under the **panel** gate (`QUANTA_WEB_SUBAGENTS`), NOT the attention gate — so "emitter
  absent ⇒ OFF" is the wrong guard. A park-site write missing its own `QUANTA_ATTENTION_NAV`
  check leaks `awaitingInput` in the panel-ON/attention-OFF cross-case. MITIGATION: gate the
  park-site write on `QUANTA_ATTENTION_NAV` independently; test #4b covers exactly this cross-case.
- **T4:** follow-up park is not awaiting input. Any implementation coupling attention to
  `QUANTA_SUBAGENT_FOLLOWUP` is a RED failure, not graceful degradation.
- **T5 (vacuous):** single-agent priority test proves nothing. MITIGATION: mixed fixture +
  red-on-injection (test #2).
- **T6:** CLI "focus jump" overclaim. MITIGATION: honest degrade wording (select+drill, not
  literal focus move).

## Sequencing (v1 minimal slice)

1. Freeze RED producer rail: generic follow-up park is negative; admitted child question is positive.
2. Bind one pending-question authority to the existing user-input request/completion owner and
   prove all cleanup races.
3. Share that authority with the session-local TaskRegistry and CLI read surface; add pure resolver.
4. Add response delivery by opaque request id; close question → answer → child-resume e2e.
5. Add optional keybinding only after the command receipt is real; measure before default flip.

**Follow-up RFC (`[PARK]`):** web focus-jump surface + keybindings, unread + per-viewer focus
cursor, main-session synthetic root row (Q1). **`[DROP]`:** Starting/Working split (no `turns`
producer), `previousThread`/`focusSideChat` (Q2).

## Open questions

- **Q1:** Should main-session `awaiting_approval` be surfaced as an "agent needing attention"
  row in the fleet at all, or only subagents? (Codex treats main chat as a focus target via
  `focusMainChat`, so likely yes — but the root isn't a `TaskRecord`. Needs a synthetic root
  row or a separate main-session lane in the resolver input.)
- **Q2:** `previousThread` / `focusSideChat` — worth porting, or is `attention.next` cycling
  enough for quanta's non-split model? Lean: skip until split-view exists (Non-goal).
- **Q3:** Should `markThreadUnread` persist across reconnect (per-session) or stay
  per-connection ephemeral? Codex is per-thread; quanta web is per-connection today. Lean
  ephemeral (localStorage) to avoid a new store (Non-goal #2).
- **Q4:** IDE surface — does it consume the same web frames, or need its own binding? (Defer;
  don't gate the feature on IDE availability per surface-model memory.)

---

## Audit log R1 → R3

### R1 — "is the attention state derivable, or does it need new events?"
- **Unread:** fully derivable. `lastActivityAt` folds from existing `subagent_status` +
  `item.*` events; `focusedAt` is a client cursor. **No new backend event.** ✓
- **Awaiting-input (main session):** derivable — kernel `awaiting_approval`
  (`state.ts:35`) is already on the wire snapshot (`snapshot.ts:82`). ✓
- **Awaiting-input (subagent parked on turn-gate):** **NOT derivable.** `TaskRecord.status`
  stays `"running"` while a child is parked awaiting `send_input` (`turn-gate.ts` park;
  `tools-6.ts:296`). The registry never sees the park.
- **CHANGED BY R1:** original sketch reused `subagent_status` by adding an `awaiting-input`
  status value. Rejected — that mutates the closed 4-valued `TaskStatus` and cascades through
  every `=== "running"` branch (running/settled dichotomy), changing OFF behavior. **New
  decision:** additive `subagent_attention` lifecycle arm emitted via the guarded observer-sink
  from turn-gate park/unpark; `TaskStatus` untouched; OFF byte-identical. This is the ONE new
  signal; everything else is derived.

### R2 — "lineage-gate / sibling leak (jul-15)?"
- `subagent-source.ts` publishes to `SUBAGENT_WS_TOPIC` for **all** WS connections; a naive
  resolver over the global fleet could pick another session's blocked agent — the exact
  jul-15 sibling-leak class (`subagent-orchestration-panel` HIGH: foreground spawn crossed a
  gate boundary).
- **CHANGED BY R2:** the resolver was originally `nextNeedingAttention(agents, focusedId)`
  with no scope. Added a required `ownRootId` and a **lineage filter as the first step**
  (`a.rootId === ctx.ownRootId`), plus dedicated test #3 (a sibling-lineage awaiting agent is
  never selected). `rootId` derives from the existing `parentTaskId`/`depth` chain
  (`registry.ts:49/53`) — no new substrate. mark-unread inherits the panel's already-scoped
  visible set (a viewer can only mark what lineage-gating already shows).

### R3 — "surface parity / vacuous tests / default-OFF?"
- **Surface parity:** Codex is `availableIn:[electron]` only. quanta mandate forbids gating on
  surface availability → CLI must ship too. But CLI has no split composer, so literal "focus
  jump" is impossible. **CHANGED BY R3:** CLI action redefined honestly as
  "select-next-attention as target + drill view" (not a focus move); web keeps the true
  focus-jump. No overclaim (trap T6).
- **Vacuous test:** a single-agent or awaiting-only fixture never exercises the
  awaiting-before-unread priority. **CHANGED BY R3:** mandated a MIXED fixture (awaiting +
  *newer* unread + idle) so priority is load-bearing, plus a red-on-injection (flip priority ⇒
  red) — test #2. Guards against the memory `two-way assignability vacuous` / single-literal
  trap.
- **Default-OFF:** `CLI_FEATURE_GATES` **auto-seeds every listed gate to "1"** on interactive
  CLI (`cli-feature-gates-default-opt-in` memory). Adding `QUANTA_ATTENTION_NAV` there would
  make a measure-first, unproven feature default-ON. **CHANGED BY R3:** keep it OUT of the seed
  list, gate via plain `gateOn`, KEY_ACTION operator-bindable-only (no default chord) so
  `DEFAULT_KEYBINDINGS`/`KEYBIND_TRUTH` stay byte-identical; added byte-identity snapshot test
  #4 (trap T3).
- **Residual (self-audit):** the additive `subagent_attention` arm still crosses the
  `@/subagent`↔`@/protocol/subagent` mirror fence — pinned by drift guard #5, same posture as
  the existing `subagent_spawn/status` arms. Q1 (synthetic root row for main-session
  awaiting_approval) left open rather than hand-waved.
