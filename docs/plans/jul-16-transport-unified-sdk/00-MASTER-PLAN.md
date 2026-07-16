# MASTER PLAN — Transport-Unified SDK Door (session.v1을 외부 소비 가능한 단일 문으로)

- **Date:** 2026-07-16
- **Status:** DRAFT v2 — 적대어딧 R1 반영(KILL 3·HIGH 10 수정). 구현 미착수.
- **Goal:** 내부에 이미 존재하는 3층(RuntimeSession / session.v1 / SessionTransport)을 하나의 공개 seam(`connect({transport})`)으로 승격하고, transport 간 parity를 서사가 아닌 **타입+conformance 팩트**로 강제한다.
- **Design SSOT:** 이 문서. 티켓(01–05)과 충돌 시 이 문서 우선.
- **Effort legend:** XS(<반나절) · S(1일) · M(2–3일) · L(1주+)
- **브랜치 규율:** 동시 세션이 main에 커밋함 → `feat/transport-unified-sdk` 브랜치, ref rewrite 금지, 커밋 전 HEAD 재확인.

---

## 0. 적대어딧 R1 요지 (설계를 바꾼 반증들)

초안 v1의 두 "팩트 강제" 장치가 스펙 그대로는 성립하지 않음이 반증됐고(R1), v2는 다음으로 교체됐다:

| v1 주장 | 반증 (코드 evidence) | v2 교체 |
|---|---|---|
| `RuntimeSession extends SessionHandle` 컴파일이 교집합 증명 | verb 반환 `Promise<SessionDispatchResult>`(commandId/accepted 없음, types.ts:27-40)와 receipt 공변 불성립. turn.cancel/awaitTurnEnd는 RuntimeSession 부재 | **generic verb 표면** `SessionVerbSurface<R>` + 어댑터 `toSessionHandle()` — §3.1 |
| verb 반환 = receipt(accepted) | 성공 ack 프레임 자체가 프로토콜에 없음(types.ts:54-60), dispatch-단 에러는 wire 침묵(bridge.ts:307-316) | **submitted receipt** + rejected 비동기 채널 + bridge dispatch-error→rejected 승격(additive) — §3.2 |
| `transports.inProcess({session})` 외부 제공 | 세션 팩토리가 공개 표면에 없음(public-surface.test.ts 화이트리스트) — 외부는 session 조달 불가 | **inProcess/loopback은 내부·conformance 전용 강등**. 외부 in-process 문 = `createAnalysisAgent`(jul-4 소유) — §3.3 |
| copy 드리프트 "가드 0" | `tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts`(366줄)가 이미 양방향 equality로 CI 봉인 | 03을 "기존 hellgate에 field-shape 대조 추가"로 재스코프(XS) |
| 04 truncate는 투영 레이어 | 실제는 host-bridge(`session-host-turn-event-bridge.ts:141-160`, PREVIEW_MAX=256)+커널 포트 타입이 preview만 운반 — full은 4레이어 관통 | 04 재작성: 신규 wire 표면 인정, blast radius 명시, effort M→L |

**R1이 발견한 선존 이슈(이 계획 탓 아님, 별도 추적 후보):**
- `capabilityManifest.transport`가 전 세션 `"inproc"` 하드코드([base.ts:77](../../../src/host/runtime/internal/context-binding/base.ts)) — WS 세션도 "inproc"으로 선언 중(죽은 필드). 02가 stdio 스탬프하려면 이 seam 관통 필요.
- 합성 `session.created`가 `seq = 현재 tip`으로 발행돼([engine.ts:172](../../../src/sdk/runtime/session/engine.ts)) bridge tail 필터(`seq > snapshot.seq`)에서 탈락 — "freshly-attached client에게 전달" 주석과 실동작 불일치 의심.
- bridge가 dispatch 에러를 peer에 무통지 삼킴(서버 로그만) — reducer의 `empty_turn_input` 등이 wire 클라에겐 침묵.

## 1. 현 상태 (evidence, 2026-07-16 실측 — R1 정정 반영)

### 1.1 이미 있는 것 — 재사용 대상 (재발명 금지)

