# Ticket 04 미니 RFC — wire fidelity opt-in 착수 전 판정

- **Date:** 2026-07-18
- **Status:** HISTORICAL RFC — 구현은 bbd289d40으로 LANDED. 이 문서는 착수 전 판정 근거만 보존한다.
- **실측 기준:** HEAD `ccb8480b7`(01 LANDED · 03-A LANDED · W4-b JsonlSessionEventLog LANDED · 05 코어 durable replay LANDED). 아래 file:line은 전부 이 트리에서 재확인한 것.
- **관계:** 티켓 문서(DRAFT v2)의 설계 골격은 유지. 이 RFC는 5개 판정을 코드 팩트로 확정하고, v2 이후 랜딩된 신규 지형(JsonlSessionEventLog·connect()/SessionHandle·serverAutoContinues·peer-로컬 프레임 전례)을 blast radius/협상 설계에 반영한다. 티켓 v2와 충돌 시 이 문서가 우선(착수 시 티켓에 역반영).

---

## §0 판정 요약 (5개)

| # | 질문 | 판정 |
|---|---|---|
| 1 | 4레이어 절단면 | **4레이어 확정, 5레이어 아님** — full payload는 이미 host-bridge 입구에 도달해 있다(`tool_call.input` 원본 + `tool_result.preview`=redaction-적용 전문, execute.ts:250). AgentEvent 생산층 변경 불요. optional 병행 필드는 03-A 가드가 이미 additive-safe로 선인가(hellgate :701) → W1-B식 23파일 리터럴 캐스케이드 **없음** |
| 2 | 협상 채널 | **peer-로컬 fidelity-ack 컨트롤 프레임(신규 kind) 채택** — heartbeat(6번째 kind)·rejected와 같은 등급. ack-before-replay 순서 보장으로 클라 타임아웃 불요. manifest/capabilities 경로 KILL(공유 스냅샷 브로드캐스트 실증), rejected 재활용 KILL(CLOSED-4 하드체크) |
| 3 | blast radius | 커널 이벤트 소비자 전수 = wire 피어 + in-proc 구독자 7곳 + **JsonlSessionEventLog(디스크)** + **sqlite 아카이브 + HTTP readout(신규 발견 우회로)**. bench driver·cost aggregator는 AgentEvent 축이라 **범위 밖**(티켓 v2 §1-3의 추정 정정). 1차 방어 = 생산 게이트 OFF ⇒ 필드 부재 유지 |
| 4 | 크기 | **L 유지하되 하한 L** — 5슬라이스(각각 default-safe 랜딩 가능): S1 생산+운반(M) → S2 협상(M) → S3 peer-strip 조건화+누출핀(S) → S4 mid-turn usage(XS) → S5 e2e/conformance(S). usage는 신규 이벤트 타입 대신 state-view optional 필드로 축소 권고(분류리스트 처닝 ~6-10파일 회피) |
| 5 | 기각 대안 | thinking delta 제외 유지 / AgentEvent 전종 승격 기각(subagent 전용 topic 전례) / embed-rebase 재기각 / per-peer manifest 기각 / rejected 재활용 기각 / SessionCommand(`fidelity.set`) 기각 — 각 근거 §5 |

**착수 가능** — 조건 §6.

---

## §1 판정 1: 4레이어 절단면의 정확한 시그니처 목록

### 1.1 앵커 팩트 실측 (v2 재검증 + 신규 반증 2개)

