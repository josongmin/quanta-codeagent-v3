# RFC-02 — Observability Absorption (Process Manager · Bash hints · Phase machine · Model-reroute)

**Status**: RE-AUDITED — B1 OWNER CONTRACT FIRST; A8/C2 DESIGN FIRST; B6 NOT READY. Not yet implemented.
**Source audit**: `docs/analysis/aug-02-competitor-corpus-refresh-audit.md` §5 (Process Manager, per-phase activity), §7 (Bash hints, `modelsUsed[]`), §3.5 (`ModelReroute/Verification`).
**Author**: absorption sweep, 2026-08-03.

---

## 2026-08-03 current-HEAD correction (authoritative)

Audit basis: `main@0a00ced392102073fe35eccd202bca92cabd71dc`. 이 절과 아래 과거 초안이 충돌하면 **이 절이 우선**한다. “4개 thin surfacing, ~700 LoC” 총량 주장은 철회한다.

| Item | corrected verdict | owner delta | admission / stop rule |
|---|---|---|---|
| B1 `/ps` | 일반 process manager가 아니라 process-wide **background-shell registry**다. MCP/LSP/subagent/foreground process는 범위 밖이며 현재 `bash_kill`에 own-shell authority guard가 없다. | 먼저 redacted/bounded list-only `/ps`; kill은 exact id 또는 unique prefix + caller ownership/authority 계약 뒤 별도 landing. | raw command/cwd/output secret 노출 금지. ambiguous prefix와 non-owned shell은 no kill. |
| C2 bash hints | “3/5 structured”는 과장이다. stale hint는 prose, passive VCS는 gated/incomplete, timeout은 ms/shellId가 불완전하다. | 기존 `ToolResultEvidence`에 executor가 실제로 아는 typed fact만 추가하고 prose/client/model projection을 fan-out한다. `backgroundCwd`와 `ghRateLimit`은 typed producer가 없으므로 DROP/NOT READY. | shell command/stderr string parser, regex, keyword classifier 금지. detached path 포함 동일 evidence에서 client/model visibility를 검증한다. |
| B6 phase | activity spine은 있으나 live product caller가 미결정이고 status vocabulary는 `done`이지 `completed`가 아니다. | env/worktree setup의 실제 front door와 correlation id를 먼저 선정한 뒤 producer를 붙인다. 기존 workflow/fleet namespace를 재사용하지 않는다. | live caller/surface + front-door RED가 없으면 **NOT READY**. producer-only proof로 완료 금지. |
| A8 reroute | `streamWithModel`은 `from`을 모르므로 owner가 아니다. retry caller, `FallbackLLM`, scheduler는 서로 다른 route semantics다. | `/retry-with`와 scheduler는 기존 `AgentEvent`/recorder에 직접 project한다. `FallbackLLM`에는 최소 structural transition callback만 추가하고 runner가 같은 event로 변환한다. 별도 protocol bus/sink는 만들지 않는다. `modelsUsed`는 initial `llm_request` + transition의 합이다. | adaptive side-call을 main-turn swap으로 기록 금지. from/to/reason와 redaction이 없는 transition 금지. |

실행 순서: **B1 explicit owner contract → list-only → owner-scoped kill → A8 → C2 → B6 caller 결정 후**. 아래 process-wide kill 및 B6 ready 가정은 superseded candidate다.

### SOTA++ direction — canonical facts, multiple projections

- 새 mega event bus/protocol projector를 만들지 않는다. lifecycle은 기존 `AgentActivityEvent`, model routing은 existing `AgentEvent`의 caller-owned arm, bash 결과는 existing `ToolResultEvidence`가 소유하고 CLI/web/OTel/recorder가 pure projection한다.
- 모든 observation은 `{runId,threadId,turnId,operationId,sequence,occurredAt}` 중 필요한 stable correlation을 가진다. event name에는 model/tool/path/id 같은 dynamic 값을 넣지 않는다.
- B1은 trusted operator inventory다. background-shell owner identity는 `register/adopt` 시 caller가 전달해야 하며 shell id/PID/cwd로 추정하지 않는다. 기존 record에 owner가 없으면 list-only가 최종 권한이다.
- C2는 한 번 계산한 execution fact에서 human prose와 model/client hints를 fan-out한다. typed fact가 없는 `backgroundCwd`/`ghRateLimit`은 구현하지 않는다.
- B6는 `@/activity`에 operation-scoped producer를 붙이는 일이다. setup/worktree가 turn 밖에서 발생할 수 있으므로 turn event bridge에 종속하지 않는다.
- A8은 operator retry/fallback/scheduler 각각의 semantic reason을 보존하고, surface의 `modelsUsed`만 공통 ordered projection으로 만든다.
- **중복 금지:** process store, hint envelope, phase state machine, route protocol subtree, weighted classifier를 새로 만들지 않는다. `BashBgRegistry`, `ToolResultEvidence`, `AgentActivityEvent`, `AgentEvent`, recorder adapters를 확장한다.

## 구현 액션리스트 (authoritative)

**SOLID 경계:** runtime registry가 process 사실과 ownership을, tool result가 executor-known evidence를, activity spine이 operation lifecycle을, route caller가 semantic reason을 소유한다. CLI/recorder/OTel은 read-only projection이며 새로운 control authority가 아니다.