| 레이어 | 위치 | 상태 |
|---|---|---|
| 세션 인터페이스 | `RuntimeSession` — [types.ts:51-128](../../../src/sdk/runtime/types.ts) | typed verb(입력/턴/승인/권한/프로필/트랜스크립트) + dispatch/subscribe/snapshot/attachSessionTransport/side.start/transcript.messages(). verb 반환은 전부 `Promise<SessionDispatchResult>` |
| command builder (이미 leaf) | [src/sdk/runtime/session/commands.ts](../../../src/sdk/runtime/session/commands.ts) + attach 자체 조립([apps/cli/attach/commands.ts](../../../src/apps/cli/attach/commands.ts)) | 2벌 존재 — hoist 대상 (전자가 이미 순수 leaf라 이동 비용 낮음) |
| wire SSOT | `session.v1` — [src/protocol/session/](../../../src/protocol/session/) | 커맨드 8종 · 이벤트 **23종**(events.ts:268-292 실카운트) · codec envelope · capabilities에 `transport: "inproc"\|"stdio"\|"websocket"` 필드 존재(단 §0 선존 이슈: 스탬프는 inproc 하드코드) |
| transport 추상화 | [src/ipc/session/](../../../src/ipc/session/) | `SessionTransport`(send/onMessage/close — **close/error 통지 채널 없음**) · bridge(replay/dedup/revision guard) · stdio(newline-JSON, 32MiB guard, **EOF 시맨틱 없음**) · WS wrap |
| raw 클라 | `createSessionTransportClient` — [client.ts:10-18](../../../src/ipc/session/client.ts) | raw only(sendCommand/onMessage/currentResumeFromSeq). **heartbeat/reconnect 없음**(그 로직은 web-frontend SessionClient에만 존재) |
| WS 제품 배선 | web-daemon — [ws-handlers.ts:81-108](../../../src/apps/web-daemon/server/ws-handlers.ts) | 공유 session + 다중 peer attach. heartbeat pong 응답기는 **daemon 전용**([server/heartbeat.ts](../../../src/apps/web-daemon/server/heartbeat.ts)) — ipc 공용 아님 |
| WS 소비자 | `quanta attach` — [attach-client.ts](../../../src/apps/cli/attach/attach-client.ts) | handshake(sentinel→rejected(canonical id)→재connect→snapshot→tail) + approval 플로우 + **승인 후 새 commandId로 turn.run 재발행**(:252-258) + 클라 sessionId 검증 때문에 sendCommand 우회 사이트 존재(:191-195) |
| conformance | [tests/unit/ipc/](../../../tests/unit/ipc/) | stdio×WS 매트릭스 + in-memory duplex pair 하네스. RuntimeSession-direct oracle 열 없음 |
| copy 드리프트 가드 | [web-frontend-protocol-drift-contract-hellgate.test.ts](../../../tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts) | **이미 존재**(union 양방향 equality·decode-gate·version·escalation 순서). 못 잡는 것 = 필드 타입 수준 드리프트 |
| 재접속 시맨틱 | `planSessionReplay` — [bridge.ts:55-89](../../../src/ipc/session/bridge.ts) | seq 기반 incremental replay, tail 128, 3폴백(behind/ahead/gap)→full snapshot. 메모리 한정 |
| approval 결정 타입 SSOT | [runner/orchestrate/approval-decision.ts](../../../src/runner/orchestrate/approval-decision.ts) | `ApprovalDecisionResult`/`NormalizedApprovalDecision` + ad-hoc 판독 금지 헬게이트 — 01은 이걸 정본으로 재사용(4벌째 결정타입 발명 금지) |

### 1.2 갈라져 있는 것 — 이 계획이 닫을 갭

