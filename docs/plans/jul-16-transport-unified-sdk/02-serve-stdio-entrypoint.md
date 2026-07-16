# Ticket 02 — `quanta serve --stdio` (session.v1 stdio 서버 진입점)

- **Date:** 2026-07-16
- **Status:** DRAFT v2 (적대어딧 R1 반영) — 구현 미착수
- **기능:** session.v1을 말하는 stdio 서버 제품 진입점 (Codex app-server 패턴). 부수: heartbeat 응답기 daemon→ipc hoist, capabilities transport 스탬프 seam 관통.
- **왜:** stdio transport 스택이 구현돼 있는데 제품 문 0 (`createSessionStdioServer` 소비자 = conformance 픽스처뿐; headless는 transport 주입받는 라이브러리).
- **ROI:** 네트워크 포트 없이 IDE·사이드카 통합. 01 `transports.stdio`의 실제 대상. 부수로 선존 이슈 1종(capabilities.transport 전 세션 "inproc" 하드코드 거짓말) 수선.
- **Design SSOT:** [00-MASTER-PLAN.md](00-MASTER-PLAN.md). ADR-0520(reverse-MCP)과 다른 문(그쪽 MCP, 이쪽 session.v1).
- **Effort:** M (R1이 S–M의 "있는 부품 배선만" 전제를 반증 — 아래 신규 3점 때문)
- **의존:** 01 (attach-flow·liveness·클라)

---

## 1. 형태

```
quanta serve --stdio [--cwd <dir>] [--model <slug>] [--permission-mode <mode>]
```

- 프로세스 = 세션 1개(v1). 부트 = `openHeadlessRuntimeSession` 재사용.
- **배선 정정(R1 MED, R2 확인)**: `createSessionStdioServer`는 bridge를 직접 요구하는데 RuntimeSession은 bridge를 비공개 소유 → 그 함수는 못 쓴다. 실제 배선 = `createSessionStdioTransport({reader: stdin, writer: stdout})`를 **`openHeadlessRuntimeSession`의 기존 `input.transport` 옵션에 주입**(그 옵션이 attachSessionTransport까지 이미 수행, session-bridge.ts:109-113 — 2026-07-16 재확인) — 신규 배선 코드 최소.
- stdout = 프로토콜 전용, 로그/진단 = stderr (repo 로거는 이미 stderr 전용 — 라쳇의 진짜 위험원은 **자식 tool/MCP 프로세스의 stdio inherit**이며 라쳇 스코프에 명시).

## 2. R1이 드러낸 신규 작업 3점 ("배선만" 아님을 정직화)

1. **EOF 시맨틱 신설**: `StdioReader`는 data 이벤트만 — stdin EOF→graceful shutdown 통지는 additive 확장.
2. **heartbeat 응답기 hoist**: pong 응답은 web-daemon 전용([server/heartbeat.ts](../../../src/apps/web-daemon/server/heartbeat.ts)) — `@/ipc/session`으로 hoist해 stdio 서버도 응답. 정책 표(01 S7, R2 F6으로 정합화됨)와 일치: **stdio는 클라 기본 미발신·서버는 수신 시 pong**(클라 구현 관대성).
3. **transport 스탬프 seam**: capabilities.transport가 [base.ts:77](../../../src/host/runtime/internal/context-binding/base.ts) `"inproc"` 하드코드 — 컴포지션에서 transport 종류를 주입하는 seam 관통(web-daemon "websocket" 스탬프 정정 포함 여부는 별 커밋로 분리 — conformance "다름이 정답" 단언과 함께).

## 3. 게이팅 — 성숙 게이트 (보안 서사 기각)

- stdio는 부모-자식 신뢰 경계 — "attack surface" 논거 불성립(R1). 정직한 명분 = **미완 표면의 조기 소비 차단**(성숙 게이트).
- `QUANTA_SERVE_STDIO=1` 없으면 안내+비제로 exit. **CLI_FEATURE_GATES 금지**(미설정 시 "1" 시드 함정 — 넣는 순간 default-ON 사고). 직접 env 체크, 구현 시 시딩 시맨틱 재검증 테스트 동반.
- SDK `transports.stdio`는 env **자동 주입 금지**(게이트 우회 극장 방지). 게이트 OFF 자식이 즉시 종료하면 connect()가 stderr 요약 포함 typed error로 fail-fast(01 S4 lifecycle 계약).
- `--permission-mode` ↔ approval 관계는 01 §3.4 가이드를 문서에서 링크(무인 = bypass/acceptEdits; onApproval은 HITL).

## 4. 슬라이스

| # | 내용 |
|---|---|
| S1 | CLI 서브커맨드 등록(commands/ 모듈 패턴) + 성숙 게이트 |
| S2 | stdio transport 배선(§1 정정 경로) + EOF/SIGTERM graceful shutdown(WS1 프로세스트리 reap 재사용) |
| S3 | heartbeat 응답기 hoist(§2-2) |
| S4 | transport 스탬프 seam(§2-3) |
| S5 | stdout 순결성 라쳇(위험원 = 자식 프로세스 inherit — 도구 실행 중 오염 주입 시나리오 포함) |
| S6 | e2e: 실 spawn → 01 stdio 클라 → append/run/approval/완료 + EOF 종료 (fake-LLM 실루프) |
| S7 | 게이트 hellgate: OFF 진입차단+타 CLI 경로 byte-identical / ON 정상 |

## 5. Acceptance

- [ ] OFF: 진입 차단 + 기존 CLI byte-identical + SDK에서 붙으면 typed error(행 금지)
- [ ] ON: e2e green (approval 왕복 포함)
- [ ] stdin EOF·SIGTERM 각각 graceful shutdown, 자식/PTY 잔류 0
- [ ] heartbeat ping 수신 시 pong (hoist 검증 — web-daemon 경로 무회귀)
- [ ] 이 진입점의 **snapshot.capabilities**가 `transport:"stdio"` 선언 (스탬프 seam 검증 — session.created 프레임은 R2 F3대로 현행 tail 필터/미핸드셰이크 게이트에서 wire 관찰 불가라 단언 대상 아님; 그 전달 수선은 MASTER §0 선존 이슈로 별도) + **transport별 "다름이 정답" positive 단언 인수(R2 F2 — 01 S6에서 이동)**: 필수 = `stdio ≠ inproc`; ws의 "websocket" 정정(§2-3 별 커밋)이 랜딩되면 3-way로 승격 (R3 MED-1 — ws 정정 미랜딩 상태에서 3-way 단언 요구는 스코프 밖 충족 불가)
- [ ] stdout 오염 red-on-injection (자식 inherit 시나리오 포함)

## 6. Non-goals

- 멀티세션 멀티플렉싱(수요 확인 후 별도 RFC) · MCP(ADR-0520) · 인증/암호화(부모-자식 경계 밖 얘기) · web-daemon transport 스탬프 정정의 프론트 영향 조사(별 커밋)
