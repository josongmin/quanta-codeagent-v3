# GOAL-06 — wake safety: ticker 제거, quiescence projection, backoff, hard cap, bounded registry

**Priority:** P0 · **Depends on:** GOAL-04 (settlement outcome이 backoff 입력) · **크기:** 40+ tool-use, main-direct

## 목적
autonomous wake를 bounded로 만든다: judge/verifier 장애·no-progress·error에서 15초 hot loop가 아니라 backoff/cooldown,
사용자 입력·plan mode·approval·queue pending이면 절대 fire 안 함, budget 없이도 제품 hard cap, registry 크기 O(active objective).

## 작업명세
### 파일
- `src/apps/cli/goal-continuation-hook.ts`
  - `startGoalContinuationTicker`(191-216, setInterval) 및 `DEFAULT_INTERVAL_MS`/`setIntervalFn`/`clearIntervalFn` 삭제. `goal-continuation-ticker-hellgate.test.ts`·`goal-ticker-concurrency-hellgate.test.ts`는 controller 대상으로 이전 또는 삭제(무엇을 대체 보장하는지 명시).
  - quiescence projection(신규 `src/apps/cli/repl/goal-quiescence.ts`, pure):
    ```ts
    interface GoalQuiescenceSnapshot { turnActive; planModeActive; externalPromptPending; textPending; imagePending; planPending; followupPending; approvalPending; attachingOrClosing }
    export const isQuiescent = (s: GoalQuiescenceSnapshot): boolean
    ```
    입력은 기존 store 읽기: `activeTurnRef`, 라이브 identity mode(`interactive-setup.ts:309`의 `setup.planMode` 정적 → `activeIdentityModeState.get()==="plan"` OR), `external-prompt-queue`, text/image/plan 큐, lifecycle follow-up, pending approval(`mid-turn-approval-channel`), attach/close 플래그. 새 store 없음.
    arm 시점과 fire 직전 **두 번** 검사(`evaluateGoalWakeFire` 입력에 projection 추가).
- `src/objective/goal-wake-controller.ts`
  - 신규 pure `computeGoalWakeDelay(domain, policy, lastSettlement, now): { delayMs } | { skip: reason }`:
    progress(transition/verifier delta>0) → `minQuietMs` · 성공 no-progress → `min(minQuiet·2^n, maxBackoffMs)` · error/refusal → capped backoff ·
    `usage_limited` → `untilEpochMs - now` 1회 · `budget_limited|completed|blocked|paused` → skip · verifier/judge infra unavailable(같은 revision) → `cooldownMs` · 사용자 활동 → n 리셋 + full quiet.
    n(consecutive no-progress)은 `progressReceipts` 꼬리에서 계산(별도 카운터 저장 없음).
  - registry: `claims: Map<string,…>`(181) → `Map<`${threadId}:${objectiveId}`, { highestCommittedOrdinal: number; reserved?: number }>`; objectiveId 변경/clear/attach 시 entry 삭제.
  - `evaluateGoalWakeFire`에 `quiescent: boolean` 입력 추가.
- knob SSOT: `src/shared/runtime-config-knobs/knobs-b.ts` — `QUANTA_GOAL_QUIET_MS` 하한 clamp `GOAL_QUIET_MIN_MS=15_000`(테스트는 `allowUnsafeQuiet` 옵션이 아니라 injected policy로 짧게), `QUANTA_GOAL_MAX_BACKOFF_MS`(default 900_000), `QUANTA_GOAL_MAX_AUTONOMOUS_TURNS`(default 20; objective budget 있으면 그것이 우선, 없으면 이 cap). 세 값 정의는 `src/objective/goal-wake-policy.ts` 한 곳에서 export, hook·runtime-config·catalog가 참조.
- `src/apps/cli/repl/session-loop/interactive-setup.ts` — `planModeActive` 라이브화, projection 조립.
- GOAL-00에서 격리한 PTY 순서의존 red의 구조 원인이 여기 있으면 여기서 수정.

## RED
`tests/unit/objective/goal-wake-controller.test.ts`, `tests/unit/apps/cli/goal-wake-hook.test.ts`, 신규 `tests/unit/objective/goal-wake-policy.test.ts`, `tests/unit/apps/cli/goal-quiescence.test.ts`
1. no-progress 10회 연속 → fire 간격이 15s,30s,60s,…(fake timer), 고정 15s면 RED.
2. judge/verifier unavailable 후 같은 revision → cooldown 동안 arm 0; revision 변경(사용자 edit) → 즉시 base quiet로 리셋.
3. `maxAutonomousTurns=3`, budget 없음 → 3회 후 wake 0, status `budget_limited`.
4. objective budget `maxTurns=5`가 있으면 cap 3보다 우선(5회).
5. plan mode 라이브 진입(정적 setup.planMode=false) → fire 0.
6. approval pending / text queue pending / attaching → fire 0, 해소 후 1회.
7. `QUANTA_GOAL_QUIET_MS=1` → 파싱 결과 15_000(+경고 1줄).
8. 100_000 attempt(ordinal) 후 registry size === active objective 수.
9. clear/replace → 해당 registry entry 삭제.
10. `startGoalContinuationTicker` import → 컴파일 에러(삭제 증명).
11. agent body throw → `activeTurnRef.current` 정리(finally), 이후 wake가 `turnActive`로 영구 차단되지 않음.
12. continuation 자신의 enqueue(queue push)가 자기 attempt claim을 취소하지 않음(기존 `goal-wake-hook.test.ts:125` 확장).
13. queued continuation 이후 local input 도착 → dequeue 시 drop, agent body 0회.
14. UI idle suppression(`QUANTA_IDLE_SUPPRESS=0`)과 goal quiet 독립 — 기존 PTY 유지(GOAL-00에서 순서의존 red 해소 전제).
15. red-on-injection: `computeGoalWakeDelay`의 backoff 분기를 `minQuietMs`로 고정한 mutant에서 1 RED; fire-time projection 검사를 제거한 mutant에서 5·6 RED.

## E2E
- PTY(quiet는 injected policy로 200ms): (a) cassette 3연속 error → 3 fire 간격이 증가(타임스탬프 diff), (b) `/goal budget --max-turns=2` 후 wake 정확히 2, (c) 부분 draft 입력 중 wake 0(기존 테스트 유지), (d) `Ctrl+B` bg turn 중 wake 0(기존), (e) `/goal edit` 후 cooldown 무시하고 base quiet로 1회.
- `tests/integration/goal-continuation-live-e2e.test.ts`: verifier unavailable(비-git cwd) → cooldown, 같은 revision 재fire 0.

## Proof rails
GOAL-04 rail + `bun test tests/unit/goal-*.test.ts tests/unit/objective/goal-wake-controller.test.ts tests/e2e-pty/cli-goal-pursuit-e2e.test.ts`.

## 함정
- `tests/unit/agent/loop-throw-dispose-hellgate.test.ts:83`("mid-turn throw clears the daemon wake interval")는 legacy ticker interval을 관측함 — ticker 삭제 시 이 테스트를 controller timer 정리로 **대체**(삭제 금지, 보장 내용 유지).
- PTY는 quiet clamp 때문에 env로 50ms를 못 준다 → 테스트 전용 `QUANTA_GOAL_POLICY_JSON` 같은 override는 만들지 말고, PTY 하네스가 `--dev-goal-policy` 같은 hidden flag 없이 동작하도록 clamp를 `NODE_ENV==="test"`로 우회하는 것도 금지. 권장: clamp는 runtime-config에, PTY는 15초 대기 대신 **wake 스케줄 로그 라인**(`decision-counter` "goal-wake armed delay=…")을 assert.
