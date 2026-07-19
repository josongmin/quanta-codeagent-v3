# Ticket 05 — `connect({resume})` durable resume 합류 (ADR-0540 W2 소비자)

- **Date:** 2026-07-16
- **Status:** ✅ LANDED — W4-b 527f78811 + core a38ee957f + door-resume 1f578f28f
- **기능:** `connect({ resume: { sessionId, afterSeq } })`가 서버 프로세스 재시작을 넘어 동작 — 스냅샷 폴백이 아니라 온디스크 이벤트로그 replay로 복원. WS 재접속·stdio 재기동 동일 시맨틱.
- **왜:** 현행 replay는 bridge 메모리 tail(128) 한정 — 재시작이면 무조건 full-snapshot 폴백([bridge.ts:78-80](../../../src/ipc/session/bridge.ts)), 긴 단절이면 유실. substrate는 ADR-0540 W2 소유 — 이 티켓은 **SDK-가시 시맨틱만**.
- **ROI:** Codex/Claude 부재 기능(jul-16 어딧 확증) = 이 계획의 차별화 capability.
- **Design SSOT:** [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §2 — substrate 중복 구현 절대 금지.
- **Effort:** S (SDK측만)
- **의존:** **ADR-0540 W2 랜딩** + 01

---

## 1. 01과의 관계 (경계 명확화 — R1 MED 반영)

- ~~01은 `session.lastSeq()` + `connect({resumeFromSeq})` 페어로 **수동 재접속**까지~~ **정정(jul-16 구현 적대어딧 KILL)**: 01의 `connect({resumeFromSeq})`는 **descope됨** — handshake ready가 snapshot 프레임에서만 settle하는데 [planSessionReplay](../../../src/ipc/session/bridge.ts)는 서빙 가능한 커서에 events-only(커서==tip이면 0프레임)로 답해 **영구 hang이 구조적**(ack-less라 caught-up 신호 부재). 01이 노출하는 것은 관측용 `lastSeq()`뿐. ⇒ **05의 스코프가 커짐**: 메모리-tail resume의 door-level 노출부터 durable까지 전부 이 티켓 소유(경로는 raw client `connect({resumeFromSeq})` resume watcher — 이미 main 랜딩 — 를 태우고, caught-up 신호 문제를 함께 풀어야 함: 예. resume-ack/served-marker additive 프레임 또는 handshake-외 재접속 프로토콜).
- 05가 승격하는 것: 재시작-후 폴백 3경로(behind-window/ahead-of-tip/gap)가 온디스크 로그 조회로 대체 + `connect({resume})` 1급 옵션 + resume 실패의 정직한 강등 — **표면화 채널(R2 F5로 명명)**: 01이 예약한 `onConnectionState`의 connected 페이로드 `resume: "replayed" | "snapshot_fallback"` 필드를 소비(조용한 강등 금지).

## 2. 스코프 (좁게)

**짓는 것**: bridge에 이벤트로그 포트 주입 지점(tail-miss 시 로그 세그먼트 로드) · `connect({resume})` 옵션 · lastSeq 저장/복원 유틸 · 강등 표면화.

**짓지 않는 것**: 온디스크 로그 자체(포맷/rotation/fsync — ADR-0540 W2) · pending-approval rehydrate/replay short-circuit(W2 항목 1-5) · persistence-sqlite 통합(orthogonal 판정 유지).

## 3. 착수 조건 (⚡07-16 스파이크 판정으로 좁아짐)

> **W2 replay 스파이크 판정**([w2-replay-spike-verdict.md](w2-replay-spike-verdict.md)): 구 "W2 전체"가 아니라 **item 0(온디스크 이벤트로그, W4-b 트랙)만이 이 티켓의 blocker**다. 승인 durability(W4-a: checkpoint+rehydrate+exactly-once)와는 상호 비블로킹 — 그쪽이 늦어도 이 티켓은 W4-b+01만으로 착수 가능. 재시작 후 pendingApproval 재렌더는 W4-a의 스냅샷 경로에서 공짜로 옴(이 티켓 스코프 아님).

1. **W4-b 온디스크 KernelEventLogPort main 랜딩** (구 W2 item 0 — 이제 티켓 05 전용 독립 트랙).
2. **seq 연속성 보장 확인**: 재시작 시 커널 seq가 0부터 재시작하는 현행([bridge.ts:71-77](../../../src/ipc/session/bridge.ts) 주석 명시)이 "로그 tip에서 이어 발급"으로 바뀌는지 — **연속성이 없으면 resume 시맨틱 자체가 정의 불가** (요구는 ADR-0540 W2 item 0에 전달돼 있음, 이 티켓이 witness).
3. 이 계획 01 랜딩.

그 전에 하는 일 없음(설계 선반영 금지 — W4-b 포맷/seq 결정에 종속).

## 4. Acceptance

- [ ] 서버 kill→재기동→`connect({resume})`: 이벤트 replay로 단절 구간 수신, 스냅샷 폴백 아님 (ws·stdio 각각 e2e)
- [ ] 로그 gap 주입: 폴백 + 강등 사실이 `onConnectionState` connected 페이로드 `resume` 필드로 표면화 (조용한 강등 = red)
- [ ] 포트 미주입 환경: 현행 byte-identical
- [ ] seq 연속성 위반 주입 시 정의된 에러(미정의 동작 금지)
