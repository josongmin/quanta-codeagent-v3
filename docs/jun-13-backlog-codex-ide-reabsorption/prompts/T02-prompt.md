# 구현 프롬프트 — T02: `thread-follower` co-control 프로토콜 + queue modes

## 미션
보조(follower) 클라이언트가 한 라이브 스레드를 timeout-bounded verb로 공동조종(steer/interrupt/edit-last-turn/approval relay)하게 한다. mutation/steering은 typed control channel/session verb 위, readout은 out-of-band 유지. slash.run 재발명 금지. default-OFF.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/02-thread-follower-cocontrol.md` 정독. 통합은 `00-index.md §8`. 선행참조 [[jun-09-cli-web-parity-plan-and-existing-mechanism]].

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 아래 유즈케이스 e2e 먼저, 전부 RED. 실 transport 관통.
2. **핵심 로직 TDD + 구조적 구현**: follower verb를 session.v1/control-request 위에 구조적으로. lease 경계 존중.
3. **적대적 어딧 ≥3R**: lease race, timeout 후 stale-decision relay, single-writer 자기모순, HARD_DENY 우회.
4. **셀프 어딧**: synthetic onConfirm green이 실 경계 가린 사례([[jun-09-adr0512-p3-4verb-card-display-only]]) 재발 점검.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** mid-turn steer: running 턴에 follower가 `steer-turn` → lease holder에 **inject**되어 다음 step에 반영(별도 writer 안 됨). e2e: steer 후 출력에 반영 단언.
- **UC2** interrupt: follower `interrupt-turn` → 턴 중단 + 상태 일관.
- **UC3** approval relay: follower가 `command-approval-decision` 대리 제출, **단 HARD_DENY는 relay 앞에서 fail-closed**(red-on-injection: 위험명령 relay-approve가 통과하면 red).
- **UC4** timeout: verb가 timeout 내 무응답 시 정의된 폴백(stale-decision 적용 안 됨).
- **UC5** queue mode: `queue|steer|interrupt`(기존 inbound-mode 매핑) per-message invert 핫키 동작.

## 코드 앵커 (실측)
- transport: `src/ipc/session/index.ts`(stdio/WS, codec), `src/shared/jsonrpc/correlation.ts`.
- 명령: `src/protocol/session/commands.ts`(`ApprovalRespondCommand:42`).
- thin-client: `src/agent/thin-client-dispatch/types.ts`. inbound 3-mode: `QUANTA_INBOUND_MODE`.

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A. **knob**: 신규 최소화 — 기존 `QUANTA_THIN_CLIENT_DISPATCH` 확장 + `QUANTA_INBOUND_MODE` 재사용(weave≈steer). knob-inventory describe 갱신만.
- **CLI**: `src/apps/cli/slash/registry-session.ts`에 session-scoped verb. **Web**: control-request(ADR-0496). **config**: N/A(기존 inbound config).

## 규율
- readout=out-of-band, mutation=typed channel split 유지. generic queue 평탄화 금지.
- running 턴 single-writer lease 자기모순 회피(steer=inject 경로). claim-100 ⇒ ≥3R. worktree 시 HEAD==main+ff.