| 갭 | 실측 |
|---|---|
| 공개문이 façade만 노출 | exports `./sdk` 하나, barrel은 `createAnalysisAgent`+도구/테스팅. `connect`/session.v1 타입 미노출. `.d.ts` 미생성(jul-4 P8 위임) |
| stdio 제품 배선 0 | `createSessionStdioServer` 소비자 = conformance 픽스처뿐. headless는 transport 주입받는 라이브러리([session-bridge.ts:97-106](../../../src/apps/headless/session-bridge.ts)) |
| 클라 verb 층 부재 | RuntimeSession(typed verbs) vs raw 클라 표면 불일치. builder 2벌 |
| 클라 liveness 부재 | ipc 클라에 연결사망 통지/heartbeat/reconnect 없음 — 유일한 구현이 web-frontend 내부에 갇힘 |
| 버전 스큐 진단 0 | 버전 불일치 프레임은 tryDecode에서 **무언 드롭**(회신 없음) — 구/신 클라 조합 전부 "설명 불가능한 행" |
| substrate 2겹 | `driveSessionTurn` 직접 import **4곳**(cli/repl session-loop.ts:12 · headless index.ts:23 · agent interactive.ts:12 · terminal brain-mode.ts:36) — 소멸은 [ADR-0540](../../decisions/0540-inline-resumable-approval-resolver.md) 소유 |

### 1.3 충실도 갭 — 스코프 판단을 결정한 팩트

AgentEvent(embed 경로, 40+종: 전문 tool I/O·thinking delta·mid-turn usage·subagent/plan)와 SessionEvent(wire, 23종: ~256자 preview·최종 usage만)는 **의도된 충실도 차이**. truncate 지점은 host-bridge([session-host-turn-event-bridge.ts:141-160](../../../src/host/runtime/internal/session-host-turn-event-bridge.ts))이고 커널 포트 타입부터 preview만 운반 — full 운반은 4레이어(host-bridge→커널 포트→SessionEvent 타입→bridge) 관통 변경이다.

**⇒ 귀결**: "embed를 session.v1로 rebase"는 기각(충실도 회귀). 두 문은 목적이 다르다 — embed = in-process 전문 스트림(jul-4 소유), session door = 세션 시맨틱 원격/멀티피어. 수렴의 정직한 경로는 wire 충실도의 opt-in 상향(티켓 04, effort L)뿐이며 그 비용을 계획이 숨기지 않는다.

## 2. 경계 — 인접 워크스트림과 중복 금지

| 워크스트림 | 소유 | 이 계획과의 관계 |
|---|---|---|
| [jul-4-sdk-embed-dx](../jul-4-sdk-embed-dx/00-MASTER-PLAN.md) (P1-3 완료, P8 진행) | in-process embed façade, public-surface snapshot 게이트([public-surface.test.ts](../../../tests/unit/sdk/public-surface.test.ts)), USAGE.md, `.d.ts` | 우리는 wire 보완재. 신규 export는 그쪽 P8 게이트 경유. **외부 in-process 소비 = createAnalysisAgent가 담당**(이 계획은 세션 팩토리를 공개하지 않음, §3.3) |
| [ADR-0540](../../decisions/0540-inline-resumable-approval-resolver.md) (W1-A headless inline / W1-B daemon continuation 이관 / W2 온디스크 이벤트로그) | approval resolver 인라인화, turn-driver 소멸, biome fence, 온디스크 KernelEventLogPort | 05는 W2 소비자. 01 onApproval은 기존 `ApprovalDecisionResult` SSOT 재사용으로 W1 어댑터-호환. **W1-B 과도기 race**(01 §3.3)는 capability 표식으로 조율 |
| [ADR-0520](../../decisions/0520-reverse-mcp-server.md) reverse-MCP | quanta를 MCP 프로토콜 stdio 서버로 | 02는 session.v1 stdio — 다른 프로토콜, 다른 문. 상호 링크만 |
| [ADR-0516](../../decisions/0516-cli-attach-daemon-client.md) attach | CLI attach 클라 | 01이 handshake/approval-flow를 hoist해 공유(복사 금지) |
| 기존 drift hellgate | copy↔canonical equality 계약 | 03은 그 위에 field-shape 대조만 **추가**(약화 금지) |

## 3. 목표 아키텍처 (v2)