- truncate 유일 지점 = [session-host-turn-event-bridge.ts:141-160](../../../src/host/runtime/internal/session-host-turn-event-bridge.ts) `PREVIEW_MAX=256` `clampPreview`/`previewToolArgs` (:65 args, :72-74 result). ✅ v2와 일치.
- **신규 반증 A — full은 이미 브리지에 도달해 있다.** AgentEvent `tool_result.preview`는 이름과 달리 **redaction-적용된 model-visible 전문**이다: [dispatch/execute.ts:250](../../../src/agent/dispatch/execute.ts) `preview: output`이 `block.content`(LLM에 실리는 그 문자열)와 동일 문자열. `tool_call`은 `event.input` 원본을 통째로 받는다([bridge :65](../../../src/host/runtime/internal/session-host-turn-event-bridge.ts)). ⇒ **AgentEvent 층 변경 0** — 절단면은 정확히 4레이어이며 그보다 위로 올라가지 않는다. (귀결: "wire full fidelity"의 정직한 정의 = **model-parity** — 모델이 본 것과 같은 것. 모델 자체가 못 본 초과분(도구 내부 tail-truncation 이전 원본)은 이 티켓 범위 밖, `fullLogPath` 축이 담당.)
- **신규 반증 B — 03-A가 optional additive를 이미 선인가.** [web-frontend-protocol-drift-contract-hellgate.test.ts:701](../../../tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts): `if (canonicalField.optional) continue // additive-safe (ticket-04 \`argsFull?\` contract)` — canonical 쪽 optional 필드는 copy 부재가 green. ⇒ optional 이벤트 필드 추가는 **web-frontend copy 강제 수정 0**.

### 1.2 레이어별 변경 목록 (additive-optional만)

| # | 레이어 | 파일 | 변경 |
|---|---|---|---|
| L1 | host-bridge | [session-host-turn-event-bridge.ts](../../../src/host/runtime/internal/session-host-turn-event-bridge.ts) | `tool_call`/`tool_result` 매핑 arm에 게이트 ON일 때 `argsFull?`/`resultFull?` 병행 세팅(+크기캡·강등 플래그, §4 S1). 게이트 주입 seam = [turn-runner.ts:55](../../../src/host/runtime/internal/context-binding/turn-runner.ts)의 호출부 — `itemStream` knob이 이미 같은 자리에서 opts로 흐르는 전례 그대로 |
| L2 | 커널 포트 | [kernel/session/ports.ts:113-125](../../../src/kernel/session/ports.ts) | `SessionHostTurnEvent`의 `tool.invoked`에 `readonly argsFull?: string`, `tool.completed`에 `readonly resultFull?: string` (+`fidelityDegraded?: true` — 강등 플래그, 두 arm 공통) |
| L3 | SessionEvent | [protocol/session/events.ts:103-121](../../../src/protocol/session/events.ts) | `ToolInvokedEvent.argsFull?` / `ToolCompletedEvent.resultFull?` / 강등 플래그. **`SESSION_EVENT_TYPES` 무변경**(S4를 state-view안으로 가면 신규 타입 0 — §4). 사이 통과층: [session-host-turn-event-projection.ts:146-175](../../../src/kernel/session/session-host-turn-event-projection.ts) 2개 arm carry-through |
| L4 | ipc bridge | [ipc/session/bridge.ts](../../../src/ipc/session/bridge.ts) | per-peer fidelity 상태(§2) + `sendMessages` 단일 chokepoint strip(§3.2) |

코덱은 **무변경으로 통과**: `decodeSessionEvent`([protocol/session/codec.ts:172-179](../../../src/protocol/session/codec.ts))는 envelope 메타 + `type` 멤버십 게이트만 검사하고 per-type 필드는 passthrough — optional 필드는 구·신 디코더 모두 무해 통과. **뒤집힌 함의**: 구클라도 디코더가 필드를 걸러주지 **않으므로**, preview 피어 보호는 클라가 아니라 **서버측 strip이 유일한 방어**다(§3.2가 필수인 코드 근거).

### 1.3 소비자 영향 + shape-sync 규모 견적 (W1-B 대조)

W1-B `serverAutoContinues`는 **required** capabilities 필드여서 스냅샷 리터럴 전부가 컴파일 red → 실측 46파일(+830/−36), 그중 ~25개가 테스트 리터럴 1줄 sync(커밋 `9ea77c2c7`; 잔여 1건이 `c8caf2494`로 또 샜음 — required 필드 캐스케이드의 실증적 비용).

04는 그 캐스케이드를 **구조적으로 회피**한다:

| 표면 | 강제 sync | 근거 |
|---|---|---|
| 이벤트 optional 필드 (L2/L3) | **0파일** | optional은 기존 리터럴을 깨지 않음 + 03-A :701 선인가 |
| web-frontend protocol copy | **0파일** | 동상 (union 멤버십 무변경 전제 — S4 state-view안) |
| attach render 분류리스트([render.ts:23-54](../../../src/apps/cli/attach/render.ts)) · web-frontend TRANSCRIPT 분류([session-hooks.ts:373-408](../../../apps/web-frontend/src/ws/session-hooks.ts)) | **0파일** | 신규 이벤트 타입 없음. (만약 `turn.usage` 신규 타입으로 가면 여기 +copy+코덱 테스트 ~6-10파일 — §4 S4 판정의 근거) |
| 신규 transport frame kind (§2) | **~4-8파일** | [ipc/session/codec.ts](../../../src/ipc/session/codec.ts) `decodeKind` switch(:45-55)+인코더/디코더, [types.ts](../../../src/ipc/session/types.ts) union, conformance fixtures([session-transport-conformance-fixtures.ts](../../../tests/unit/ipc/session-transport-conformance-fixtures.ts)), 코덱/스큐 테스트. ws-handlers "5-kind contract" 주석류 갱신 |
| connect 프레임 optional 필드 | ~3파일 | codec encode/decode + types + 클라 빌더. optional이라 테스트 캐스케이드 없음 |
| **CapabilityManifest / SessionCapabilities** | **0파일 — 건드리지 않는 게 설계** | 협상을 capabilities 필드로 갔다면 W1-B급 25파일 재현 + 공유 manifest에 per-peer 상태를 넣는 범주 오류(§2.2). 이 회피가 프레임-레벨 협상 채택의 부수 이득 |

---

## §2 판정 2: 협상 설계 확정

### 2.1 채택 — connect `requestedFidelity?` (additive) + **fidelity-ack peer-로컬 컨트롤 프레임** (신규 kind)

```
클라: { kind:"connect", sessionId, resumeFromSeq?, surfaceSubscription?, requestedFidelity?: "full" }
서버: { kind:"fidelity", sessionId, granted: boolean }   ← 해당 피어에게만, replay보다 먼저
```

- **요청**: [SessionTransportConnectMessage](../../../src/ipc/session/types.ts)(:16-21)에 `requestedFidelity?: "full"` — closed 단일값 enum(v1), absent = 현행. `surfaceSubscription?`이 이미 같은 자리의 per-peer connect 옵션 전례([codec.ts:97-110](../../../src/ipc/session/codec.ts), [ws-handlers.ts:233-235](../../../src/apps/web-daemon/server/ws-handlers.ts)).
- **확정 응답**: 신규 컨트롤 kind — heartbeat가 "ADDITIVE 6th transport kind"로 이미 뚫어둔 전례([types.ts:34-52](../../../src/ipc/session/types.ts)) + 오늘 병렬 랜딩 중인 `resumed`류 프레임(J 에이전트, ⚠️ §6-3 kind 충돌 조율)과 같은 패턴: **특정 피어에게만 보내는, 공유 스냅샷에 속하지 않는 프레임**. 05 티켓 자신도 caught-up 신호로 "resume-ack/served-marker additive 프레임"을 후보로 명시([05 :16](05-durable-resume-composition.md)) — 이 계획 안에서 peer-로컬 ack 프레임은 이미 수렴된 패턴이다. **판정: 이 패턴이 정확한 해답이 맞다.**
- **순서 보장 = 타임아웃 제거**: bridge `handleConnect`([bridge.ts:412-421](../../../src/ipc/session/bridge.ts))가 유일한 응답자이므로 ack를 `sendReplay` **앞에** 보내면 같은 transport에서 순서 결정적. 클라 규칙: **snapshot 도착 시점까지 fidelity 프레임이 없으면 preview로 확정** — 구서버(프레임 자체를 모름) 상대로도 행이나 타이머 없이 결정된다.
- **grant 판정** = `knob ON ∧ requestedFidelity==="full"`. knob OFF 신서버는 `granted:false`를 **명시** 회신(구서버-침묵과 구분되는 정직한 진단 — "서버가 거절" vs "서버가 몰라").
- **SDK 노출**: `connect({ fidelity: "full" })` 옵션 + 확정 결과를 `onConnectionState` connected 페이로드에 `fidelity: "full" | "preview"` 필드로(05의 `resume: "replayed" | "snapshot_fallback"` 표면화 전례 — [client.ts:39](../../../src/ipc/session/client.ts) — 와 동형; 조용한 강등 금지). `SessionHandle`([handle.ts:499-524](../../../src/ipc/session/handle.ts))에 `fidelity()` 관측 getter.
- **handshake 상세**: attach handshake는 discovery sentinel connect → rejected(canonical id) → 재connect 2단([connect.ts](../../../src/sdk/connect.ts) 모듈 docblock). `requestedFidelity`는 **양쪽 connect에 모두 실어도 무해**하나 판정은 canonical-id 재connect의 ack가 정본.

