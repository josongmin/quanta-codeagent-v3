# ADR-0540: 인라인 resumable 승인 resolver — turn-loop이 승인을 in-line await하고, 재설계로 "SDK가 다 처리"를 진짜로

- **상태**: Proposed
- **날짜**: 2026-07-16
- **슬라이스**: `@/agent/loop`(runAgent에 async 승인 resolver 포트 주입 + in-line await) · `@/host/runtime/internal/context-binding/approval-protocol`(inline path 승격, deferred/throw path 은퇴) · `@/kernel/session/scheduler`(`awaiting_approval` 를 turn-END에서 turn-INTERNAL checkpoint로) · `@/kernel/session/state`(reload 시 `awaiting_approval` rehydrate) · `@/runner/orchestrate/session-turn-driver`(`for(;;)` 승인 루프 제거 → `append+run`) · `@/apps/web-daemon`(resolver = WS round-trip) · `apps/web-frontend`(`shouldContinueAfterApproval` + client `turn.run` 재발행 제거) · biome fence(`src/apps/**` → turn-driver import 금지)
- **게이트**: 신규 `QUANTA_INLINE_APPROVAL_RESOLVER`(default-OFF, 마이그레이션 전환 게이트 — Wave2 종료 시 제거). OFF ⇒ 현 deferred/throw+lease 경로 byte-identical.
- **관련**:
  - 은퇴/재설계 대상: **ADR-0303**(session-turn-driver 추출 — CLI에서 `for(;;)` 승인루프를 `@/runner`로 hoist. 본 ADR이 그 루프 자체를 engine으로 밀어 소멸시킴), **ADR-0512 P3**(승인 scope once/session + steer — resolver 반환 타입으로 보존), **ADR-0528/0525**(crash-resume 마커 — 유저텍스트만 복원. 본 ADR이 pending-approval까지 resumable로 확장)
  - 재사용(신축 금지, **직접검증**): `runOnConfirm` inline path([approval-protocol.ts:214-237](../../src/host/runtime/internal/context-binding/approval-protocol.ts)) = **이미 CLI LIVE** · `AgentConfig.onConfirm` async 콜백(gate에서 in-line await, [gates.ts:414](../../src/agent/admissibility-gate/gates.ts)) · `surfaceConfirms` 스택+`confirmSlot`+`chain` 직렬화+`midTurnApprovalChannel` · `interactive` 선택자(context-binding.ts:66) · `claimLease`(:88-103, replay short-circuit으로 개념 이관) · `approval.requested`/`approval.resolved` emit(scheduler.ts ~203-255, **단 event log는 in-memory only**) · daemon replayWindow(ws-handlers.ts)
  - 메모리: `implementation-baseline-from-competitors`(Codex/Claude 흡수), `agent-state-observability-northstar`(crash 후 "뭐 하다 멈췄나"), `surface-model`(멀티서피스 대칭)

## Context

### 관측된 결함: turn-completion 루프가 client edge로 샌다

승인이 필요할 때 우리 커널은 turn을 **끝낸다**: agent loop이 `RuntimeApprovalRequiredError`를 throw([approval-protocol.ts:268](../../src/host/runtime/internal/context-binding/approval-protocol.ts)), host가 잡아 return값으로 변환([turn-runner.ts:185-192](../../src/host/runtime/internal/context-binding/turn-runner.ts)), 커널이 `status:"awaiting_approval"`로 turn을 종료+persist([scheduler.ts](../../src/kernel/session/scheduler.ts) `onApprovalRequested`), 다음 `turn.run`이 lease를 claim해 재디스패치([approval-protocol.ts:88-103](../../src/host/runtime/internal/context-binding/approval-protocol.ts)). 이 "return-on-approval + caller가 재발행" 모델이 continuation을 **호출자에게 흘린다**:

- **in-process**(CLI/headless/terminal/agent-interactive): [`driveSessionTurn`의 `for(;;)`](../../src/runner/orchestrate/session-turn-driver.ts) (`@/runner/orchestrate`, ADR-0303)가 재실행 루프를 소유. 4개 앱이 SDK를 우회해 이걸 직접 import.
- **wire**(웹): daemon은 `turn.run`을 raw로 forward(driveSessionTurn 안 탐), 브라우저가 [`shouldContinueAfterApproval`](../../apps/web-frontend/src/ws/session-hooks.ts) predicate로 판정 후 bare `turn.run`을 **재발행**([session-hooks.ts:995-1002](../../apps/web-frontend/src/ws/session-hooks.ts)). 승인-후-계속 로직이 브라우저에 실재.