```
        외부 embed(in-process)   외부 프론트/봇     IDE·사이드카        우리 앱
        = createAnalysisAgent    (원격 WS)         (Codex형 stdio)    REPL·attach·daemon
          (jul-4 문, 불변)            │                  │                │
   ┌──────────────────────────────────┴──────────────────┴────────────────┴───┐
   │ quanta-codeagent/sdk                                                     │
   │   connect({transport, onApproval?, onConnectionState?}) → SessionHandle  │
   │   + session.v1 타입/코덱/에러/버전 re-export                               │
   │                                                                          │
   │   SessionVerbSurface<R>  ← 하나의 generic verb 표면 (§3.1)                │
   │     RuntimeSession  = SessionVerbSurface<SessionDispatchResult> 만족      │
   │     SessionHandle   = SessionVerbSurface<CommandReceipt> + 이벤트/수명     │
   │   toSessionHandle(runtimeSession) — in-process 어댑터 (내부용)             │
   └──────────┬──────────────────────────┬────────────────────────────────────┘
          ws (공개)                  stdio (공개)          [inProcess/loopback:
          web-daemon 기존         quanta serve --stdio      내부·conformance 전용
          handshake/approval은    (02, default-OFF          — 외부 미노출 §3.3]
          attach에서 hoist(01)     성숙 게이트)
              │                        │
   ┌──────────┴────────────────────────┴──────────────────────────────────────┐
   │ @/ipc/session — 기존 + additive: 연결상태 통지·heartbeat 응답기 hoist·      │
   │   dispatch-error→rejected 승격·lenient version reject (01·02)             │
   │   command builder는 @/protocol/session/builders로 SSOT hoist              │
   ├───────────────────────────────────────────────────────────────────────────┤
   │ session.v1 — 기존 + fidelity opt-in(04, L, 4레이어 관통 비용 명시)          │
   │   copy 가드: 기존 hellgate + field-shape 대조 추가(03)                     │
   ├───────────────────────────────────────────────────────────────────────────┤
   │ RuntimeSession engine — turn 루프 단일화·인라인 resolver = ADR-0540 소유     │
   ├───────────────────────────────────────────────────────────────────────────┤
   │ 온디스크 이벤트로그 = ADR-0540 W2 소유 → connect resume 옵션은 05(BLOCKED)   │
   │   ※ 01은 수동 재접속 `lastSeq()`+`resumeFromSeq`(메모리 tail 한정)까지 노출  │
   └───────────────────────────────────────────────────────────────────────────┘
```

### 3.1 verb 표면 통일 — extends가 아니라 generic

wire에서 `SessionDispatchResult`(revision/seq/events/turn 결과)를 동기 반환하는 것은 재현 불가(완료 프레임 부재). 그러므로 "인터페이스 동일"의 컴파일 증명은 상속이 아니라 **결과 등급을 파라미터화한 공유 verb 표면**으로 한다:

```ts
// @/protocol/session (또는 sdk) — verb 이름·인자 형태의 단일 정의
interface SessionVerbSurface<R> {
  input:      { append(text, meta?): Promise<R> }
  turn:       { run(meta?): Promise<R>; cancel(meta?): Promise<R> }
  identity:   { set(mode, meta?): Promise<R> }
  toolProfile:{ set(profile, meta?): Promise<R> }
  permission: { set(mode, meta?): Promise<R> }
  approval:   { respond(approvalId, decision, meta?): Promise<R> }
  transcript: { replace(messages, meta?): Promise<R> }
}
// RuntimeSession: satisfies SessionVerbSurface<SessionDispatchResult>  (기존 타입 무변경 목표.
//   단 turn.cancel verb는 RuntimeSession에 없음 → dispatch 경유 additive 신설이 유일한 표면 변경.
//   불성립 항목 발견 시 어댑터로 후퇴 — 스파이크(01 S0)가 판정)
// SessionHandle: SessionVerbSurface<CommandReceipt> + subscribe/snapshot/close
//   + awaitTurnEnd + onConnectionState + onCommandRejected + lastSeq()
```

in-process 구현 = `toSessionHandle(runtimeSession)` 어댑터(자기가 만든 commandId를 알고 있으므로 dispatch 성공 후 receipt 합성 — RuntimeSession 무변경). wire 구현 = raw 클라 + builders.

### 3.2 receipt 정직화 — "submitted", 그리고 rejected 비동기 채널