### Symbol-level reuse / delete / new ledger

| disposition | existing/new symbol | exact action | 금지되는 평행 구현 |
|---|---|---|---|
| **EXTEND** | `BashBgRegistry`, `getBashBgRegistry` | explicit owner register/list/kill과 bounded snapshot만 추가 | process manager/store/registry 신규 생성 |
| **EXTEND** | `ToolContext`, `buildToolContext` | stable `ownerId`를 composition에서 주입 | bash tool의 PID/cwd/id 기반 owner 추론 |
| **REPLACE CALL** | `bash_kill`의 unscoped `registry.kill` | `killOwned(id,ctx.ownerId)`로 교체 | public/model-facing unscoped kill |
| **EXTEND** | `ToolResultEvidence` | executor-known timeout/background facts만 추가 | hint envelope, stderr/command parser |
| **EXTEND** | `FallbackLLM` options | stateless `onTransition` callback 한 개 | route bus/store/state machine |
| **REUSE** | `AgentActivityEvent`/activity spine | actual operation caller의 phase projection | env/worktree 전용 phase machine |
| **NEW — SURFACE ONLY** | `/ps` slash handler | registry read model을 bounded/redacted render | process lifecycle/kill authority를 CLI에 배치 |

**삭제/대체 완료 조건:** `src/tool/bash/kill.ts`에서 model-facing unscoped kill call이 0이어야 한다. shell command/stderr parsing, 별도 `modelsUsed` store, feature별 activity bus가 diff에 있으면 merge 불가다.

### RFC02-0 — background-shell ownership contract (P0, S-M)

- **Depends:** 없음.
- **Owner/write-set:** `src/runtime/bash-bg-registry.ts`, `src/tool/types.ts`, `src/agent/dispatch/tool-context.ts`, `src/tool/bash/index.ts`, `tests/unit/runtime/bash-bg-registry.test.ts`.
- **Actions:**
  1. `register/adopt` 입력과 `BgShellSnapshot`에 caller-provided `ownerId`를 추가한다. dispatch가 stable session/thread identity를 optional `ToolContext.ownerId`로 전달한다.
  2. registry에 bounded `listOwned(ownerId)`와 `killOwned(id,ownerId)`를 추가한다. exact id/unique prefix resolution은 registry 내부 pure function 하나가 담당한다.
  3. migration 중 owner 없는 legacy entry는 operator list에는 `owner: unknown`으로 보이되 tool/operator kill surface에서는 제거 불가로 둔다. unscoped `kill/killAll`은 host shutdown 전용이다.
- **RED:** 다른 owner가 id를 알아도 kill 성공, ambiguous prefix가 하나를 임의 선택, missing owner가 kill되는 세 fixture.
- **GREEN/DoD:** cross-session refusal, ambiguity refusal, stable ordering/limit, raw stdout/stderr 미노출, gate OFF bash behavior parity.
- **Stop:** PID/cwd/shell id prefix로 owner를 추정하거나 public unscoped kill이 필요하면 중단한다.

### RFC02-1 — `/ps` list-only surface (P0, S)

- **Depends:** RFC02-0의 owner-bearing snapshot; kill은 의존하지 않는다.
- **Owner/write-set:** `src/apps/cli/slash-contract.ts`, `src/apps/cli/slash/registry-surface.ts`, `src/apps/cli/repl/surface-compose/`, 신규 `tests/unit/cli-ps-surface.test.ts`.
- **Actions:**
  1. 기존 slash registry에 `/ps`를 등록하고 caller-owned background shells만 stable id/status/elapsed/exitCode로 render한다.
  2. command/cwd/stdout/stderr는 기본 미노출한다. 진단용 label이 필요하면 producer 단계에서 bounded/redacted display label을 별도 fact로 저장한다.
  3. empty/unknown-owner/terminated 상태를 명시적으로 표시하고 page/limit을 registry contract로 고정한다.
- **RED:** secret-bearing command/cwd/output fixture가 `/ps` 출력에 나타나는 테스트.
- **GREEN/DoD:** list-only, deterministic order, bounded output, non-owner invisible, CLI help/completion과 실제 command 등록 일치.
- **Stop:** `/ps`가 MCP/LSP/subagent/foreground process까지 일반화되면 별도 process-manager RFC로 분리한다.

### RFC02-2 — owner-scoped kill product wire (P0, S)

- **Depends:** RFC02-0, RFC02-1.
- **Owner/write-set:** `src/tool/bash/kill.ts`, `src/apps/cli/slash/registry-surface.ts`, `tests/unit/bash-kill-ownership-hellgate.test.ts`, `tests/unit/cli-ps-surface.test.ts`.
- **Actions:** model tool과 trusted operator command 모두 `killOwned`만 호출한다. exact id 또는 unique prefix 외 입력은 거부하고 result에는 resolved id와 typed refusal reason만 반환한다.
- **RED:** owner A가 owner B shell kill, ambiguous prefix, legacy unowned shell kill.
- **GREEN/DoD:** 세 경우 모두 process가 살아 있고 typed refusal; own exact/unique kill만 성공; shutdown `killAll` 회귀 없음.
- **Stop:** caller owner identity가 없는 surface에서는 kill을 추가하지 않는다.

### RFC02-3 — A8 canonical route-transition projection (P0, M)

