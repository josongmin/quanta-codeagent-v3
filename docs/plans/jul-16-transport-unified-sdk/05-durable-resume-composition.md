# Ticket 05 — `connect({resume})` durable resume 합류 (ADR-0540 W2 소비자)

- **Date:** 2026-07-16
- **Status:** DRAFT v2 — **BLOCKED on ADR-0540 Wave 2** (온디스크 KernelEventLogPort)
- **기능:** `connect({ resume: { sessionId, afterSeq } })`가 서버 프로세스 재시작을 넘어 동작 — 스냅샷 폴백이 아니라 온디스크 이벤트로그 replay로 복원. WS 재접속·stdio 재기동 동일 시맨틱.
- **왜:** 현행 replay는 bridge 메모리 tail(128) 한정 — 재시작이면 무조건 full-snapshot 폴백([bridge.ts:78-80](../../../src/ipc/session/bridge.ts)), 긴 단절이면 유실. substrate는 ADR-0540 W2 소유 — 이 티켓은 **SDK-가시 시맨틱만**.
- **ROI:** Codex/Claude 부재 기능(jul-16 어딧 확증) = 이 계획의 차별화 capability.
- **Design SSOT:** [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §2 — substrate 중복 구현 절대 금지.
- **Effort:** S (SDK측만)
- **의존:** **ADR-0540 W2 랜딩** + 01

---

## 1. 01과의 관계 (경계 명확화 — R1 MED 반영)

- 01은 `session.lastSeq()` + `connect({resumeFromSeq})` 페어로 **수동 재접속**(메모리 tail 한정, ahead-of-tip이면 full-snapshot 폴백)까지. 그것은 오늘 살아있는 시맨틱([planSessionReplay](../../../src/ipc/session/bridge.ts))의 노출이지 durable이 아니다.
- 05가 승격하는 것: 재시작-후 폴백 3경로(behind-window/ahead-of-tip/gap)가 온디스크 로그 조회로 대체 + `connect({resume})` 1급 옵션 + resume 실패의 정직한 강등 — **표면화 채널(R2 F5로 명명)**: 01이 예약한 `onConnectionState`의 connected 페이로드 `resume: "replayed" | "snapshot_fallback"` 필드를 소비(조용한 강등 금지).

## 2. 스코프 (좁게)

**짓는 것**: bridge에 이벤트로그 포트 주입 지점(tail-miss 시 로그 세그먼트 로드) · `connect({resume})` 옵션 · lastSeq 저장/복원 유틸 · 강등 표면화.

**짓지 않는 것**: 온디스크 로그 자체(포맷/rotation/fsync — ADR-0540 W2) · pending-approval rehydrate/replay short-circuit(W2 항목 1-5) · persistence-sqlite 통합(orthogonal 판정 유지).

## 3. 착수 조건 (선행 신호 — R1 LOW 반영 추가)

1. ADR-0540 W2 온디스크 KernelEventLogPort main 랜딩.
2. **seq 연속성 보장 확인**: 재시작 시 커널 seq가 0부터 재시작하는 현행([bridge.ts:71-77](../../../src/ipc/session/bridge.ts) 주석 명시)이 W2에서 "로그 tip에서 이어 발급"으로 바뀌는지 — W2 명세는 영속만 다루고 seq 연속성은 미커밋 상태다. **연속성이 없으면 resume 시맨틱 자체가 정의 불가** → W2에 요구사항으로 전달(이 티켓이 그 요구의 witness).
3. 이 계획 01 랜딩.

그 전에 하는 일 없음(설계 선반영 금지 — W2 포맷/seq 결정에 종속).

## 4. Acceptance

- [ ] 서버 kill→재기동→`connect({resume})`: 이벤트 replay로 단절 구간 수신, 스냅샷 폴백 아님 (ws·stdio 각각 e2e)
- [ ] 로그 gap 주입: 폴백 + 강등 사실이 `onConnectionState` connected 페이로드 `resume` 필드로 표면화 (조용한 강등 = red)
- [ ] 포트 미주입 환경: 현행 byte-identical
- [ ] seq 연속성 위반 주입 시 정의된 에러(미정의 동작 금지)