- verb 반환 = `{ commandId, submitted: true }` — **전송 성공까지만** 약속 (성공 ack 프레임이 없다는 프로토콜 사실을 그대로 노출).
- 서버 거부는 비동기 채널: `handle.onCommandRejected(cb)` + `awaitTurnEnd`가 상관된 rejected를 에러로 흡수.
- **additive 프로토콜 수선 2건**(heartbeat kind 추가 전례와 같은 등급, 원칙 "프로토콜 무변경"을 "additive 허용"으로 정정):
  1. bridge가 dispatch-단 에러(reducer throw)를 삼키지 않고 `rejected`로 승격 — 선존 침묵 버그(§0) 수선을 01이 소유.
  2. 버전 불일치 시 무언 드롭 대신 버전-관대 디코더로 `rejected(bad_version)` 회신 + 클라 typed error — 공개 SDK가 버전 스큐를 정상 상태로 만들기 때문에 01 필수 슬라이스.

### 3.3 in-process 사분면의 정직한 경계

외부에 세션 팩토리(createRuntime 체인)를 공개하는 것은 133-field AgentConfig 누출·jul-4 경계 충돌 — **v1 비공개**. 따라서:
- 외부 in-process 소비 = `createAnalysisAgent`(전문 스트림, jul-4 문) — 변경 없음.
- `toSessionHandle`/loopback transport = **내부 앱·conformance oracle 전용** (공개 barrel 미수출, public-surface 스냅샷에 부재가 곧 증명).
- 세션 팩토리 공개는 수요 확인 후 별도 RFC.

### 3.4 아키텍처 원칙 (v2)

1. **정직한 약속만**: wire가 보장 못 하는 것(동기 결과·수신 ack·자동 재접속)은 API가 약속하지 않는다. 보장 승격은 additive 프로토콜 수선으로만.
2. **SSOT hoist, 복사 금지**: builder 2벌→`@/protocol/session/builders` · attach handshake/approval-flow→공유 모듈 · approval 결정 타입은 기존 `ApprovalDecisionResult` 재사용 · heartbeat 응답기 daemon→ipc hoist.
3. **기본 byte-identical**: serve --stdio 게이트(성숙 게이트로 재명명 — §hazard), fidelity opt-in(기본 preview), 신규 프레임/필드는 additive-optional.
4. **parity는 테스트가 증명하되 "동일"의 정의를 명문화**: 정규화 클로즈드 리스트(eventId/emittedAt/seq-remap 제외 + `capabilities.transport`류 "다름이 정답" 필드는 positive 단언) — "통과할 때까지 제외 추가" 금지.

## 4. Wave / 티켓 맵

| # | 티켓 | 기능 | 왜 | ROI | Effort | 의존 |
|---|---|---|---|---|---|---|
| 01 | [connect + SessionHandle](01-connect-session-handle.md) | S0 스파이크(satisfies 성립 판정) + 공개 `connect()`(ws/stdio) + generic verb 표면 + builder/handshake/approval-flow hoist + 연결상태/버전스큐/rejected 채널 + conformance(loopback oracle 열+정규화 계약) + DX 문서 | 외부가 wire 탈 방법 0 + liveness/버전 진단 0 | 외부 프론트·봇·사이드카가 한 API. 선존 침묵버그 2종 수선 동반 | **L** (S0 스파이크 XS 선행) | — |
| 02 | [serve --stdio](02-serve-stdio-entrypoint.md) | session.v1 stdio 서버 진입점 (default-OFF 성숙 게이트) + heartbeat 응답기 hoist + transport 스탬프 seam | stdio 스택 완성돼 있는데 제품 문 0 | Codex app-server parity; 01 stdio transport의 실제 대상 | M | 01 |
| 03 | [copy field-shape 가드](03-protocol-copy-drift-guard.md) | 기존 hellgate에 필드 타입 수준 대조 **추가**(A) → protocol 번들 소비+copy 삭제(B, 기존 hellgate 개편 포함) → 클라 2벌 수렴 평가(C) | 기존 가드는 union 멤버십·버전은 잡지만 필드 타입 변형은 통과 | 남은 드리프트 class 마감. B로 신규 필드 1회 랜딩 | A=XS · B=M · C=XS | A즉시 / B←01 |
| 04 | [wire fidelity opt-in](04-wire-fidelity-negotiation.md) | connect 프레임 확장 + host-bridge/커널 포트/이벤트 타입 additive full 필드 + bridge peer-필터 | 256자 preview는 외부 SDK 소비자에게 부족; embed-rebase 기각 후 유일한 수렴 경로 | wire로 embed급 관찰가능성 | **L** (4레이어 관통) | 01, 03-A |
| 05 | [durable resume 합류](05-durable-resume-composition.md) | `connect({resume})`가 온디스크 로그 위에서 재시작 넘어 동작 | 현 replay는 메모리 tail 128 | Codex/Claude 부재 기능 = 차별화 | S (SDK측만) | **BLOCKED**←ADR-0540 W2 + 01 |

