# Ticket — 합성 session.created가 신규 attach 클라에게 사실상 미전달 (선존버그, 런타임 확증)

- **Date:** 2026-07-16
- **Status:** CONFIRMED — 코드리딩 2회 교차 확인 후 **런타임 재현 완료**(2026-07-16, 실 스택 in-memory transport 재현 — 아래 런타임 증거)
- **발견 경위:** jul-16-transport-unified-sdk 계획 적대어딧 R1/R2에서 부산물로 발견 ([계획 MASTER §0](../plans/jul-16-transport-unified-sdk/00-MASTER-PLAN.md))
- **기능(수선 시):** attach 직후 클라가 session.created(capabilityManifest+model)를 실제로 수신
- **왜:** 이벤트의 존재 이유가 "freshly-attached client의 모델 pill 시딩"(engine.ts 주석)인데 실동작이 그 반대로 의심됨
- **ROI:** 신규 클라의 첫-프레임 계약 단순화(현재는 snapshot에서 capabilities를 읽는 우회가 사실상 강제) — transport-unified SDK 01의 DX 문서가 이 우회를 정본으로 적고 있음

## 증거 사슬 (코드리딩)

1. `attachSessionTransport`가 합성 session.created를 `seq = box.state.seq`(현재 tip)로 발행 — [engine.ts:172](../../src/sdk/runtime/session/engine.ts)
2. bridge snapshot이 attach 시점 같은 state로 시딩 → tail 필터 `seq > snapshot.seq`에서 **탈락** — [bridge.ts:104](../../src/ipc/session/bridge.ts)
3. live fan-out 경로도 발행 시점엔 peer가 connect 프레임 전이라 `peer.connected=false` 게이트에서 **탈락** — [bridge.ts:392](../../src/ipc/session/bridge.ts)
4. 결과: 정작 대상인 신규 attach 클라는 못 받고, 기존 peer들에게 dup-seq 노이즈로만 전파 의심

## 런타임 증거 (2026-07-16 재현 — CONFIRMED)

실 스택(`createRuntimeSession` → 실 `attachSessionTransport`(engine.ts) → 실 `createSessionTransportBridge`) + in-memory `SessionTransport`(send 기록/connect 프레임 주입)로 재현. 순서는 WS 데몬과 동일(attach 완료 후 클라 connect 프레임 도착 — `buildRegisteredSession`이 socket open 시 attach, connect는 네트워크로 나중 도착). 일회성 테스트 파일로 실행 후 삭제(bun test 2 pass).

- **시나리오 1 (신규 attach + 핸드셰이크):** in-proc 구독자(control)는 `session.created(seq=0)` 수신 — 이벤트 합성·발행 자체는 실재(하네스 non-vacuous). 그러나 **신규 attach 클라 A가 받은 프레임 전량 = `snapshot(seq=0, rev=0)` 1장뿐, session.created 0건.** snapshot엔 capabilities+modelSlug 포함(현행 우회 경로가 실제로 정보를 나름).
- **시나리오 2 (A 연결 완료 상태에서 B attach):** `input.append`로 tip을 seq=1로 올린 뒤 B attach → **A(대상 아님)가 `event(session.created, seq=1)` 수신 — A가 이미 받은 `session.state.updated(seq=1)`와 같은 seq(dup-seq 노이즈 확증).** B는 connect 전 0프레임, connect 후 `snapshot(seq=1)`뿐 — **B(대상)는 session.created 미수신.**
- **적대 검증(반증 시도):** (i) 데몬 WS 래퍼(`transports/websocket.ts`)는 핸들러 등록 전 도착 프레임을 버림(버퍼링/동기 재생 없음) + WS message는 macrotask라 `await connect()` microtask 갭에 끼어들 수 없음 → 실 데몬에서도 발행 시점 `peer.connected=false`가 결정론적(레이스로 우연 수신하는 경로 없음). (ii) 보상 레이어 부재 — transport 경로의 session.created 생산자는 engine.ts가 유일(stream-json-sink는 별도 stdout 서피스), 클라 측 합성도 없음. (iii) 죽은 소비자 실재 — CLI attach 렌더러([render.ts:86](../../src/apps/cli/attach/render.ts))의 `[session · <model>]` 라인은 자기 attach에선 절대 발화 불가, 남의 attach 때만 dup-seq로 발화.

## 수선 방향 트레이드오프 (2안)

**A안 seq+1 발행**은 tail 필터를 통과시켜 connect replay로 전달되게 하지만 seq 발급 규율을 깬다: kernel state.seq를 실제로 안 올리면 다음 커밋 이벤트가 같은 seq를 재사용(진짜 dup-seq 충돌 — resume 커서/dedup 혼선)하고, 올리면 read-path여야 할 attach가 상태 변이가 되어 재연결마다 seq 인플레이션 + per-attach 유니캐스트 의도의 이벤트가 broadcast tail에 들어가 다른 peer의 이후 resume replay에까지 노이즈로 남는다(제대로 하려면 사실상 bridge에 seq 규율 밖 per-peer direct-send 3안이 필요). **B안 "전달 비보장, snapshot이 정본" 공식화**는 이미 사실인 상태의 문서화다 — snapshot이 capabilities+modelSlug를 다 나르는 것이 런타임 증거로 확인됐고 transport-unified SDK 01 DX 문서도 이미 이걸 정본으로 적음; engine.ts 주석 정정 + 합성 발행 제거(기존 peer로의 dup-seq 노이즈도 소멸)로 끝나며, 유일한 주의점은 in-proc 구독자는 이 이벤트를 실제로 받고 있으므로(S1 control) in-proc 소비자 유무 확인 후 제거해야 한다는 것(attach render.ts 렌더러는 어차피 자기 attach에선 못 받는 죽은 코드라 함께 정리 가능). 저위험·저비용인 B안 우세, wire 전달이 정말 필요해지면 B 위에 unicast 3안을 얹는 순서가 맞다.

## 액션

1. ~~**verify**: session.created 수신 여부 캡처~~ — **DONE 2026-07-16, CONFIRMED** (위 런타임 증거; engine+bridge 실 스택 in-memory 재현 + WS 레이스 반증)
2. 수선 후보: seq+1 발행(tail 진입) vs "전달 비보장, snapshot이 정본" 공식화(주석·계약 정정) — 트레이드오프는 위 문단, B안(공식화) 우세
3. transport-unified SDK 02(stdio 진입점)가 이 경로를 그대로 밟으므로, 그 acceptance는 이미 session.created 비의존으로 조정돼 있음(추가 조치 불요)

## 경계

- 소유자 미정 (transport-unified-sdk 계획 스코프 밖으로 판정됨 — 그 계획은 snapshot.capabilities 정본화로 우회)
- ADR-0540 이벤트로그 W2와 무관 (wire-전달 문제, 영속 문제 아님)
