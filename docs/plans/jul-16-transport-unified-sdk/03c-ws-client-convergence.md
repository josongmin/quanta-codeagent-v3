# 03-C — WS 클라이언트 수렴 평가 (1페이지)

- **Date:** 2026-07-17
- **판정:** **수렴 보류(hold) — 현 시점 통합은 net-negative.** ipc raw 클라와 web-frontend SessionClient는 목적이 다른 두 계층이며, 지금 병합하면 브라우저 번들에 불필요한 표면이 실리거나 door 클라에 React-생명주기 가정이 샌다. 대신 **경계를 문서화**하고, 실제 중복이 생기는 지점(재접속 backoff 수학)만 이미 leaf(`reconnect.ts` 34줄)로 분리돼 있음을 확인한다.

## 실측 (2026-07-17)

| 축 | ipc raw 클라 ([client.ts](../../../src/ipc/session/client.ts), 316줄) | web-frontend SessionClient ([client.ts](../../../apps/web-frontend/src/ws/client.ts), 983줄) |
|---|---|---|
| 역할 | transport-agnostic 최소 클라: sendCommand · onMessage · resumeFromSeq 추적 · onConnectionState · 05 resume watcher | 브라우저 전용 완비 클라: 단일 WS 생명주기(connect/reconnect/close) |
| 재접속 | **없음** (door는 v1에서 자동 reconnect 미제공 — 01/05 스코프 밖, `onConnectionState("closed")` 통지까지) | `computeRetryDelayMs`(500ms·2^n backoff, jitter 없음 — 단일 테넌트라 결정론 유지, [reconnect.ts](../../../apps/web-frontend/src/ws/client.ts)) + 타이머 주입 |
| heartbeat | **없음** (서버측 pong 응답기는 02가 `@/ipc/session`으로 hoist 예정 — 클라 발신 ping은 미스코프) | app-level ping 25s + dead-timeout → reconnect (client.ts:153-182) |
| 상태 모델 | 순수 콜백 (프레임워크 무의존) | React 훅 생태계(session-hooks/pending-approvals/canvas-hooks/agent-state-hooks 등 ~20 모듈이 소비) |
| resume | 05 `resumeFromSeq` + `currentResumeFromSeq()` — door/durable 경로가 소비 | 자체 없음 (프론트는 reconnect 시 handshake 재수행) |

## 수렴 후보 3개와 판정

1. **재접속 backoff 수학** — 이미 [reconnect.ts](../../../apps/web-frontend/src/ws/client.ts) 34줄 순수 leaf로 분리됨. door가 언젠가 자동 reconnect를 원하면 **이 함수를 `@/ipc/session`으로 hoist**(단방향, 브라우저 의존 0)하는 게 정답 — 단 door reconnect 자체가 미스코프라 **지금 옮기면 dead-config**(jul-2 inert-config 교훈). **판정: door reconnect 티켓이 생길 때 hoist, 지금은 hold.**
2. **heartbeat 클라 발신** — 02가 서버측 pong 응답기를 hoist한 뒤, 클라 발신 ping을 door에도 줄지는 transport별로 다름(ws=유효, stdio=부모-자식이라 불요). **판정: 02 랜딩 후 재평가**, 프론트의 25s/dead-timeout 상수는 그때 참조.
3. **SessionClient 전체를 ipc 클라 위에 재작성** — 브라우저 클라의 983줄 중 ~600줄이 React 훅 연동/DOM 생명주기라 ipc 계층으로 내려보낼 수 없음. door 클라가 그걸 흡수하면 번들 오염 + 계층 역전. **판정: KILL**(두 클라는 영구히 다른 계층 — ipc=transport primitive, frontend=UI 생명주기 오케스트레이터).

## 결론

수렴할 **실제 중복은 backoff 수학 하나**이고 그건 이미 leaf라 필요 시 1함수 hoist면 끝. 나머지는 계층 차이(무프레임워크 primitive vs React 오케스트레이터)라 병합이 오히려 손해다. 03-C는 **"경계 문서화 + backoff hoist 조건부 예약"으로 종료**, 신규 코드 0. 03 티켓(A 라쳇·B 번들 소비 완료)의 마지막 조각.