### 2.2 스큐 매트릭스 (구/신 × 클라/서버, 실코드 근거)

| 클라 | 서버 | knob | 결과 | 근거 |
|---|---|---|---|---|
| 구 | 신 | OFF | **byte-identical** | full 생산 자체가 없음(1차 방어) |
| 구 | 신 | ON | **byte-identical wire** | 요청 안 함 ⇒ grant 없음 ⇒ strip(§3.2). fidelity 프레임은 요청 피어에게만 가므로 구클라는 신규 kind를 볼 일 자체가 없음(봐도 `decodeKind` `bad_transport_kind` → tryDecode undefined → 무해 drop, [codec.ts:53-55](../../../src/ipc/session/codec.ts)) |
| 신(요청) | 구 | — | **무해 강등 → preview, 진단 가능** | 구서버 `decodeConnectMessage`는 sessionId/resumeFromSeq/surfaceSubscription 3필드만 읽고 **미지 필드 무시**([codec.ts:90-111](../../../src/ipc/session/codec.ts)) — 에러 없이 정상 handshake, ack 부재 ⇒ 클라 "snapshot까지 무-ack = preview" 규칙으로 확정, `fidelity:"preview"` 표면화 |
| 신(요청) | 신 | OFF | preview + **명시 거절** | `granted:false` ack |
| 신(요청) | 신 | ON | **full** | grant + strip 해제(해당 피어만) |
| 버전 자체가 다른 피어 | — | — | 기존 S5b echo-reject 경로 그대로 | fidelity는 version negotiation과 직교([codec.ts:235-260](../../../src/ipc/session/codec.ts)) — 신규 kind는 version-stamped 컨트롤 프레임으로 heartbeat와 동일 취급 |

### 2.3 기각 — manifest/capabilities 경로 (R1 MED 재확인, 이번엔 코드로)

`publishSnapshot`은 **하나의 공유 snapshot을 전 피어에 브로드캐스트**한다([bridge.ts:512-519](../../../src/ipc/session/bridge.ts)); capabilities는 그 snapshot 내부의 server-global 선언이고, 이미 `transport:"inproc"` 하드코드 선존 이슈([base.ts:77](../../../src/host/runtime/internal/context-binding/base.ts), MASTER §0)가 보여주듯 per-peer 개념이 전혀 없다. per-peer fidelity를 여기 넣으려면 snapshot 조립·브로드캐스트·클론 전부를 per-peer로 리라이트 + 이후 모든 snapshot 재발행마다 피어별 분기 — R1 MED "스코프 폭발" 그대로. 덤으로 required capabilities 필드는 W1-B 25파일 리터럴 캐스케이드 재현(§1.3). **KILL 확정.**

`connect-rejected 재활용`: reason set이 wire에서 **CLOSED-4**이고 구피어가 하드체크한다([codec.ts:131-138](../../../src/ipc/session/codec.ts) 클라 디코더가 4개 외 throw; bridge 주석 :207-209). 값 추가 = 구클라 디코드 실패, 그리고 "거절"은 성공-grant를 나를 수 없는 실패 채널 — 의미론도 오배치. **KILL.**

