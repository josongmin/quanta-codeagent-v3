# R1 — Verifier fail-closed sandbox and persistent execution posture

**Status:** FOCUSED GREEN · MAIN INTEGRATION PENDING · **Priority:** P1 · **Owner:** host verifier/runtime sandbox

## 목적

checked criterion command가 기본-ON Goal 표면에서 무샌드박스로 실행될 수 있는 경로를 닫고,
나중에 receipt만 보고도 어떤 execution contract에서 검증됐는지 판별 가능하게 한다.

## 감사 당시 사실

- exact argv, scrubbed env, timeout/tree kill, before/after source digest는 구현돼 있다.
- `maybeWireObjectiveVerifier()`는 `createObjectiveCheckRunner()`를 무옵션으로 조립한다.
- `runArgv()`는 per-call/global sandbox가 모두 없어도 spawn한다.
- `VerificationInvalidationReason`에는 `sandbox-unavailable`이 있지만 `VerificationOutcome`에는 없다.
- runner throw는 현재 전부 `runner-unavailable`로 축약된다.
- completion receipt에는 source digest와 exit verdict만 있고 sandbox posture가 없다.

## 확정 결정

- verifier profile: `workspace-write`
- network: deny
- backend unavailable 또는 partial degrade: fail-closed, spawner 호출 0
- 기존 `defaultPerCallSandbox("workspace-write")` 재사용
- raw stdout/stderr는 계속 저장하지 않고 digest/length만 유지
- CPU/memory limit은 구현되지 않은 상태로 남기며 timeout 이상을 posture가 주장하지 않는다.

## 구조 작업

1. `runArgv`에 installed sandbox 상속 여부를 명시하는 옵션을 추가한다. 기본은 기존 동작
   `inherit`, verifier는 `skip`을 사용한다. verifier per-call wrapper와 CLI global wrapper를 이중
   적용하지 않는다.
2. `ObjectiveCheckRunnerOptions`의 raw wrap 중심 API를 `PerCallSandboxPort` 중심으로 올린다.
3. command 실행 전에 `availability()`를 확인한다. unsupported면 즉시 typed
   `sandbox-unavailable`을 반환한다.
4. wrap 결과의 `sandboxApplied/degradeReason`을 spawn 직전에 검증한다. network deny를 보장하지 못하는
   Linux backend도 unavailable로 처리한다.
5. `SandboxUnavailableError`와 일반 runner failure를 coordinator에서 분리한다.
6. `VerificationBatch`와 `VerifierCompletionReceipt`에 versioned posture를 추가하고 authority가 각
   checked receipt에 동일 posture를 기록한다.
7. session schema, build-objective, restore, migration을 함께 갱신한다. legacy receipt는 posture
   `unknown`으로 복원하며 새 검증 성공으로 재해석하지 않는다.

## 예상 write set

- `src/runtime/run-argv.ts`
- `src/host/runtime/objective-verifier-wire.ts`
- `src/objective/criteria/ports.ts`
- `src/objective/criteria/model.ts`
- `src/objective/authority.ts`
- `src/session/types.ts`, `src/session/store.ts`
- `src/runner/assemble/session-authorities/build-objective.ts`
- `src/runner/assemble/session-authorities/restore.ts`

## RED rails

1. sandbox backend 없음 → spawner 0, `sandbox-unavailable`.
2. wrapper가 `sandboxApplied:false` 또는 degrade reason 반환 → spawner 0.
3. strict verifier와 global CLI sandbox가 동시에 존재 → wrapper 중복 적용 0.
4. timeout, cancellation, non-zero exit, runner unavailable, sandbox unavailable이 서로 다른 outcome.
5. applied posture가 snapshot round-trip 후 byte-equivalent.
6. raw stdout/stderr가 batch/receipt/session JSON에 없음.
7. CLI와 web verify가 동일 coordinator/profile을 사용.

## DoD

- production `maybeWireObjectiveVerifier()`가 strict per-call port를 필수 조립한다.
- unavailable/degraded arm에서 process spawn이 불가능하다.
- current receipt만으로 contract version/profile/network/applied/runner version을 감사할 수 있다.
- focused unit + real-command E2E + persistence migration tests가 green이다.

## 중단 조건

- global mutable sandbox slot을 verifier 보안의 유일한 전제조건으로 삼는 경우.
- unavailable을 runner-unavailable 또는 failed check로 축약하는 경우.
- sandbox receipt를 별도 parallel store에 저장하려는 경우.

## 2026-08-31 구현 receipt

- verifier는 `defaultPerCallSandbox("workspace-write")`를 항상 조립하며 network-deny profile만
  strict posture로 인정한다.
- backend unavailable/degraded는 `sandbox-unavailable`으로 분리되고 spawn 전에 종료된다.
- verifier의 `runArgv` 호출은 installed CLI sandbox를 `skip`해 이중 wrapping을 막는다.
- receipt/session snapshot에는 contract version, profile, network, applied, runner version이 저장된다.
  posture가 없는 legacy receipt는 explicit v0 unknown으로 복원되며 completion을 만족하지 않는다.
- macOS live execution에서 확인된 Bun startup `sysctl-read hw.pagesize_compat`와 `/tmp` →
  `/private/tmp` workspace alias를 최소 Seatbelt rule로 보완했다. workspace 외 write 및 network deny는
  유지된다.
- `authority.ts`는 verification batch/hydration owner를 sibling module로 분리해 981 → 858줄,
  `session/store.ts`는 posture schema를 분리해 1004 → 989줄로 낮췄다.

동일 worktree source에서 실행한 rail:

```sh
bun run typecheck
bun run typecheck:tests
bun test <R1 affected 14 files>
bunx biome check <all modified TypeScript files>
git diff --check
```

결과: typecheck 2종 통과, focused **149 pass / 0 fail / 14 files**, god-code ratchet 통과,
Biome modified-file check 0 diagnostics, `git diff --check` 통과. full unit/integration/PTY 및 최종
promotion gate는 R6에서 동일 integration HEAD로 다시 실행한다.