즉 substrate가 `@/sdk/runtime`(dispatch) + `@/runner/orchestrate`(turn 루프) **2겹**이고, 어느 것도 SDK 주권으로 강제되지 않는다(fence는 `@/runner`→apps 단방향뿐). "SDK가 다 처리"는 서사다.

### Grounding: Codex와 Claude 둘 다 우리와 반대 (인라인 suspend-and-continue)

`.extracted_source` 실측:
- **Codex**(`core/src/session/turn.rs`, `mcp-server/src/exec_approval.rs`): core가 turn 루프 소유. 승인 시 `ThreadStatus::WaitingOnApproval`로 **같은 turn을 서버측 suspend**하고 응답 await. 클라는 답만, run 재발행 없음.
- **Claude Agent SDK**(`createCanUseToolFn`/`canUseTool`): SDK가 루프 소유. 승인 = 주입된 async 콜백을 **in-line await**. 소비자는 `run()` 한 번 + 콜백 제공.

**공통 SOTA 불변식**: *core가 루프를 갖고, 승인은 in-line suspend-and-continue로 풀고, 클라는 답만 한다.* 우리는 유일한 아웃라이어이고, 그 아웃라이어성이 위 leak의 뿌리다.

### 반전: 우리 "durability 우위"는 신화였다

현 모델을 정당화하던 "turn 경계 = persisted checkpoint라 resumable" 명분은 **검증 결과 latent+broken**:
- reload 시 [state.ts:108 `createKernelSessionState`](../../src/kernel/session/state.ts)가 **무조건** `status:"idle"`, `pendingApproval:null`로 리셋 → sqlite에 persist된 pendingApproval을 버림.
- crash-resume는 유저텍스트만 재주입([crash-resume.ts](../../src/session/crash-resume.ts)), 승인상태 무시.
- "awaiting_approval → reload/reconnect → 승인 답변 → 툴 디스패치" **테스트 0개**.
- 유일하게 동작: **라이브 데몬에 브라우저 재접속**(같은 프로세스, 인메모리 state 생존) — event log 덕이 아니라 데몬이 안 죽어서. 이건 suspended-continuation 모델(Codex SSE 재조인)도 공짜로 준다.

⇒ crash 케이스에선 우리도 Codex/Claude와 똑같이 잃는다. **continuation을 client로 흘려 얻은 실질 이득 = 0.** 따라서 인라인 resolver는 기존 guarantee를 **보존**하는 게 아니라, 가진 줄 알았던 durability를 **비로소 짓는다** — 퇴행 리스크가 아니라 순수 신규 capability.

### ⚠️ 직접검증(2026-07-16): 인라인 resolver는 CLI에 이미 LIVE — 재발명 금지

적대 discovery 어딧 2회 + 소스 직접확인 결과, **본 ADR이 "짓겠다"던 in-line suspend-and-continue는 이미 구현·배선·default-ON(CLI)·hellgate-pinned다.** jun-10 HITL restructure가 정확히 같은 동기(deferred 재실행이 승인당 ~140k 토큰 재지불)로 이미 만들었다.

- [`runOnConfirm`(approval-protocol.ts:209-238)](../../src/host/runtime/internal/context-binding/approval-protocol.ts): `if (deps.interactive && surface !== undefined)` → `await surface(action)`로 **gate에서 즉시 물어보고 결정을 그대로 반환. pending 없음·turn abort 없음·re-run 없음.** 주석이 명시: *"The deferred mint+throw below remains for surfaces without an operator (web/SDK)."*
- 주입 콜백 = `AgentConfig["onConfirm"]`(async), [gates.ts:414](../../src/agent/admissibility-gate/gates.ts)·[hitl.ts:304](../../src/agent/admissibility-gate/hitl.ts)서 `normalizeConfirm(await config.onConfirm(action))`로 **mid-dispatch in-line await → 같은 turn 계속**. = canUseTool 아날로그, 이미 배선(231 refs).
- 선택자 = plain boolean [`approvalProtocol.interactive`](../../src/apps/cli/repl/runtime-context-compose.ts)(:654 `interactive: true` 하드와이어, **게이트 아님**) → [context-binding.ts:66](../../src/host/runtime/internal/context-binding.ts). CLI만 켜져 있음.
- 봉인: `src/host/runtime/internal/__tests__/approval-inline-interactive.hellgate.test.ts`(interactive ⇒ delegate no-throw; absent ⇒ legacy throw+pending).

