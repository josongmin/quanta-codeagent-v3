# Ticket — 합성 session.created가 신규 attach 클라에게 사실상 미전달 (의심 선존버그)

- **Date:** 2026-07-16
- **Status:** OPEN — 코드리딩 2회(독립 감사 에이전트 2명) 교차 확인, **런타임 미재현** (verify 먼저)
- **발견 경위:** jul-16-transport-unified-sdk 계획 적대어딧 R1/R2에서 부산물로 발견 ([계획 MASTER §0](../plans/jul-16-transport-unified-sdk/00-MASTER-PLAN.md))
- **기능(수선 시):** attach 직후 클라가 session.created(capabilityManifest+model)를 실제로 수신
- **왜:** 이벤트의 존재 이유가 "freshly-attached client의 모델 pill 시딩"(engine.ts 주석)인데 실동작이 그 반대로 의심됨
- **ROI:** 신규 클라의 첫-프레임 계약 단순화(현재는 snapshot에서 capabilities를 읽는 우회가 사실상 강제) — transport-unified SDK 01의 DX 문서가 이 우회를 정본으로 적고 있음

## 증거 사슬 (코드리딩)

1. `attachSessionTransport`가 합성 session.created를 `seq = box.state.seq`(현재 tip)로 발행 — [engine.ts:172](../../src/sdk/runtime/session/engine.ts)
2. bridge snapshot이 attach 시점 같은 state로 시딩 → tail 필터 `seq > snapshot.seq`에서 **탈락** — [bridge.ts:104](../../src/ipc/session/bridge.ts)
3. live fan-out 경로도 발행 시점엔 peer가 connect 프레임 전이라 `peer.connected=false` 게이트에서 **탈락** — [bridge.ts:392](../../src/ipc/session/bridge.ts)
4. 결과: 정작 대상인 신규 attach 클라는 못 받고, 기존 peer들에게 dup-seq 노이즈로만 전파 의심

## 액션

1. **verify**: 실 WS attach(quanta attach 또는 web-frontend)에서 session.created 수신 여부 캡처 — 코드리딩 결론의 런타임 확증/반증
2. 실재 시 수선 후보: seq+1 발행(tail 진입) vs "전달 비보장, snapshot이 정본" 공식화(주석·계약 정정) — 전자는 seq 발급 규율 검토 필요
3. transport-unified SDK 02(stdio 진입점)가 이 경로를 그대로 밟으므로, 그 acceptance는 이미 session.created 비의존으로 조정돼 있음(추가 조치 불요)

## 경계

- 소유자 미정 (transport-unified-sdk 계획 스코프 밖으로 판정됨 — 그 계획은 snapshot.capabilities 정본화로 우회)
- ADR-0540 이벤트로그 W2와 무관 (wire-전달 문제, 영속 문제 아님)
