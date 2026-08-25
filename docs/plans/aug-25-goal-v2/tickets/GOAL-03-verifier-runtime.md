# GOAL-03 — verifier runtime: argv runner, source digest, batch commit

**Priority:** P0 · **Depends on:** GOAL-02 · **크기:** 40+ tool-use, main-direct

## 목적
checked criterion을 실제로 실행·검증하는 production 경로를 만든다(현재 `unsupportedCheckExecutionPort`, C5 PARKED).
passed는 실행기가 exit code로 계산하고, receipt는 verifier capability만 발급하며, 소스가 바뀌면 verified가 stale로 돌아간다.

## 작업명세
### 파일
- 신규 `src/objective/criteria/ports.ts` (objective slice — runtime/tool import 금지, `objective-slice-boundary.test.ts`가 잡음)
  ```ts
  export interface ObjectiveCheckRunner {
    run(input: { argv: readonly string[]; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<{
      exitCode: number | null; timedOut: boolean; stdoutDigest: string; stderrDigest: string; durationMs: number }>
  }
  export interface WorkspaceEvidencePort { capture(cwd: string): Promise<{ sourceDigest: string; capturedAt: number }> }
  export interface VerificationBatch {
    objectiveId: string; expectedRevision: number; sourceDigest: string
    results: readonly { criterionId: string; checkId: string; exitCode: number | null; timedOut: boolean; durationMs: number }[]
  }
  ```
- `src/runtime/shell.ts` — `runShell(command)`은 `["bash","-lc",cmd]`를 만든다. **문자열 join 금지.** 공통부(env scrub `resolveShellEnv`, sandbox slot wrap `getShellSandbox()`, perCallWrap, timeout/kill, 출력 accumulator)를
  `runArgv(argv: readonly string[], options)`로 추출하고 `runShell`은 `runArgv(["bash","-lc",command], …)`를 호출(byte-identical 유지 — 기존 shell 테스트가 paired control).
- 신규 `src/host/runtime/objective-verifier-wire.ts`
  - `createObjectiveCheckRunner({ workspaceCwd })`: `runArgv([...check.argv], { cwd: workspaceCwd, timeoutMs: min(check.timeoutMs, MAX_CHECK_TIMEOUT_MS=10min), inheritEnv: false })`.
    stdout/stderr 원문은 저장하지 않고 sha256 digest + byte 길이만. cwd는 입력에서 받지 않고 session workspace로 고정.
  - `createWorkspaceEvidence()`: git repo면 `git rev-parse HEAD` + `git ls-files -co --exclude-standard -z` + 각 path의 mode/symlink target/content sha256을 canonical manifest로 해시.
    비-git이면 `validation-contract-missing`과 동일 취급으로 verifier 거부(디렉터리 전체 해시는 하지 않음 — 크기 폭발).
  - `runVerification(authority, threadId)`: before digest → 모든 checked criteria 순차 실행 → after digest → 불일치면 `{kind:"stale-source"}` 반환(receipt 없음) → 일치면 `applyVerificationBatch` **단일 commit**(actor `verifier`).
- `src/objective/criteria/verifier.ts` — `createVerifierCompletion` export 제거(내부화). `unsupportedCheckExecutionPort` 삭제.
- `src/objective/core-store/completion-ops.ts` — `applyVerificationBatch` 핸들러: objectiveId·expectedRevision·criterionId/checkId 일치, `passed = check.successExitCodes.includes(exitCode) && !timedOut` 를 **authority가 재계산**(batch의 passed 필드 신뢰 안 함 — batch에 passed 필드 자체를 두지 않음), 모든 required checked criteria receipt가 같은 sourceDigest에 묶임.
- stale-on-change: `Objective`에 `verifiedSourceDigest?: string`; `readDomain`이 host가 주입한 `currentSourceDigest`와 다르면 파생 status에서 checked criteria를 `met:false(stale)`로 투영. 완료 직전(설정 `settleAttempt`/CLI `verify`)에 재비교.
- 조립: `src/runner/assemble/session-authorities/build-objective.ts`에 verifier wire 주입(`QUANTA_GOAL`/`OBJECTIVE_TOOLS` gate 하), web `runtime-factory.ts` 동일.
- 모델 검증 요청: `objective_update {kind:"requestVerification"}` op 추가 → tool은 argv를 받지 않고 host `runVerification(authority, threadId)`만 호출(결과는 tool result로 verified/failed/stale-source 요약). 정책표(GOAL-02)에 `requestVerification` 행 추가 — drift-guard가 강제. 같은 turn 내 2회 이상은 두 번째부터 `already-verified-this-attempt`.
- 모델 제안 check: `objective_set` criteria `check:{kind:"command", argv,…}`는 gateOn 승인 후 정의에 immutable 저장. 저장된 check만 verifier가 실행(모델 argv 즉시 실행 경로 없음).

### 규칙
- sandbox escalation 필요 시 기존 HITL(`sandbox-escalation-wire.ts`) 경로. verifier는 escalation을 자동 승인하지 않는다.
- stdout/stderr 원문은 objective snapshot·receipt·telemetry 어디에도 저장 금지(digest+길이).

## RED
신규 `tests/unit/objective/verification-batch.test.ts`, `tests/unit/host/objective-verifier-wire.test.ts`, `tests/unit/runtime/run-argv.test.ts`; 기존 `checked-completion-forgery-m8-hellgate.test.ts` 확장
1. exit 1(successExitCodes [0]) 결과를 담은 batch → criterion met:false; batch에 `passed:true`를 끼워 넣어도(타입 우회) 무시.
2. batch.objectiveId ≠ current → 거절, revision 불변.
3. expectedRevision 불일치 → `stale`.
4. before/after sourceDigest 불일치 → receipt 0, 반환 `stale-source`.
5. 검증 후 파일 1개 수정 → `readDomain` 파생에서 해당 criteria stale, status completed 아님.
6. actor=model/user의 `applyVerificationBatch` → deny(정책표).
7. `runArgv(["bash","-lc","x"])` 와 기존 `runShell("x")`의 spawn argv/env가 byte-identical(paired control).
8. argv에 공백/quote/`;` 포함 인자가 그대로 단일 argv 요소로 전달(join 안 함).
9. timeout → `timedOut:true`, passed false, 프로세스 kill 확인.
10. objective slice boundary: `criteria/ports.ts`가 `@/runtime`·`@/tool` import 시 arch RED.

## E2E
- `tests/integration/objective-verifier-real-command-e2e.test.ts`(신규, LLM 없음): 임시 git repo에 `/goal` + check `["bun","-e","process.exit(0)"]` → verify → completed;
  check `exit 1` → active; check `sleep 100` timeout → active; verify 도중 파일 수정 → stale-source.
- PTY: `/goal check add "tests pass" -- bun test tests/unit/objective/progress-receipt.test.ts` → `/goal verify` → `validation: 1/1 verified` → 파일 touch → `/goal`에 `stale` 표시.

## Proof rails
GOAL-02 rail + `bun test tests/unit/runtime tests/unit/objective-slice-boundary.test.ts tests/integration/objective-verifier-real-command-e2e.test.ts`.

## 함정
- `git ls-files` manifest는 대형 repo에서 수 초 — digest는 turn 경계에서 1회만, criterion마다 반복 금지.
- 컴파일 바이너리(`~/.local/bin/quanta`)에서 `git`이 PATH에 없을 수 있음 → `bun run install:cli` 후 PTY에서 확인.
