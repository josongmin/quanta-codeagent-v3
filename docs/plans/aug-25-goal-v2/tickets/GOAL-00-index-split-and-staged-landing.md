# GOAL-00 — 인덱스 분리 + staged goal slice 정직 랜딩

**Priority:** P0 (선행) · **Depends on:** 없음 · **크기:** ~15 tool-use, main-direct

## 목적
현재 index에 goal 캠페인과 cassette/security/remote-store 캠페인이 섞여 있고 promax 파일이 unstaged/untracked다.
이 위에 10개 티켓을 더 쌓으면 분리가 불가능해진다. staged goal 구현은 default-OFF이고 rail GREEN이므로
**있는 그대로, 단 catalog 문구만 정직하게** 먼저 랜딩해 index를 비운다.

## 작업명세
1. 단일 writer 확보: 작업 중 다른 세션은 main/index 쓰기 중단. `git rev-parse HEAD`가 `1624c7ce7`인지 확인.
2. 백업 후 index 비우기:
   ```sh
   git diff --cached --binary > /private/tmp/claude-501/quanta-pre-goal-index.patch
   git restore --staged .
   git status --short
   ```
3. goal 커밋에 **명시적으로** stage (경로 목록 = 이 티켓의 SSOT):
   - `src/agent/loop/entry.ts`, `src/agent/tier1/objective.ts`, `src/agent/tier1/objective-completion-admission.ts`
   - `src/apps/cli/goal-continuation-hook.ts`, `src/apps/cli/raw-line-reader/{machine,options}.ts`
   - `src/apps/cli/repl/{external-prompt-queue,goal-wake-signal,objective-progress,prompt-pipeline,prompt-types}.ts`
   - `src/apps/cli/repl/session-loop/{bootstrap,interactive-loop,interactive-setup}.ts`
   - `src/objective/{authority,continuation,index,model,ports,progress-receipt,pursuit-prompt}.ts`
   - `src/observability/metrics/decision-counter-sink.ts`
   - `src/runner/assemble/session-authorities/{build-objective,restore}.ts`
   - `src/session/{envelope,store,types}.ts`, `src/stream/types.ts`, `src/storage/service.ts`
   - `src/shared/runtime-config-knobs/knobs-b.ts`, `src/shared/runtime-config.ts`, `src/shared/runtime-config/types.ts`
   - `src/tool/objective/index.ts`, `package.json`(goal hunk만 — 확인)
   - tests: `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts`, `tests/unit/agent/{objective-completion-admission,loop-throw-dispose-hellgate}.test.ts`,
     `tests/unit/apps/cli/{goal-wake-hook,objective-progress,prompt-pipeline-hellgate,raw-line-reader-history,t06-external-prompt-queue-hellgate}.test.ts`,
     `tests/unit/{goal-continuation-engine-hellgate,goal-judge-config,goal-pursuit-prompt-hellgate,hooks-timeout-cap-hellgate,host-resource-sampler}.test.ts`,
     `tests/unit/cli/{inspect-cmd,why-cmd}-hellgate.test.ts`, `tests/unit/llm/role-model-override-hellgate.test.ts`,
     `tests/integration/debug-cli-surface-e2e-hellgate.test.ts`, **삭제** `tests/unit/goal-continuation-wiring-ratchet.test.ts`
   - catalog: `tools/feature-catalog/features/09-integration/objective-goal-continuation-live.yaml` + `docs/10.feature-catalog.md`의 goal 행 hunk만
   - 판단 필요(hunk 확인 후 귀속): `src/apps/eval/trajectory/redacted-export.ts`, `tests/unit/eval-trajectory-redacted-export.test.ts`,
     `src/shared/remote-store/**`, `src/llm/replay/**`, `src/apps/bench/**`, `docs/decisions/0551-*`, `tests/integration/bench-resume-e2e.test.ts`,
     `tools/feature-catalog/features/09-security/**` → **cassette 커밋**. promax 5+3 파일은 그 세션 owner에게 남김(건드리지 않음).
4. catalog yaml 문구 정직화 (구현이 아닌 문서 수정):
   - `QUANTA_GOAL_JUDGE` purpose에 "unavailable(timeout/error/circuit)은 **fail-open(admit)**; reject 모드도 동일" 명시(이미 있음, 유지).
   - "verifier 실행 경로 없음(C5 PARKED) — checked criteria는 현재 완료 불가" 추가.
   - `Modes: interactive` 로 축소(headless/ide 증거 없음). `UI: cli`.
   - `bun fc build`로 md 재생성 → goal 행만 diff에 남는지 확인.
5. PTY 순서의존 red 원인 격리(추측 금지):
   - `bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` 전체 실행 시 `goal continuation uses its own quiet window…`가
     `No matching recording (policy=exact)`로 실패, 단독 pass.
   - 실패 시점 screen 덤프 + `sessionsDir` 내용 + cassette 파일 내용을 `test.fail` 훅에서 stderr로 덤프해 원인 확정.
     후보: (a) 이전 테스트의 active goal이 sessionsDir에서 복원돼 잘못된 goal로 continuation, (b) cassette `exact` 매칭이 이전 test 요청 digest에 잠김.
   - 원인 확정 후 **최소 수정**(fixture 격리)만 이 티켓에서; 구조 수정은 GOAL-06.

## RED (이 티켓은 문서/인덱스 티켓이라 RED는 rail 자체)
- `git diff --cached --name-only`에 exclude 목록 경로가 하나라도 있으면 중단.
- `bun fc diff`가 goal 행 외 변경을 보고하면 중단.

## E2E
- `bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` **9/9** (순서의존 red 해소 포함). receipt(요약 줄) 커밋 메시지에 첨부.

## Proof rails
```sh
git diff --cached --check
bun run typecheck && bun run typecheck:tests
bun run lint && bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch
bun test tests/unit tests/integration   # full, 시간 걸림 — 동시 다른 bun test 금지(4.7h 함정)
bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
bun fc validate && bun fc build && bun fc diff && bun fc check-evidence
```

## Exit
- 커밋 2개: `feat(goal): …`(goal slice) / `feat(bench): …`(cassette slice, 그 owner가 원하면 별도). 커밋 후 `git status --short`에 promax 파일만 남는다.
- 커밋 메시지에 "judge fail-open / verifier 미구현 / CLI interactive only / default OFF" 명시.