`SessionCommand`(예: `fidelity.set`): 커맨드는 공유 세션 상태를 변이하고 revision을 범프해 **전 피어**에 echo된다 — per-peer transport 관심사를 세션 상태로 오염. **KILL.**

---

## §3 판정 3: blast radius 전수

### 3.1 커널 이벤트가 흐르는 전 경로 (실측 열거)

생산 지점에서 하류로: [engine.ts:284-287](../../../src/sdk/runtime/session/engine.ts) — `eventLog.append(event)` → `transportBridge.publishEvents([event])` → in-proc `publishEvents(deps, [event])`.

| 경로 | 소비자 (실측) | full 수신 정책 (v1) |
|---|---|---|
| **wire 피어** | bridge 피어 전원 (ws=web-daemon [ws-handlers.ts:98-101](../../../src/apps/web-daemon/server/ws-handlers.ts), stdio, SDK connect) | **협상 피어만** — §3.2 strip |
| **in-proc 구독자** | web-daemon: [persistence.ts:25](../../../src/apps/web-daemon/server/persistence.ts)(sqlite appendEvent) · [transcript-persist.ts:78](../../../src/apps/web-daemon/server/transcript-persist.ts)(`turn.completed` 필터, 이벤트 payload 비저장) · follower-approval · approval-continuation · canvas-artifact-bridge · server.ts / sdk: handle-adapter(conformance oracle) | **full 수신 (trusted)** — 같은 프로세스 = 같은 신뢰경계. 전부 type-필터형이라 optional 필드는 행동 무영향, 저장형만 크기 영향 |
| **JsonlSessionEventLog (디스크, 신규)** | [event-log-jsonl.ts:276-284](../../../src/kernel/session/event-log-jsonl.ts) — append가 `encodeSessionEvent` 전문을 JSONL로 영속 | **full 영속 (knob ON일 때)** — 아래 3.3 |
| **sqlite 아카이브 → HTTP readout (신규 발견 우회로)** | `threads.db` payload_json([persistence-sqlite.ts:96,136](../../../src/apps/web-daemon/persistence-sqlite.ts)) → **[fetch-handler.ts:238](../../../src/apps/web-daemon/server/fetch-handler.ts) `threadStore.loadEvents(threadId, sinceSeq)` HTTP 서빙** | 아래 3.4 — **bridge peer-필터 밖의 유일한 wire-급 출구** |
| **범위 밖 (v2 §1-3 추정 정정)** | bench driver·cost aggregator(canvas-usage-source)는 **AgentEvent/onPromptAssembled 축** 소비([canvas-usage-source.ts:2-9](../../../src/apps/web-daemon/canvas-usage-source.ts); `src/bench`에 session.subscribe 0건) — 커널 SessionEvent를 받지 않음 | 영향 0 |

**1차 방어 유지 판정**: knob OFF ⇒ L1에서 full 필드 자체가 생성되지 않음 ⇒ 위 **전 경로**(wire·in-proc·JSONL·sqlite·readout)가 필드 부재로 byte-identical. 이 단일-지점 방어가 성립하는 이유가 바로 §1.1 반증 A(절단면이 4레이어 꼭대기 한 곳) — acceptance 1번 hellgate의 대상.

### 3.2 strip 단일 chokepoint 판정 (replay 경로 포함 — 티켓 v2 요구사항의 코드 확정)

bridge의 **모든** 피어행 송신은 `sendMessages`를 경유한다 — 실측 6 call-site: live fan-out(`publishEvents` :534), snapshot 브로드캐스트(:517), `sendReplay`(:329 — tail replay **및 05 durable-log replay**: `planSessionReplay`가 durableLog 세그먼트를 tail로 합류시켜 같은 경로로 나감 :317-330), dup-command replay(:353), reject 2종. ⇒ **strip은 `sendMessages`(또는 그 직전 단일 wrapper)에서 event 프레임의 full 필드를 non-granted 피어에 대해 제거** — 이 한 곳이 live·tail·dup·durable-replay 네 경로를 전부 커버한다. snapshot 프레임은 full 필드를 애초에 안 나름(state view에 도구 payload 없음)이라 대상 아님.