- **Depends:** 없음.
- **Owner/write-set:** `src/stream/types.ts`, `src/llm/fallback.ts`, `src/runner/assemble/llm.ts`, `src/apps/cli/retry-with.ts`, `src/scheduler/model-reroute.ts`의 caller, recorder projection tests.
- **Actions:**
  1. existing `AgentEvent`에 `{fromModel,toModel,reason,routeKind,turnId}`를 가진 `model_route_changed` arm을 추가한다.
  2. `FallbackLLMOptions.onTransition`은 structural callback만 제공하고 runner가 event로 변환한다. `/retry-with`와 scheduler caller는 자신이 아는 semantic reason을 직접 project한다.
  3. `modelsUsed`는 initial `llm_request`와 transition을 ordered-dedupe한 projection으로만 계산한다. adaptive side-call은 포함하지 않는다.
- **RED:** retry/fallback/scheduler 각 fixture에서 from/to/reason 또는 ordering이 손실되는 recorder test.
- **GREEN/DoD:** 세 producer가 한 event shape로 surface되고 fallback callback이 lifecycle/store를 소유하지 않으며 gate OFF event stream 동일.
- **Stop:** `streamWithModel`에서 from/reason을 추정하거나 새 route bus/state machine이 필요하면 중단한다.

### RFC02-4 — C2 executor-known bash evidence (P1, M)

- **Depends:** RFC02-0의 background shell id fact.
- **Owner/write-set:** `src/tool/types/tool-result.ts`, bash executor/await result owners, `src/agent/dispatch/`, CLI/model/recorder result projections, 관련 tool-result evidence tests.
- **Actions:**
  1. `ToolResultEvidence`에 executor가 직접 아는 `timeoutMs?`, `backgroundShellId?`, `detached?`만 additive하게 추가한다.
  2. executor에서 한 번 만든 evidence를 model prose, CLI/web, recorder가 각각 pure projection한다. timeout 단위는 ms 하나로 고정한다.
  3. `backgroundCwd`, `ghRateLimit`은 typed producer가 생기기 전 구현하지 않는다.
- **RED:** detached await/timeout path에서 client와 model projection 중 하나만 fact를 받는 테스트.
- **GREEN/DoD:** single evidence source, redaction 유지, no stderr/command regex, 기존 consumers exhaustive/compatible.
- **Stop:** command 문자열 또는 stderr keyword parsing이 들어오면 ticket을 DROP한다.

### RFC02-5 — B6 live operation-phase producer (P1, M; conditional)

- **Depends:** 실제 env/worktree setup front door와 stable `operationId` 선정. RFC06 current-thread worktree이면 RFC06-2 뒤.
- **Owner/write-set:** 선정된 front door, `src/activity/types.ts`, `src/activity/store.ts`, 신규 또는 existing `src/activity/producers/` leaf, product surface integration test.
- **Actions:** front door가 `running`을 시작하고 동일 operation이 `done|failed|skipped` terminal을 emit하게 한다. retry는 새 operation id 또는 명시적 attempt를 사용하며 activity는 effect를 제어하지 않는다.
- **RED:** 실제 CLI/SDK setup을 호출했는데 phase가 없거나 terminal/correlation이 다른 integration test.
- **GREEN/DoD:** live caller→activity store→surface end-to-end, stable vocabulary/cardinality, failure에도 terminal 1개.
- **Stop:** producer만 테스트되고 product caller가 없거나 workflow/fleet namespace를 빌려야 하면 **NOT READY**다.

### Landing rail

1. `bun test tests/unit/runtime/bash-bg-registry-adopt-hellgate.test.ts tests/unit/runtime/bash-bg-registry-behavior-hellgate.test.ts` + 신규 cross-owner kill RED/GREEN.
2. `bun test tests/unit/cli-retry-with.test.ts tests/unit/fallback.test.ts tests/unit/fallback-hellgate.test.ts tests/unit/scheduler-model-reroute-hellgate.test.ts`.
3. `bun test tests/unit/activity/producers-hellgate.test.ts tests/unit/activity/store-render-hellgate.test.ts tests/integration/activity-spine-real-loop-e2e.test.ts`.
4. `bun run typecheck`와 `bun test tests/unit/god-code-ratchet.test.ts`.

`/ps`, owner-scoped kill, C2 evidence는 각각 실제 CLI/tool dispatch fixture가 추가되어야 하며 registry unit GREEN만으로 완료 처리하지 않는다.

## Archived pre-correction draft (non-authoritative)

아래 내용은 최초 gap 가설과 adversarial audit 이력을 보존하기 위한 것이다. 구현 ticket/DoD/노력치는 위 current-HEAD correction과 README만 사용한다. README의 중복/휴리스틱 삭제 register와 충돌하는 archive 항목은 구현 후보로 복구하지 않는다.

### Original motivation

Four observability features from Codex 5973 / Claude Code 2.1.220 align with quanta's **agent-state-observability north-star** ("뭐하고 있나 / 왜 멈췄나 / 다음"), and — critically — **each extends an existing quanta seam rather than inventing infra**. The grounding pass (below) found the substrate for all four already shipped; the gap is a thin surfacing layer, not new machinery.