의존: `01 → {02, 03-B, 04}` / `05 ← ADR-0540 W2` / 03-A 즉시 독립.

## 5. Non-goals (명시 기각)

- embed를 session.v1로 rebase (충실도 회귀, §1.3)
- 세션 팩토리 공개 (§3.3 — 수요 확인 후 별도 RFC)
- turn-driver 소멸/inline resolver/온디스크 이벤트로그 substrate (ADR-0540 소유)
- MCP 노출 (ADR-0520)
- 자동 reconnect/백오프 (v1은 연결상태 통지+수동 재접속까지 — web-frontend가 유일 구현 보유자, 03-C 평가 후)
- web-frontend SessionClient 즉시 통합 · daemon 멀티세션 재설계 · npm 퍼블리시/codegen

## 6. Hazards

- **동시세션**: ADR-0540·subagent 계열 in-flight. `src/sdk/runtime`·`src/ipc/session` 편집 전 HEAD 재확인.
- **CLI_FEATURE_GATES 시딩 함정**: 그 배열 엔트리는 미설정 시 "1" 시드(사실상 ON) — 02 게이트는 직접 env/knob 체크. 구현 시 시딩 시맨틱 재검증.
- **02 게이트의 정직한 명분**: stdio는 부모-자식 신뢰 경계라 "보안 게이트" 서사는 성립 안 함 — **성숙 게이트**(미완 표면 조기 소비 차단)로 명명. SDK `transports.stdio`는 env 자동 주입 금지(게이트 우회 극장 방지) — 소비자가 명시 설정, 자식 조기종료는 stderr 요약 포함 typed error로 fail-fast.
- **knob 시스템 3벌**: 신규 게이트 추가 전 grep.
- **approval continuation 과도기**: 현행 wire 플로우 = 승인 후 클라가 **새 commandId로** turn.run 재발행. ADR-0540 W1-B가 daemon 이관 시 구버전 외부 클라의 이중 turn.run race — 01 §3.3의 capability 표식(`server-auto-continues`)으로 협상. awaitTurnEnd는 재발행 commandId **승계 상관** 필수(안 하면 approval 낀 턴에서 영구 hang).
- **conformance vacuity**: 정규화 리스트는 클로즈드 — 구현 중 "통과 안 되니 제외 추가"는 red 사유.

## 7. Acceptance (계획 전체)

- [ ] **외부 소비 실증**: repo 밖 빈 디렉토리 + `file:` 의존 + `tsc --noEmit` 통과(connect 타입 포함) + ws/stdio 각 1 시나리오 실행 (01; `.d.ts` 산출은 jul-4 P8 게이트 종속 — 그쪽 미랜딩 시 이 항목이 그 티켓을 당긴다)
- [ ] conformance: 같은 스크립트 → ws/stdio/loopback 이벤트 시퀀스가 **명문화된 정규화 계약** 아래 동일 + RuntimeSession oracle 대조 (01)
- [ ] `SessionVerbSurface<R>` satisfies가 RuntimeSession·SessionHandle 양쪽 컴파일 성립 — **01 S0 판정 따름**(불성립 판정 시 이 항목은 어댑터-only acceptance로 대체, R2 F7)
- [ ] dispatch-에러·버전 불일치가 wire 클라에 typed로 표면화 (01 — 선존 침묵 2종 수선)
- [ ] `quanta serve --stdio` OFF 시 byte-identical + ON 시 attach 동일 시나리오 (02)
- [ ] field-shape 드리프트 주입 red / 기존 hellgate 계약 무약화 (03-A)
- [ ] fidelity 미협상 클라 byte-identical (wire·in-proc 구독자·아카이브 전부) (04)
- [ ] (post ADR-0540 W2) 재시작 후 `connect({resume})` 이벤트 replay 복원 (05)