**05 replay 누출 경로 명시** (티켓이 요구한 판정): knob ON 세션의 JSONL 로그에는 full이 영속된다. 재접속한 **preview 피어**의 resume이 durable replay로 rescue되면([bridge.ts:83-111](../../../src/ipc/session/bridge.ts) `planDurableReplay`) 로그의 full-필드 이벤트가 그 피어로 나가는 경로가 실존 — strip이 `sendMessages`에 있으면 자동 커버되지만, **acceptance에 이 경로 전용 red-on-injection 핀 필수**(strip을 live fan-out에만 달았다면 green인 채로 새는 사각).

### 3.3 JsonlSessionEventLog 정책

- **영속 자체는 by-design**: 로그의 목적이 replay 정본이고, full을 안 실으면 05 resume 후 full 피어가 강등된다. full은 이미 redaction-적용분(§1.1)이며 파일은 로컬 사용자 소유 디렉토리 — 세션 recorder(ADR-0075)가 전문을 이미 디스크에 남기는 것과 같은 신뢰 등급.
- **크기**: 이벤트당 최대 수 MiB(§4 S1 캡)로 장수 세션 로그가 커질 수 있음 — v1은 문서화만(fsync 정책이 05로 이연된 것과 같은 등급), rotation은 non-goal.
- **replay 대칭성**: 로그 readback은 `decodeSessionEvent`(:32-35 주석, passthrough 코덱 §1.2)이므로 full 필드가 손실 없이 복원됨 — 별도 작업 0.

### 3.4 HTTP readout 우회로 정책 (이 RFC의 유일한 신규 결정 요구)

[fetch-handler.ts:238](../../../src/apps/web-daemon/server/fetch-handler.ts)의 thread readout은 아카이브된 이벤트를 **fidelity 협상 없이** HTTP로 서빙한다 — bridge strip이 못 보는 출구. **v1 판정: in-proc/아카이브와 같은 trusted 등급으로 허용 + knob 문서에 명시.** 근거: 같은 daemon auth 경계 안(토큰 게이트)의 operator 자기 UI이고, 이 경로는 이미 전문 transcript(`SavedSession` messages)를 서빙하는 신뢰 표면과 동급. 단, **acceptance에 "readout이 full을 서빙함"을 고정하는 명시 테스트**(암묵 누출이 아니라 문서화된 결정임을 핀) 1건. 미래에 readout을 비신뢰 피어에 열게 되면 그 티켓이 strip 이식 의무를 짐(여기 명시로 추적성 확보).

---

## §4 판정 4: 크기 재견적 + 슬라이스 분해

**총평: L 유지, 단 하한 L** — v2가 L로 올린 두 근거 중 "4레이어 관통"은 유효하나, (a) AgentEvent 층 불요(반증 A), (b) 리터럴 캐스케이드 구조 회피(반증 B + 프레임-레벨 협상), (c) strip이 기존 단일 chokepoint에 앉음, 세 팩트가 상한을 깎는다. M으로의 재강등은 안 함 — 신규 wire kind + 스큐 매트릭스 + 누출핀 테스트 매트릭스가 여전히 L급 검증 부하.

각 슬라이스는 **독립 랜딩 가능 + 랜딩 순간부터 default-safe**:

| 슬라이스 | 내용 | Effort | Acceptance (슬라이스 단위) |
|---|---|---|---|
| **S1 생산 게이트 + 4레이어 운반** | knob `QUANTA_SESSION_FULL_FIDELITY`(knob 인벤토리 declare — 3벌 시스템 grep 선행, §6) · L1-L3 optional 필드 · 크기캡+강등 플래그 · **bridge는 이 시점엔 전 wire 피어 무조건 strip**(협상 부재 중 inert 보장) | M | ① knob OFF: wire·in-proc·sqlite·JSONL 전부 byte-identical (hellgate) ② knob ON: in-proc 구독자·JSONL엔 full, wire엔 무조건 부재 ③ 캡 초과 → full 필드 강등 + `fidelityDegraded` 플래그 (red-on-injection: 플래그 없이 자르면 red) ④ 03-A green 유지 |
| **S2 협상 표면** | connect `requestedFidelity?` + fidelity-ack kind(codec/types/conformance fixtures) + bridge grant 판정 + ack-before-replay + SDK `connect({fidelity})`/`onConnectionState` 페이로드/`handle.fidelity()` | M | ① 스큐 매트릭스 6행(§2.2) 각 1테스트 — 특히 구서버 fake로 "무-ack ⇒ preview 확정, 행 없음" ② ack가 snapshot보다 선행하는 순서 핀 ③ 신규 kind가 구클라 디코더에서 무해 drop |
| **S3 strip 조건화 + 누출핀** | S1의 무조건 strip → granted 피어 pass-through로 조건화, `sendMessages` 단일 지점 | S | ① 동시 접속 격리: full 피어 수신 ∧ preview 피어 byte-identical (같은 세션, 같은 이벤트) ② **durable-replay 누출핀**: full 영속 로그 + preview 피어 resume → full 부재 (red-on-injection: strip을 live 경로에만 달면 red) ③ dup-command replay·tail replay 동형 핀 |
| **S4 mid-turn usage** | **판정: 신규 `turn.usage` 이벤트 대신 `SessionStateView.lastTokenUsage?` optional 추가 권고.** 실측: mid-turn usage는 이미 커널까지 와서 state에 쌓이는데([projection :176-186](../../../src/kernel/session/session-host-turn-event-projection.ts) `usage` arm이 매번 `session.state.updated`를 발행) **`toSessionStateView`가 lastTokenUsage를 투영에서 누락**([state.ts:116-139](../../../src/kernel/session/state.ts))해 wire에서만 사라진다. optional 필드 1개(knob 게이트)로 §1.3 fact가 닫히고, 신규 이벤트 타입의 분류리스트 처닝(~6-10파일)과 세션 revision 의미론 논쟁을 통째로 회피. 숫자 4개뿐이라 peer-strip 대상 아님(생산 게이트만). per-increment 이벤트가 정말 필요해지면 후속 XS | XS | ① knob ON + usage 도착 → 다음 `session.state.updated`에 `lastTokenUsage` ② OFF byte-identical |
| **S5 e2e + conformance** | ws×stdio conformance 매트릭스에 fidelity 열(협상/미협상), OFF-parity, reconnect 후 fidelity 준수(재connect마다 재협상 — per-peer 상태는 연결 수명) | S | ① 같은 스크립트 ws/stdio 동일 결과 ② reconnect replay에서 fidelity 준수 (티켓 v2 acceptance 승계) |

랜딩 순서 의존: S1→S3는 순서 고정(무조건-strip이 S1의 안전핀), S2는 S1 뒤 아무 때나, S4·S5는 독립/마지막.

---

## §5 판정 5: 기각 대안 기록 (재litigation 방지)

1. **thinking delta 제외 유지** — reasoning 노출은 별도 정책 축(provider 정책·redaction 등급이 도구 I/O와 다름). AgentEvent엔 있고 embed 문이 이미 나른다 — wire 수요가 실증되면 별도 RFC. 이 티켓에 얹으면 fidelity 협상이 reasoning 정책 논쟁에 인질. **유지.**
2. **AgentEvent 40+종 전체 승격 기각** — 실전례가 반대 방향을 증명: subagent 이벤트는 SessionEvent union이 아니라 **전용 WS topic**(`SUBAGENT_WS_TOPIC`, [ws-handlers.ts:193](../../../src/apps/web-daemon/server/ws-handlers.ts), jul-15 랜딩)으로 갔다. 커널 이벤트는 seq/revision을 범프하는 세션 정본 스트림 — 40종을 넣으면 replay 로그·아카이브·revision 의미론 전부가 관측 노이즈에 오염. 전종이 필요한 소비자는 embed 문(`createAnalysisAgent`)이 정답. **기각 유지.**
3. **embed-rebase 재기각** — MASTER §1.3 그대로: 두 문은 목적이 다르고, 이 티켓 자체가 그 기각의 귀결(wire의 opt-in 상향이 유일한 정직한 수렴 경로). 이 RFC의 §1.1 반증 A가 오히려 보강 — full이 이미 브리지에 와 있으므로 rebase 없이 충실도 갭이 닫힌다.
4. **per-peer snapshot manifest 기각** — §2.3 (코드 실증으로 R1 MED 확정).
5. **connect-rejected 재활용 기각** — §2.3 (CLOSED-4 하드체크 + 의미론 오배치).
6. **`fidelity.set` SessionCommand 기각** — §2.3 (per-peer transport 관심사의 세션 상태 오염).
7. **capabilities 필드 협상 기각** — §1.3 마지막 행 + §2.3 (W1-B 리터럴 캐스케이드 실증 + server-global 선언에 per-peer 상태 오배치).