- **B1 Process Manager** — list/kill running agent subprocesses. Codex `codex.processManager.*` (34 i18n ids). quanta already runs a per-process background-shell registry with kill/killAll/snapshot; there is simply no user-facing *view* onto it.
- **C2 Bash observability hints** — `staleReadFileStateHint`, `backgroundCwdHint`, `gitOperation` (@internal client-vs-model split), `timedOutAfterMs`, `ghRateLimitHint`. Cheap, high-value. quanta already computes 3 of the 5 internally; the gap is a *structured, model-facing hint envelope* + two new hints.
- **B6 per-phase activity state machine** — env/worktree/convo phases `running→completed/failed/skipped`. quanta's activity spine already has a `phase` node kind (L1) and the exact status vocabulary; the workflow producer already emits phase transitions. Gap = an env/worktree producer emitting into the *same* spine.
- **A8 ModelReroute / ModelVerification witness events** — mid-turn model swap observability. quanta has `/retry-with` model swap but emits **no event**, so a surface can't show "this turn ran on a different model."

## Non-goals

- No new control authority. All four are **render-only** (jul-15 doctrine: subagent events are "render-only — the loop never inspects them"). The kill surface (B1) is the sole exception and is scoped as *operator-initiated*, never model-initiated (see Security, R3).
- Not absorbing Codex's on-disk thread store, Guardian approval routing, ExecPolicy prefix-rules, or `SafetyBuffering` (separate RFCs / MED-LOW).
- Not building `ModelVerification` as a *verification* mechanism — only the **witness event** (the reroute/verification *observation*), consistent with §3.5 "LOW (관찰성)".
- No efficacy claim. These are observability; no A/B is proposed (measure-first applies only if a behavior-changing knob is added, which it is not).

---

## Current state (file:line)

### B1 — Process registry substrate ALREADY EXISTS
- `src/runtime/bash-bg-registry.ts:153` `BashBgRegistry` interface: `register`/`adopt`/`get`/`awaitHandle`/`kill`/`killAll`/`size`/`oldestId`.
  - `get(id): BgShellSnapshot|null` (`:180`) → `{id,command,cwd,startedAt,status,stdout,stderr,exitCode}` (`:104`). This IS the process-list row.
  - `kill(id)` (`:537`) escalating SIGTERM→SIGKILL via whole-tree killer `BG_TREE_KILLER` (`:51`, `defaultPpidWalkKiller`).
  - Module singleton `getBashBgRegistry()` (`:593`); test seam `installBashBgRegistry`/`__resetBashBgRegistry` (`:601`,`:606`).
  - **Gap**: no `list(): BgShellSnapshot[]` enumerator (only `size`/`oldestId`); no CLI/web surface.
- Kill tools already wire the registry: `src/tool/bash/kill.ts:35`, `src/tool/bash/await.ts:131` (`getBashBgRegistry()` default arg).
- **No `/ps` command exists** (grep for `processManager`/`process-manager`/`/ps` = 0 hits in `src/apps/cli/`).
- Template for the surface: `/agents` fleet view — `src/apps/cli/slash/registry-surface.ts:261` (`/agents` slash def), renderer `src/apps/cli/agents-fleet-panel.ts:350` (`renderAgentFleet`, pure, injected `now`).

### C2 — Bash hints: 3 of 5 already computed
- `src/tool/bash/index.ts:779` `buildPostBashStaleReminder(ctx, cmd)` (ADR-0474) = **staleReadFileStateHint** — appends a re-read reminder when a write-class command rewrote a previously-read file. No-op when unwired (byte-identical).
- `src/tool/bash/index.ts:791` `maybeEmitPassiveVcs(cmd, body, exitCode, ctx)` (H6, default-OFF `QUANTA_PASSIVE_VCS`) → `src/git/passive-classify/` + `src/agent/git-observability/index.ts` = **gitOperation** classification. Currently routes to the turn-diff bus; the @internal (client-vs-model) split is NOT yet expressed as a field.
- `src/tool/types/tool-result.ts:275` `ToolResultEvidence.timedOut?: boolean` (RFC jul-3 B1) + `src/runtime/bash-bg-registry.ts:170` `adopt()` (auto-background on deadline) = **timedOutAfterMs** substrate. Gap = surface the *ms* + the resulting shellId as a structured hint.
- `ToolResultEvidence` (`:258`): `{stderr,exitCode,executedCommand,fullLogPath,timedOut}`. **No `hints` field.** ← the one additive seam C2 needs.
- **Missing entirely**: `backgroundCwdHint` (backgrounded `cd` is a no-op) and `ghRateLimitHint` (parse `gh` 403/rate-limit stderr).

### B6 — Phase spine ALREADY EXISTS
- `src/activity/types.ts:26` `ActivityKind` includes `"phase"` (L1). `:40` `ActivityStatus` = `pending|running|stuck|idle|done|failed|skipped|stopped` — **exactly** Codex's `running→completed/failed/skipped`.
- `src/activity/producers/workflow.ts:100` already emits `phase_enter`→open phase + close-prior (`done`), `:122` `step_skipped`→`skipped`. The pure reducer is `src/activity/spine.ts`.
- **Gap**: no producer for **env / worktree** phases. Codex `worktreeInitV2.activity.*` (setup-script running→completed/failed) has no quanta analog. `src/activity/producers/` = `{fleet,workflow,side-agent}.ts` only.

