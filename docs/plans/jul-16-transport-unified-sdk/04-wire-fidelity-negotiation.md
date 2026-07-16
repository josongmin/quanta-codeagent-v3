# Ticket 04 — wire fidelity opt-in (full payload)

- **Date:** 2026-07-16
- **Status:** DRAFT v2 — **R1 HIGH 반영 재설계.** 구현 미착수. 이 계획에서 리스크 최고 티켓 — 착수 전 자체 미니 RFC 1회 더 권장.
- **기능:** 클라가 opt-in하면 SessionEvent가 tool args/result **전문** + mid-turn usage를 운반. 기본 = 현행 preview, 전 소비자 byte-identical.
- **왜:** ~256자 truncate는 웹 UI용 설계인데 01로 열리는 외부 소비자(오케스트레이터·관측 도구)에겐 부족. "embed rebase" 기각(MASTER §1.3) 후 두 문이 수렴할 유일하게 정직한 경로.
- **ROI:** wire로 embed급 관찰가능성. 미협상 클라 무영향.
- **Design SSOT:** [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §1.3 · §3.4-3.
- **Effort:** **L** (v1의 M은 R1이 반증 — 아래 실지형 때문)
- **의존:** 01(협상 노출 클라) · 03-A(field-shape 안전망)

---

## 1. 실지형 (R1 정정 — v1 초안의 두 anchor 팩트가 틀렸었음)

1. **truncate 위치**: 투영 레이어가 아니라 [session-host-turn-event-bridge.ts:141-160](../../../src/host/runtime/internal/session-host-turn-event-bridge.ts)(`PREVIEW_MAX=256`, clampPreview) — 그리고 **커널 포트 타입 자체가 preview 필드만 운반**([kernel/session/ports.ts:116,123](../../../src/kernel/session/ports.ts)). full은 host-bridge→커널 포트→SessionEvent 타입→ipc bridge **4레이어 관통** additive 확장.
2. **"기존 capabilities 협상" 부재**: connect 프레임은 sessionId/resumeFromSeq/surfaceSubscription뿐, M18c는 버전 **검증**이지 협상 아님, manifest는 server→client 일방 선언. per-peer 협상은 **신규 wire 표면**이다.
3. **blast radius**: full을 커널 이벤트에 실으면 in-process 구독자 전원(engine subscription hub → web-daemon persistence-sqlite 아카이브 등)이 받는다 — wire byte-identical만으론 부족, **in-proc·디스크 정책까지** 스펙해야.

## 2. 설계 (실지형 반영)

- **운반**: 기존 preview 필드는 불변 유지, `argsFull?`/`resultFull?` **optional 필드 병행**(additive — 구클라·copy·hellgate 무영향). 커널 포트/SessionEvent 타입에 optional 확장.
- **생산 게이트**: full 생산 자체를 서버 knob `QUANTA_SESSION_FULL_FIDELITY`(default-OFF)로 게이트 — OFF면 커널 이벤트에 full 필드 자체가 없음 = in-proc/아카이브 포함 전 경로 byte-identical (blast-radius §1-3의 1차 방어).
- **협상**: connect 프레임에 `requestedFidelity?`(additive) → 확정은 **peer-로컬 응답**으로(공유 snapshot manifest에 넣지 않음 — bridge는 단일 snapshot 브로드캐스트라 per-peer manifest 리라이트는 스코프 폭발, R1 MED). ipc bridge가 peer fidelity에 따라 full 필드 strip(preview peer에 full 누출 금지 — tail replay·dup-replay 경로 포함).
- **ON+미협상 peer 정책**: 아카이브 등 in-proc 소비자가 full을 받는지 여부를 knob 문서에 명시(권장: in-proc은 full 수신 — trusted; wire는 협상 peer만).
- **mid-turn usage**: `turn.usage`(additive 이벤트) — full fidelity 협상과 같은 게이트.
- **크기 방어**: 단일 이벤트 상한 = 기존 32MiB frame guard에서 유도(신규 임의 임계값 금지), 초과 시 preview 강등+강등 플래그.
- **thinking delta = v1 제외**(reasoning 노출 정책 별도 축).

## 3. Acceptance

- [ ] knob OFF: 커널 이벤트에 full 필드 부재 — wire·in-proc 구독자·sqlite 아카이브 전부 byte-identical (hellgate)
- [ ] ON+협상: 256자 초과 전문 수신 / ON+미협상 wire peer: full strip (동시 접속 격리 테스트 — tail replay·dup-replay 경로 포함)
- [ ] reconnect replay에서도 fidelity 준수
- [ ] 상한 초과 → 강등+플래그 (red-on-injection: 플래그 없이 자르면 red)
- [ ] 03-A field-shape 가드가 신규 optional 필드에서 green (copy 미소비 필드 additive 안전성 증명)

## 4. Non-goals

- thinking delta · AgentEvent 40종 전체 승격(subagent 등은 전용 topic 선례 따름) · embed 경로 변경 · per-peer snapshot manifest 리라이트