**⇒ 실제 델타 재정의**: "인라인 resolver를 짓는다"가 아니라 **이미 CLI에서 도는 인라인 머신러리(`onConfirm`·`surfaceConfirms` 스택·`confirmSlot`·`midTurnApprovalChannel`·`chain` 직렬화)를 deferred 서피스(web-daemon/headless/SDK)로 확장**하는 것. 그 서피스들은 `interactive`를 안 켜서 여전히 throw→deferred→`for(;;)` 재실행을 탄다.

### DEAD 스캐폴드(오인 금지)

- **ADR-0403 `src/agent/approval-state-machine/`**: `resumeStep`은 **display string**(attribution), 실행 재개 아님. DEAD-UNWIRED(gate로 web-daemon에 threaded되나 관측/귀속 레이어).
- **ADR-0407 `src/agent/approval-gate-wire/wire.ts`**: resolver-wrapping 어댑터, live caller 0. DEAD-UNWIRED.
- 둘 다 durable resume 아님 — 이걸 resume으로 착각해 그 위에 짓지 말 것.

## Decision

**목표 아키텍처**: agent loop(runAgent)에 async 승인 resolver 포트를 주입한다. 승인 필요 시 loop이 **in-line await**하고 **같은 turn을 계속**한다. resolver를 event-log에 대해 **replayable**하게 만들어 crash/reconnect resumability를 first-class로 짓는다. turn-driver의 `for(;;)`·브라우저 predicate·lease-on-next-turn(happy path)이 소멸하고, apps는 `@/sdk/runtime` 단일 seam + resolver 주입만 소비한다.

### 핵심 계약: `ApprovalResolver` 포트 (canUseTool 씨앗)

```
type ApprovalResolver = (approval: PendingApproval, ctx: ResolverCtx) => Promise<ApprovalDecisionResult>
// ApprovalDecisionResult = 기존 wire union (ADR-0512: approve/deny + scope + steer) 재사용
```

- 세션/agent 생성 시 **컴포지션 루트에서 주입**(현 approval surface seam과 동형). surface별 유일 구현점:
  - **CLI**: TTY 프롬프트 await (기존 `setup.approvalPrompt` 재사용)
  - **headless**: auto-policy (default approve/정책) — 즉시 resolve
  - **web-daemon**: `approval.requested` WS emit + 매칭 `approval.respond` command await (**서버측 suspend**, Codex형)
- runAgent 내부 `runOnConfirm`이 deferred-throw 대신 **`await resolver(...)`** → 결정 받으면 같은 turn 계속. 브라우저/드라이버 어느 쪽도 재발행 안 함.

### Wave 1 — 인라인 머신러리를 headless로 확장 + web leak을 daemon-ownership로 봉합

> **hellaudit 수렴(적대+객관 2시선, 12에이전트) + 직접검증 후 확정.** 핵심 결론: (a) web naive-inline = **데드락**([engine.ts:57](../../src/sdk/runtime/session/engine.ts) `transportDispatchQueue` 직렬화 — turn.run이 큐 점유한 채 approval.respond await), (b) 인라인은 정말 CLI 전용(agent/interactive·terminal은 driveSessionTurn deferred 드라이버 사용), (c) mid-turn out-of-band 왕복 substrate는 이미 있음([web-user-input-port](../../src/apps/web-daemon/web-user-input-port.ts) — dispatch 큐 밖 resolve). 그래서 W1을 두 조각으로 최소화:

**W1-A — headless 인라인 (스파이크 선행, 첫 착지):**
- headless 컴포지션에 `approvalProtocol: { confirmSlot, interactive: true }` (confirmSlot.current = auto-policy surface) 추가 — 게이트 ON일 때만. throw→deferred→재실행([index.ts:186 driveSessionTurn](../../src/apps/headless/index.ts)) 대신 same-turn 인라인. 머신러리(`onConfirm`·`surfaceConfirms`·`chain`) **재사용, 신축 0**.
- **게이트는 컴포지션 레벨**(신규 서피스만 opt-in): `QUANTA_INLINE_APPROVAL_RESOLVER` OFF ⇒ headless는 approvalProtocol 미설정 ⇒ 현 deferred(오늘) byte-identical. **`approval-protocol.ts`는 안 건드림, CLI도 안 건드림**(이미 출시된 CLI 인라인 퇴행 방지 — "byte-identical OFF"는 pre-jun-10이 아닌 *오늘 프로덕션* 기준).

**W1-B — web browser leak을 daemon-ownership로 봉합 (헤드리스 검증 후):**
- 데드락 때문에 web은 inline 안 함. 대신 **continuation 소유권을 브라우저→daemon으로 이관**: `approval.respond` 처리 후 daemon이 `turn.run`을 서버측 재발행(현재 브라우저가 하는 걸 서버로). 브라우저 [`shouldContinueAfterApproval` + client turn.run 재발행](../../apps/web-frontend/src/ws/session-hooks.ts) 삭제 → 렌더+respond만. approval.respond 완료 **후** turn.run 디스패치 = 순차, 데드락 없음.
- 진짜 web-inline(out-of-band holder, web-user-input-port 패턴으로 서버측 suspend) = payoff가 durability라 **W2로 연기**.
- **표식 예약(from [jul-16-transport-unified-sdk 01 §3.3](../plans/jul-16-transport-unified-sdk/01-connect-session-handle.md))**: daemon 재발행 랜딩 시 capability manifest에 `server-auto-continues`(additive) 선언 — 공개 SDK wire 클라(현행 deferred 플로우를 hoist해 승인 후 재발행)가 표식을 보고 재발행 생략, 미탑재 구클라의 이중 turn.run은 서버측 무해화. 표식 설계는 양쪽 공동 소유, 먼저 랜딩하는 쪽이 예약만.

**W1에서 제외(판단):** approval.requested inline-emit(CLI가 한 달간 이거 없이 출시 → follower 블로커 아님, known-gap로 검증) · biome turn-driver fence(cli/headless가 정당히 직접 사용 → whitelist가 목적 훼손, 보류) · CLI 게이트(퇴행). crash durability는 오늘과 동급(broken) — W2에서 처음 지어짐.

### Wave 2 — 진짜 durability (resumable resolver)

> **⚠️ load-bearing 정정(직접검증)**: 본 ADR 초안이 가정한 "이벤트로그가 이미 messages/tool_result 영속"은 **틀렸다.** `KernelEventLogPort` 구현체는 [`InMemorySessionEventLog`](../../src/kernel/session/event-log.ts) **하나뿐**이고 persistence는 [`new InMemorySessionEventLog()`](../../src/host/runtime/persistence.ts)가 전부 — **온디스크 이벤트로그가 없다.** 디스크 durability는 별경로(`SessionMeta`/history via [resume-fsm](../../src/runner/orchestrate/resume-fsm.ts))로 존재하나 event log는 프로세스와 함께 소멸. **주의(모순 해소, hellaudit)**: web-daemon [`persistence-sqlite.ts`](../../src/apps/web-daemon/persistence-sqlite.ts)가 SessionEvent(approval.requested/resolved 포함)를 디스크에 archive하지만 — KernelEventLogPort와 **orthogonal**(별도 append 루프, zero 통합), **read-only observer**(history UI/미래 replay용, restart 시 rehydrate 안 함), **truncated**(~256자 tool args), seq-index 아님 — **W2 substrate로 재사용 불가**. 따라서 W2의 실제 load-bearing 선행조건은 "resolver를 resumable하게"가 아니라 **신규 온디스크 KernelEventLogPort(Codex rollout JSONL형)를 먼저 짓는 것**.