### A8 — Model swap has NO event
- `src/llm/model-swap.ts:82` `resolveRetryModel` + `:126` `streamWithModel` (emits a `stream_reset` tombstone, no observation). Wired via `/retry-with` (`src/apps/cli/retry-with.ts`).
- `src/stream/types.ts:173` `AgentEvent` union (`:406` `subagent_spawn`, `:415` `subagent_status`) — **no `model_reroute` arm**.
- `src/stream/types.ts:181` `llm_request` already carries `model`/`provider`/`authMode` — the reroute event is the *transition* between two such requests.

### Reusable substrate for A8/B6 wiring (the pattern to copy)
- `src/protocol/subagent/projection.ts:95` `projectToSubagentObservation(event): SubagentObservation|null` — pure AgentEvent→observation projector, **redaction-gated** (`:87` `boundedRedact` via `redactSecrets` SoT, bounded-then-scrubbed).
- OFF byte-identical gating model: `src/agent/types/wire-slots-runtime.ts:380` `onSubagentEvent?` (optional sink; absent ⇒ event never emitted). Wired ONLY behind a gate at the composition root: `src/apps/web-daemon/runtime-factory.ts:784` `? { onSubagentEvent: (ev) => subagentSource.sink.capture(ev) }` (`:656` "Gate OFF ⇒ undefined ⇒ no sink, no facade, no WS").

---

## Design

Four independent slices, ordered by ROI and disjointness. All default-OFF, all observer-sink gated.

### Slice B1 — Process Manager (list + kill)

1. **Registry enumerator** (`src/runtime/bash-bg-registry.ts`): add `list(): readonly BgShellSnapshot[]` to `BashBgRegistry`, returning `snapshot(h)` for every entry in insertion order. Pure read; no new state; byte-identical to existing `get`/`size` (same snapshot fn). *~8 lines, no god-module risk (807/1000).*
2. **Pure renderer** (`src/apps/cli/proc-panel.ts`, NEW ~120 lines): mirror `agents-fleet-panel.ts` exactly — injected `now`, no TTY detect, `@/ui` colour, `table|json` formats. Row = `{shortId, status(●/✓/✗/⊘), age, command-preview, exitCode}`. Command preview is bounded via `sliceWholeChars` and **scrubbed** (see R3).
3. **CLI `/ps` slash** (`src/apps/cli/slash/registry-surface.ts`): new def mirroring `/agents` (`:261`). `/ps` lists; `/ps kill <id>` calls `registry.kill(id)` and re-renders. Reads the registry via a `ctx`-threaded accessor (NOT a direct module-singleton reach — testability + the gate, see below).
4. **Web** (later wave, `src/apps/web-daemon/`): a `proc-source.ts` mirroring `subagent-source.ts` — a poll-or-tap source fanned to WS subscribers, gated identically. **Deferred to Slice B1-web** to keep the first landing CLI-only (jul-15: land narrow, verify, then fan to web).

**Kill authority**: `/ps kill` is operator-typed (a human at the REPL). The registry `kill` is NOT exposed to the model as a new tool (the model already has `bash_kill` scoped to *its own* shellIds via the tool dispatch path — unchanged). See R3.

### Slice C2 — Bash hint envelope

1. **New optional field** `ToolResultEvidence.hints?: readonly BashHint[]` (`src/tool/types/tool-result.ts`), where `BashHint` is a **closed union** (drift-guarded, see below):
   ```
   | { kind: "stale_read"; path: string }              // staleReadFileStateHint  (rewire existing reminder)
   | { kind: "background_cwd" }                          // backgroundCwdHint  (NEW)
   | { kind: "git_operation"; op: string; internal: boolean }  // gitOperation @internal split  (rewire)
   | { kind: "timed_out"; afterMs: number; shellId?: string }  // timedOutAfterMs  (rewire adopt())
   | { kind: "gh_rate_limit"; resetAt?: number }        // ghRateLimitHint  (NEW)
   ```
2. **Where computed** — a single pure helper `computeBashHints(args): readonly BashHint[]` in a NEW `src/tool/bash/hints.ts` (~90 lines), called ONCE from `bash/index.ts` at the evidence-assembly seam (`:764`), keeping `index.ts` growth to ~3 lines (it is at 807/1000 — MUST NOT balloon).
   - `stale_read`: lift the existing `buildPostBashStaleReminder` (`:779`) result into a structured hint (the prose reminder stays for the model text; the hint is the structured mirror).
   - `background_cwd`: detect a `cd <dir>` **whose command was auto-backgrounded** (adopt path) — a backgrounded `cd` cannot mutate the foreground cwd (Claude's documented no-op). Pure string+adopt-flag check, no heuristic threshold.
   - `git_operation`: reuse `maybeEmitPassiveVcs`'s classification; `internal:true` for client-only ops (fetch/status progress) vs `internal:false` for model-relevant (commit sha / PR number). The **client/model split** = the `internal` boolean (Claude's `@internal` marker made a field).
   - `timed_out`: populate `afterMs` from the deadline + `shellId` from the `adopt()` result already returned at the auto-background seam.
   - `gh_rate_limit`: parse `gh` stderr for the documented `API rate limit exceeded` / `X-RateLimit-Reset` line. Exact-string match, no fuzzy classifier.
