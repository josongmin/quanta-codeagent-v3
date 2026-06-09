# ADR-0525: Session resilience — persisted crash-resume marker (§13.2) + aggregate store-health diagnostic (§13.1)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **슬라이스**: `@/session` (`src/session/crash-resume.ts` NEW, `src/session/store-health.ts` NEW). 둘 다 기존 snapshot store(`@/session/store.ts`) 위에 얹는 leaf 모듈 — 새 on-disk 파일·새 sqlite 없음.
- **게이트**: crash-resume = `QUANTA_CRASH_RESUME`(`@/shared` `gateOn`, default-OFF, byte-identical degrade). store-health = 게이트 없음(자동 실행 안 되는 진단; 호출자가 명시적으로 부를 때만 돈다).
- **관련**:
  - 확장: `src/agent/interrupted-turn.ts`(jun-08 in-memory `InterruptedTurnBuffer` — 단일 프로세스 내 인터럽트 복원). 본 ADR은 그 휘발성 버퍼에 빠진 **durability 레이어**를 추가한다(하드 크래시 = SIGKILL/OOM/전원 손실로 버퍼가 통째로 날아가는 케이스).
  - Codex parity: store-health는 Codex `state db` 레이어의 aggregate persistence-failure 메시징(`state db ... failed`, compaction/repair 힌트)의 quanta 아날로그. quanta는 file-per-session(sqlite 아님)이라 aggregate 신호 = "몇 %의 파일이 로드를 거부했나".
  - 메모리: `jun-09-integration-audit-3round`(§13.2 crash-resume **built-but-not-wired** 플래그), `agent-state-observability-northstar`.

## Context

기존 인터럽트-복원은 **in-memory only**다. `InterruptedTurnBuffer`(jun-08)는 한 프로세스 안에서 인터럽트된 턴을 복원하지만, 하드 크래시가 턴 도중에 나면 그 버퍼가 통째로 사라져 작업이 증발한다. 즉 "이어서 해줘"가 프로세스 경계를 못 넘는다.

둘째로 세션 store에 **aggregate 손상 신호가 없다**. per-file read path(`readSavedSession`)는 한 파일이 깨져도 `undefined`+`logger.warn`으로 graceful degrade한다 — 좋다. 하지만 store 전체가 못 읽히는 상황(디스크 폴트, 어긋난 마이그레이션, 암호화 키 손실, 모든 파일을 덮어쓴 sync 충돌)에서 사용자는 그냥 **빈 세션 목록**을 본다 — "아직 세션 없음"과 구분이 안 된다. 무엇이 잘못됐는지 설명이 0이다.

## Decision

두 leaf 모듈을 `@/session` 슬라이스 안에 추가한다.

**1. crash-resume (`src/session/crash-resume.ts`, §13.2)** — 인터럽트-턴 마커를 세션 SNAPSHOT(`SessionMeta.interruptedTurn`)에 영속화한다.
- `markSessionInterrupted` / `clearSessionInterrupted`: best-effort 마커 persist/drop. **NEVER throws**(마커는 durability이지 correctness 불변식이 아니다 — 못 써도 라이브 턴을 깨면 안 됨). last-interrupt-wins idempotent overwrite.
- `detectInterruptedSessions`: 재시작 시 후보 세션 목록을 스캔해 마커를 든 세션을 most-recent-first로 반환. per-id snapshot이 SSOT(인덱스는 lag 가능한 derived cache)라 후보마다 snapshot을 재확인. 단일 unreadable 세션은 skip(전체 sweep 안 죽임).
- `buildCrashResumeOffer` / `buildCrashResumeMessage`: **PURE**(I/O·clock·RNG 없음). detection → operator-facing offer(요약 + 재주입 resume 메시지). resume 메시지는 `role:"user"` continuation으로 재주입돼 에이전트가 끊긴 작업을 이어받음.
- **GATE default-OFF**: `QUANTA_CRASH_RESUME` 부재 ⇒ 모든 동작이 NO-OP(마커 안 씀, detection은 `[]`). 세션 파일은 pre-ticket과 byte-identical. env는 INJECTED(`@/session`은 env-pure — slice-boundary 가드가 `process.env` 리터럴 금지). env 미주입 ⇒ OFF(fail-safe).