## §6 구현 착수 조건

1. **의존 충족 확인됨**: 01 connect()/SessionHandle LANDED(`c89bc49c1`) — 협상 노출 지점 실물 존재. 03-A LANDED — 심지어 :701에 04 계약이 선반영. ✅
2. **knob 3벌 시스템 grep** 선행(`QUANTA_SESSION_FULL_FIDELITY` declare 위치 — const-keyed 인벤토리 + CLI_FEATURE_GATES 시딩 배열에 **넣지 말 것**: 그 배열은 미설정 시 "1" 시드).
3. **⚠️ J 에이전트 `resumed`류 프레임과 kind 넘버링/디코더 switch 병합 조율** — 같은 [codec.ts `decodeKind`](../../../src/ipc/session/codec.ts) switch·`SessionTransportMessage` union을 두 작업이 동시에 확장. 착수 시 HEAD 재확인 + 그쪽 랜딩 위에 rebase(동시세션 규율, MASTER §6). 이 트리(ccb8480b7)엔 아직 `resumed` kind 부재 — 랜딩 시점 재검증.
4. S1 hellgate(OFF byte-identical, 4표면 전부)를 **첫 커밋**으로 — 헬게이트 RED 선행 프로토콜.
5. 티켓 v2 문서에 이 RFC의 정정 3건 역반영: (a) blast radius에서 bench/cost 제외+readout 추가, (b) S4 state-view안, (c) 협상 = fidelity-ack 프레임 확정.

## §7 Acceptance 초안 (티켓 전체 — v2 승계 + 이 RFC 추가분)

- [ ] knob OFF: 커널 이벤트에 full 필드 부재 — wire·in-proc 구독자·sqlite 아카이브·**JSONL 이벤트로그** 전부 byte-identical (hellgate, S1)
- [ ] ON+협상 피어: 256자 초과 전문 수신 / ON+미협상 wire 피어: full 부재 — **동시 접속 격리** (S3)
- [ ] **replay 3경로 누출핀**: tail replay · dup-command replay · **durable-log replay(preview 피어 resume)** 각각 red-on-injection (S3)
- [ ] reconnect 후 재협상으로만 fidelity 복원 (per-peer 상태는 연결 수명, S5)
- [ ] 스큐 매트릭스 §2.2 6행 각 1테스트 — 특히 신클라→구서버 무-ack 강등이 행 없이 `fidelity:"preview"`로 표면화 (S2)
- [ ] ack-before-snapshot 순서 핀 (S2)
- [ ] 상한 초과 → preview 강등 + `fidelityDegraded` 플래그 (플래그 없이 자르면 red, S1) — 캡은 32MiB frame guard([transports/stdio.ts:17](../../../src/ipc/session/transports/stdio.ts))에서 유도(JSON 이스케이프 최악 6× 팽창 감안 `MAX_FRAME_CHARS/8`=4MiB 제안 — 유도 근거 명시, 신규 임의 임계값 아님)
- [ ] 03-A field-shape 가드 green 유지 (optional additive 증명, S1)
- [ ] readout HTTP가 full을 서빙함을 고정하는 명시 테스트 + knob 문서 문구 (§3.4 결정의 핀)
- [ ] mid-turn usage: knob ON에서 `session.state.updated.lastTokenUsage` 도착 (S4)