3. **Client/model routing** (the @internal contract): hints with `internal:true` (e.g. git fetch progress) are rendered to the **surface** but NOT injected into the model's tool-result text; `internal:false` hints append a terse model-facing note. This mirrors Claude's `gitOperation @internal`. Enforced by a single `partitionHints(hints): {toModel, toClient}` pure fn so the split is one testable seam.

### Slice B6 — Env/Worktree phase producer

1. **New producer** `src/activity/producers/env-phase.ts` (~70 lines) mirroring `workflow.ts` structure exactly: a `EnvPhaseEventLike` structural-mirror union (`{type:"phase_enter",name}` | `{type:"phase_settle",name,outcome:"completed"|"failed"|"skipped"}`) → `AgentActivityEvent[]` (`node_open` kind `phase` + `node_status`). Reuses `wfSeg`/`wfPhaseId` id-namespacing (exported from `workflow.ts:41`).
2. Env/worktree phases (env-prep, worktree-init, setup-script, convo) feed this producer from wherever they run today (the runner's eval driver / worktree setup). The producer is **pure**; the *emission* is gated at the caller (only wired when the activity item-stream is on — same gate as `pumpFleetRowsToItemStream`, `fleet.ts:146`).
3. No new node kind, no spine change — B6 rides the existing `phase` L1 kind + status vocab. This is the smallest slice.

### Slice A8 — Model-reroute witness event

1. **New AgentEvent arm** (`src/stream/types.ts`, add to `AGENT_EVENT_TYPES` + union):
   ```
   | { type: "model_reroute"; from: string; to: string; reason: "operator"|"escalation"|"fallback"; at: number; provider?: string }
   ```
   `reason` is a **closed union** so the three existing swap paths (`/retry-with` operator, adaptive-escalation, `FallbackLLM`) each map explicitly.
2. **Pure projector** `projectToModelRerouteObservation` in a NEW `src/protocol/model-reroute/projection.ts` (~60 lines) mirroring `subagent/projection.ts` — including `boundedRedact` via the `@/security` SoT even though model ids are low-risk (defense-in-depth; a `reason` string or future field could carry text).
3. **Emission**: at `streamWithModel` (`model-swap.ts:126`) the swap already knows `from`/`to`; thread an optional `onModelReroute?` sink (mirror `onSubagentEvent`) and emit at swap time. Absent sink ⇒ no event (byte-identical). The adaptive-escalation controller and `FallbackLLM` emit the same arm at their swap points.
4. Surface: the CLI turn header / web can render "↻ gpt-5 → opus (escalation)". `AgentOutput.modelsUsed[]` (Claude parity) is a **derived** projection of the reroute event stream, not new state.

---

## Default-OFF gate (all four)

Each slice is gated so that **with the gate unset, zero bytes change** on every existing wire/render path (jul-15 lesson: a *foreground spawn that registered* changed `task_list` and broke OFF parity — the fix was observer-sink gating; we apply it up front).

| Slice | Gate | OFF behavior |
|---|---|---|
| B1 list/kill | `QUANTA_PROC_PANEL` gates the `/ps` command registration + web source. `list()` itself is a pure read added to the interface but **never called** unless a surface is wired. | `/ps` absent; registry untouched; `bash_kill` model tool unchanged. |
| C2 hints | `hints` field is `?optional`; `computeBashHints` is only *called* when `QUANTA_BASH_HINTS` is on. Unset ⇒ helper never runs, `evidence.hints` undefined, model text byte-identical. | Existing `stale_read` reminder prose + `PASSIVE_VCS` bus stay exactly as today. |
| B6 phase | Producer is pure; emission gated by the same `itemStreamEnabled(env)` check that gates `fleet`/`workflow` producers (`fleet.ts:150`). | No env-phase nodes minted; `/activity` byte-identical. |
| A8 reroute | `onModelReroute?` sink optional; wired only behind `QUANTA_MODEL_REROUTE_EVENT` at the composition root (mirror `runtime-factory.ts:784`). | No `model_reroute` event; recorder never sees it; swap behavior unchanged. |

**Byte-identical proof obligation** (per slice): a `capturing-sink OFF` test asserting the wire array is deeply-equal to the pre-change baseline, PLUS the god-code / recorder-KIND_MAP ratchets stay green.

---

## TDD + hellgate plan

Per hellgate (RED e2e → TDD → 3R adversarial → self-audit), **real-loop fake-LLM e2e, not stub units** (jul-15: `runAgent × scripted-LLM == 0` exposed 43 gaps — the metric here is *does the observation reach the wire through the real loop*, not *does the projector return a shape*).

- **B1**: RED = a real bash-bg-registry with 2 live fakes → `/ps` renders 2 rows, `/ps kill <id>` flips one to `killed` and the child's `kill` closure fired (observe the fake handle's kill count, not just the snapshot status — *real effect*). Paired-control: an unknown id → "not found" box, registry unchanged.
- **C2**: RED = real loop, scripted-LLM issues (a) a write-class bash after a read → `stale_read` hint present + `internal:false`; (b) a backgrounded `cd` → `background_cwd`; (c) a `gh` cmd with rate-limit stderr → `gh_rate_limit`. Assert the model-facing text contains only `internal:false` hints and the client render contains all — the **partition** is the load-bearing assertion. Red-on-injection: flip `internal` on the git hint → the model-text test must go red.
- **B6**: RED = feed an env-phase producer a `setup-script failed` sequence → `/activity` snapshot has a `phase` node with status `failed` under the run root. Injection: change producer to emit `done` on failure → spine derived-status test goes red.
- **A8**: RED = real loop with a scripted `/retry-with` swap → exactly one `model_reroute{from,to,reason:"operator"}` on the wire; `modelsUsed[]` derived projection = `[from,to]`. Injection: suppress the emit → the wire-assert goes red (proves non-vacuous wiring, not a stub).
- **Drift ratchets**: (a) `BashHint.kind` and `model_reroute.reason` are closed unions → a `Record<Kind,…>`/exhaustive-switch pin so a new arm fails compile (exhaustive-record-classification-drift-guard pattern). (b) `AGENT_EVENT_TYPES` array ⊇ union already guarded by `satisfies`; add the new arm to both. (c) recorder `KIND_MAP` — `model_reroute` must be classified (durable) or explicitly SKIPPED like `subagent_*`/`item_*` (`stream/types.ts:403`); a drift-guard asserts every AgentEvent type is either mapped or skip-listed.