**2. store-health (`src/session/store-health.ts`, §13.1)** — store-level AGGREGATE 손상 탐지 + operator 복구 가이드.
- `checkSessionStoreHealth`: `<root>/*.json`(active) + `<root>/archived/*.json`을 스캔해 각 파일을 `ok | corrupt | unreadable`로 분류, 명시적 ratio 정책으로 `empty | healthy | degraded | corrupt` verdict 산출. magic threshold 없음 — `corrupt` = 모든 파일 실패(ok===0 & total>0), `degraded` = 일부 실패.
- `buildRecoveryGuidance`: **PURE**. non-healthy일 때 root·손상 비율·구체적 next step(file-per-session이라 per-file 복구; 인덱스는 derived cache라 지우면 rebuild)을 담은 operator 메시지 생성.
- **HOT-PATH 아님**: 자동 실행 안 됨 — `/doctor`류 명령 또는 "리스트가 비었는데 디렉터리는 non-empty" 트리거에서 호출자가 명시적으로 부를 때만 돈다. 그래서 게이트가 필요 없다(라이브 루프 byte-identity 우려 없음). **NEVER throws** — 모든 fs 에러(잘못된 파일명이 `sessionFilePath`를 throw시키는 케이스 포함)는 report로 캡처.

## Consequences

- **현재 unwired (built-but-not-wired)**: 두 모듈 다 `@/session` barrel로 export-only이고, `QUANTA_CRASH_RESUME`는 knob-inventory에 등재됐지만(`src/config/knob-inventory.ts`), apps/cli·host에 **라이브 호출자가 아직 없다**(jun-09 integration-audit가 이미 §13.2를 built-but-not-wired로 플래그). 따라서 fc 엔트리의 surface_integration은 `cli/web: na` + `deliberate_hold`로 정직하게 기록한다. 승급 경로 = ① 호스트 restart 부트스트랩이 `detectInterruptedSessions`→`buildCrashResumeOffer`를 호출하고 operator prompt 배선, ② `/doctor`(또는 empty-list 트리거)가 `checkSessionStoreHealth`를 부르고 guidance 렌더.
- **테스트로 봉인됨**: `tests/unit/session/crash-resume.test.ts`, `tests/unit/session/store-health.test.ts`, 그리고 §13.2 CROWN JEWEL hellgate `tests/integration/crash-resume-hellgate.test.ts`(interrupt → persist → CRASH → restart → detect → offer → resume 풀 경계 + default-OFF 회귀)가 contract(byte-identity, NEVER-throws, recent-first, verdict ladder)를 검증한다.
- **트레이드오프**: store-health의 shape 체크는 `savedSessionSchema`(store.ts, 의도적으로 strict)를 재실행하지 않는다 — aggregate HEALTH 신호엔 "그럴듯한 세션 파일인가 vs 쓰레기인가"만 필요. parse는 되지만 strict schema에 실패하는 파일도 `corrupt`로 분류(실제 경로에서도 어차피 로드 안 됨). 정확도보다 NEVER-throws + 진단 명료성 우선.

### Alternatives considered

- **별도 on-disk crash 저널 파일**: snapshot 외 새 파일을 두면 또 하나의 손상·정합성 표면이 생긴다. 거부 — 기존 `SessionMeta.interruptedTurn` 필드에 얹어 store가 이미 다루는 atomic-write·정합성을 재사용.
- **store-health를 hot path에서 자동 실행**: 매 로드마다 전체 디렉터리 스캔은 비용. 거부 — 진단은 명시적 호출(operator-asked)로만. default-OFF 게이트보다 "절대 자동으로 안 돈다"가 더 안전한 byte-identity 보장.
- **crash-resume를 항상-ON**: default-OFF로 유지. 마커 쓰기는 매 턴 snapshot churn을 더하고, durability는 correctness가 아니라 opt-in 편의 — pre-ticket byte-identity를 깨지 않는 게 우선.
