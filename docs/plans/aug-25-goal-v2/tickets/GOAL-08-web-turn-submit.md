# GOAL-08 — web: 원자적 `turn.submit`, goal scheduler lifecycle

**Priority:** P1 · **Depends on:** GOAL-07 · **크기:** 40+ tool-use, main-direct (protocol + kernel + daemon)

## 목적
웹/앱에서 goal continuation을 사용자 입력과 섞이지 않게 실행한다. `input.append` + `turn.run` 두 command 사이에 사용자 command가 끼어들 수 있으므로,
한 dispatch lease 안에서 검사·append·run을 원자적으로 수행하는 `turn.submit`을 추가하고, 웹 daemon에 CLI와 같은 wake controller를 조립한다.

## 작업명세
### 파일
- `src/protocol/session/commands.ts`
  ```ts
  export interface TurnSubmitCommand extends SessionCommandEnvelope<"turn.submit"> {
    readonly text: string; readonly images?: readonly ImageBlock[]
    readonly expectedSessionRevision: number
    readonly provenance: { kind: "goal-continuation"; objectiveId: string; objectiveRevision: number; attemptId: string }
  }
  ```
  command 목록(197-206)·codec·builder에 등록. `SESSION_COMMAND_TYPES` drift-guard 테스트 갱신.
- `src/kernel/session/reducer.ts` / `scheduler.ts` — `turn.submit` 핸들러: session revision 일치 → idle(turn 없음) → approval pending 없음 → draft empty → host objective authority에 provenance 검증(objectiveId/revision 일치, attemptId 미사용) → append → run. 하나라도 실패면 typed reject, 상태 불변.
  외부 client가 보낸 `turn.submit`은 provenance 재검증에서 거절되므로 위조 불가(authority가 attemptId를 발급한 것만 통과 — GOAL-06 registry reservation 재사용).
- 신규 `src/apps/web-daemon/goal-wake-compose.ts` — `startGoalWakeController` 재사용(hook을 CLI 전용 경로에서 `src/objective` 인접 공용으로 이동하면 slice fence 확인). enqueue = `sharedSession.dispatch(turn.submit)`. `sharedSession` 생성 후 compose, attach 성공 시 cancel/re-arm(GOAL-07), daemon close 전 `stop()`. `serve-stdio`는 제외.
- `activeTurnRef`: `goal enabled || follower enabled`이면 `createTurnActivity()` 1회(`conversation-action-surface.ts:68`), 두 기능이 같은 ref 공유.
- web `objective-pane`: GOAL-05 renderer의 데이터 모델 재사용(문자열 렌더는 web 자체).

## RED
`tests/unit/protocol/session-commands*.test.ts`, `tests/unit/kernel/session/*scheduler*.test.ts`, 신규 `tests/unit/kernel/session/turn-submit.test.ts`, `tests/unit/apps/web-daemon/goal-wake-compose.test.ts`
1. `turn.submit` 처리 중 `input.append`(user)가 큐에 들어와도 goal prompt와 사용자 텍스트가 한 turn input에 섞이지 않음(두 turn 또는 submit 거절).
2. approval pending 상태 submit → reject, transcript 불변.
3. `expectedSessionRevision` 불일치 → reject.
4. provenance objectiveRevision ≠ authority → reject; attemptId 재사용 → reject.
5. daemon close 후 timer/subscription 0(fake timer로 pending 0 assert).
6. attach 후 이전 thread revision의 queued submit → reject.
7. goal OFF면 `turn.submit` 핸들러는 등록돼 있어도 wake compose 0, `activeTurnRef` follower 조건과 동일.
8. `input.append`+`turn.run` 분리 호출로 continuation을 보내는 경로가 코드에 없음(grep ratchet 대신 compose 함수 단일 진입 테스트).

## E2E
- `tests/integration/goal-web-submit-daemon-e2e.test.ts`(신규, 기존 `*-daemon-e2e` 하네스): WS client로 `/goal` 설정 → replay cassette continuation 1회 → 사용자 메시지 동시 전송 → transcript에 두 turn이 분리 · approval 대기 중 continuation 미실행 · daemon teardown 후 프로세스 timer 0.

## Proof rails
GOAL-07 rail + `bun test tests/unit/protocol tests/unit/kernel tests/integration/goal-web-submit-daemon-e2e.test.ts`.

## 함정
- 프로토콜 codec은 web client(Tauri/embedded)와 버전 공유 — 신규 command는 additive, 기존 `turn.run` 의미 불변.
- `session.turn.submit`은 CLI에도 쓸 수 있지만 이 티켓은 web만; CLI 큐 경로 교체는 non-goal.