---

## Effort

| Slice | New/edited files | LoC | Notes |
|---|---|---|---|
| B1 (CLI) | `bash-bg-registry.ts` (+list), `proc-panel.ts` (new), `registry-surface.ts` (+/ps) | ~180 | Renderer is a near-copy of fleet-panel. |
| B1-web | `proc-source.ts` (new), `runtime-factory.ts` (+gate) | ~120 | Deferred to a 2nd wave. |
| C2 | `tool-result.ts` (+hints field), `bash/hints.ts` (new), `bash/index.ts` (+3 lines) | ~140 | Reuses stale-reminder + passive-vcs. |
| B6 | `producers/env-phase.ts` (new), caller wiring | ~110 | Smallest; rides existing spine. |
| A8 | `stream/types.ts` (+arm), `model-reroute/projection.ts` (new), `model-swap.ts` (+sink), composition wiring | ~150 | Mirror of subagent projection. |

**Total ~700 LoC** across 4 disjoint slices; each independently landable. No god-module created (all new files < 200; `bash/index.ts` +3 stays under 1000).

## Risks + traps

- **T1 — bash/index.ts god-module ceiling (807/1000)**. Mitigation: ALL C2 hint logic in `bash/hints.ts`; index gains only the call + spread. Verify with the god-code ratchet.
- **T2 — OFF byte-identical regression via a "harmless" read** (jul-15). Even `list()` being *added* is safe only because nothing calls it OFF; the /ps registration itself must be gated, not just the render. A registration that always installs a command changes `/help` output → OFF parity break. The `/help` catalog test is the canary.
- **T3 — redaction bypass** (jul-15 HIGH: raw record render bypassing scrub). Command strings in `BgShellSnapshot` and reroute/hint payloads cross to a UI ⇒ MUST route through `redactSecrets` (the `@/security` SoT), bounded-then-scrubbed, exactly like `subagent/projection.ts:87`. A raw `snapshot.command` rendered directly = a secret leak (a bash cmd can contain a token in an env-inline or a URL). See R3.
- **T4 — kill authority escalation** (security). `/ps kill` reaping *any* registered shell is fine for an operator; it must NOT become a model tool that can kill sibling agents' shells. The registry is process-wide; a model-facing kill scoped only to its own shellIds already exists (`bash_kill`). See R3.
- **T5 — vacuous projector tests**. Testing `projectToModelReroute(x) === shape` proves nothing (jul-15). The test must drive the **real loop** and assert the event **reaches the wire**, with a red-on-injection control.
- **T6 — recorder KIND_MAP drift**. A new `model_reroute` AgentEvent not in `KIND_MAP` and not skip-listed = a runtime classification gap. The exhaustive drift-guard is mandatory, not optional.
- **T7 — concurrent-session git hazard** (memory): land each slice on its own branch off freshly-confirmed HEAD; no ref rewrite.

## Sequencing

1. **B6** (smallest, self-contained, rides existing spine) — proves the producer+gate pattern.
2. **A8** (mirror of subagent projection; highest observability value; touches the event union → get the ratchet in early).
3. **C2** (reuses 3 existing computations; the partition/@internal split is the subtle part).
4. **B1-CLI** (new surface; land narrow), then **B1-web** as a follow wave.

Each slice: RED e2e → TDD → 3R adversarial → self-audit → land default-OFF → verify god-code + OFF-parity ratchets green.

## Open questions

- **OQ1** Should `bash_kill` (model tool) and `/ps kill` (operator) share one authority path, or stay split? Leaning **split** (model scoped to own shellIds; operator process-wide) — the split IS the security boundary (R3).
- **OQ2** For A8, is `model_reroute` durable (recorded in the trajectory) or transient render-only like `subagent_*`? Trajectory value is real (post-hoc "which model solved this turn"). Leaning **durable** → needs a `KIND_MAP` entry, not a skip. Decide before landing (affects the drift-guard branch).
- **OQ3** B6 env/worktree phase *source* — do env-prep / worktree-init already emit a structured lifecycle we can adapt, or must we instrument the call sites? Grounding found the spine + producer pattern but not an existing env-phase event source; needs a code pass on the runner eval driver before B6 estimate firms up.
- **OQ4** C2 `gh_rate_limit` — parse stderr (fragile to `gh` version) vs shell out to `gh api rate_limit` (a network call in the hint path, unacceptable). Leaning stderr exact-match with a conservative miss (no hint) rather than a false positive.