0. **온디스크 이벤트로그(신규 substrate, 진짜 병목)**: `KernelEventLogPort`의 append-only 디스크 구현(Codex rollout JSONL형). 이게 없으면 아래 1-4 전부 불가. **외부 요구(from [jul-16-transport-unified-sdk 05](../plans/jul-16-transport-unified-sdk/05-durable-resume-composition.md))**: 재시작 후 seq를 로그 tip에서 **이어 발급**(연속성) — 현행은 재시작 시 0부터([bridge.ts:71-77](../../src/ipc/session/bridge.ts) 주석 명시), 연속성 없으면 wire `connect({resume})` 시맨틱 정의 불가(그 티켓이 이 요구의 witness).
1. **persist-before-await**: resolver await 전 pending-approval을 안정적(결정적) `approvalId`로 (디스크) event log에 기록(`awaiting_approval` = turn-END가 아닌 turn-INTERNAL checkpoint).
2. **replay short-circuit**: 프로세스 재시작 → turn을 persisted transcript로 replay → 같은 승인점 도달 시 resolver가 **먼저 로그 조회**: 이미 `approval.resolved` 있으면 즉시 반환(재프롬프트 없이 결정적 계속), 없으면 `approval.requested` 재emit + 재await. [claimLease](../../src/host/runtime/internal/context-binding/approval-protocol.ts)(현재 in-memory Map, turn-scope마다 drain)의 개념이 여기로 이관.
3. **reload rehydrate**: [state.ts:108](../../src/kernel/session/state.ts)이 무조건 `idle`/`pendingApproval:null` 리셋 — persisted `awaiting_approval`+`pendingApproval` 복원하도록 수정. (반쯤 지어진 버전 없음 = 완전 부재 확인.)
4. **전제**: turn이 승인점까지 **결정적 replay 가능**해야 함(LLM 재샘플 아닌 persisted transcript 재생 — Codex rollout replay와 동형).
5. **crash-resume 확장**: 새 레이어 짓지 말고 [ADR-0525/0528 마커](../../src/session/crash-resume.ts)(현재 userText만)를 pending-approval 운반까지 확장.
6. Wave2 종료 시 게이트 제거, deferred/throw/lease 코드 삭제.

### seam 붕괴 + fence

Wave1 후 `driveSessionTurn`의 루프 소멸 → turn primitive가 engine으로. `@/runner/orchestrate` 잔여(resume FSM·persist·side-chat·crash-resume-wire)는 라이브러리로 유지. apps는 `@/sdk/runtime`(createSession + attachTransport + resolver 주입) **단일 seam**만 소비. biome fence로 `src/apps/**`의 turn-driver import 금지 → "SDK가 다 처리"가 **진짜+강제**.

## Consequences

- **긍정**: SOTA parity(Codex/Claude) + 그들에 없는 durable resumable 승인. 단일 loop·단일 seam·대칭 서피스·client thin. leak 3종(runner `for(;;)`, 브라우저 predicate, 2겹 seam) 소멸.
- **비용**: 커널 불변식 변경 = 7+ 레이어(runAgent 시그니처, throw/catch/return, `awaiting_approval` 의미, lease, engine 표면화). 깊고 마이그레이션 게이트 필요.
- **리스크**: (a) Wave2의 "결정적 replay" 전제 — turn이 승인점까지 재생 가능해야. 스파이크로 검증. (b) 동시세션이 커널 hot-path 편집 → 순차 웨이브 + hard-reset staleness 가드. (c) ADR-0512 scope/steer는 resolver 반환타입으로 보존(회귀 금지).

## Hellgate (RED 먼저)

1. **headless/web 인라인 전환**(핵심 RED): 승인 필요 tool → **web/headless가** deferred throw 대신 인라인 surface await로 같은 turn 계속(재발행 0). CLI는 이미 통과(`approval-inline-interactive.hellgate.test.ts` 패턴 미러). scripted-LLM e2e.
2. **대칭**: 동일 시나리오가 CLI(TTY, 기존)·headless(auto, 신규)·web(WS round-trip, 신규) 3서피스에서 client 재발행 없이 통과.
3. **브라우저 thin**: web-frontend에 `shouldContinueAfterApproval` 및 승인후 client `turn.run` 부재(red-on-injection).
4. **durability(Wave2 crown)**: `awaiting_approval` → SIGKILL → 재시작 → 승인 재surface → 답변 → tool 디스패치. (현재 0개 — 신규 guarantee의 봉인.)
5. **fence**: `src/apps/**`가 `@/runner/orchestrate` turn-driver import 시 컴파일/lint red.
6. **게이트 OFF byte-identical**: `QUANTA_INLINE_APPROVAL_RESOLVER` unset ⇒ deferred/throw+lease 경로 불변.