---

## Audit log

### R1 — OFF byte-identical & god-code (structural)

- **[FOUND, HIGH] B1 `/ps` registration breaks OFF parity even if render is gated.** First draft gated only the *render*, leaving the slash-command always registered → `/help` catalog changes → OFF not byte-identical (T2, the exact jul-15 foreground-spawn shape). **FIX**: gate the *registration* behind `QUANTA_PROC_PANEL`; `/help` catalog test is the canary. Folded into the Default-OFF table.
- **[FOUND, MED] bash/index.ts at 807/1000.** Adding hint computation inline would risk the god-module ratchet within a few slices. **FIX**: all C2 logic in `bash/hints.ts`; index +3 lines only (T1).
- **[FOUND, MED] `list()` added to the interface is called by tests OFF.** A test that calls `list()` with the gate off is fine (pure read), but if the *production* /activity or /agents path ever calls it, that's a latent OFF-path read. **FIX**: `list()` is called ONLY from the gated proc surface; no existing surface calls it. Documented in Slice B1.
- **[CLEAR] B6** rides existing `phase` kind + status vocab — no spine/type change, lowest OFF-risk. Confirmed against `activity/types.ts:26,40`.

### R2 — Vacuous tests & wiring proof (behavioral)

- **[FOUND, HIGH] Projector-shape tests are vacuous.** `projectToModelReroute(ev) === expected` and `computeBashHints(args) === [...]` prove the pure fn, not that the observation *reaches a surface through the real loop* — the exact class jul-15's `runAgent × scripted-LLM == 0` metric caught. **FIX**: every slice's crown test drives the **real loop with a scripted LLM** and asserts the wire; the pure-fn test is demoted to a supporting unit. Added T5 + rewrote the TDD section around real-loop e2e.
- **[FOUND, MED] Red-on-injection missing.** Without an injection control, a wire-assert can pass because the harness itself emits the event. **FIX**: each slice specifies a named injection (suppress emit / flip `internal` / emit `done` on failure) that MUST turn the crown test red. Added to TDD.
- **[FOUND, MED] `modelsUsed[]` (Claude parity) could drift from the event stream** if stored separately. **FIX**: `modelsUsed[]` is a **derived** projection of `model_reroute` events, never independent state (matches jul-15 "single source" spine rule). Stated in Slice A8.
- **[FOUND, LOW] Recorder KIND_MAP drift for the new AgentEvent.** `model_reroute` unmapped+unskipped = silent classification gap. **FIX**: mandatory exhaustive drift-guard (T6); OQ2 decides durable-vs-skip.

### R3 — Redaction leak & kill authority (security)

- **[FOUND, HIGH] Raw `snapshot.command` / hint payloads render un-scrubbed = secret leak.** A bash command line routinely contains tokens (`curl -H "Authorization: Bearer …"`, `PGPASSWORD=… psql`, a URL with creds). The B1 proc-panel and C2 hints cross to a UI; a direct `snapshot.command` render is the jul-15 HIGH "raw record render bypassing redact." **FIX**: every UI-crossing string (proc-panel command cell, `stale_read.path`, `git_operation`, reroute payload) routes through `redactSecrets` (`@/security` SoT), bounded-then-scrubbed, exactly like `subagent/projection.ts:87` `boundedRedact`. The proc-panel renderer takes ALREADY-scrubbed rows (scrub at the projection boundary, not the renderer — so a second caller can't bypass). Added T3.
- **[FOUND, HIGH] `/ps kill` as a model tool = sibling-agent kill authority.** If the kill path were exposed to the model, one agent could reap another agent's (or the operator's) shells process-wide — an authority escalation. **FIX**: `/ps kill` is operator-typed only; the model keeps `bash_kill` scoped to its own shellIds (unchanged). The split IS the boundary (OQ1). Added T4; kill authority stated in Slice B1 + Non-goals.
- **[FOUND, MED] `git_operation internal:true` could hide a security-relevant op from the model.** The @internal split is for *noise reduction* (fetch progress), not for hiding auth failures. **FIX**: `internal:true` is reserved for progress/status noise; anything carrying an error, a permission failure, or a rate-limit is `internal:false` (model-relevant). `gh_rate_limit` is always model-facing. Encoded in the `partitionHints` contract.
- **[FOUND, LOW] `killAll` on session shutdown vs `/ps kill` race.** Both call the same idempotent `kill`; `bash-bg-registry.ts:99` documents `kill` as idempotent + safe post-exit. No fix needed; confirmed benign.

**Convergence**: R3 surfaced no new HIGH beyond the two anticipated classes (redaction, kill authority), both with concrete fixes traced to existing SoT seams. R1/R2 findings all fold into the Default-OFF gate + real-loop-e2e TDD sections. Remaining risk is scoped to the open questions (OQ2 durable-vs-skip, OQ3 env-phase source), each requiring a code pass before that slice's implementation — consistent with "백로그=무덤, 착수 전 코드-먼저 대조."
