# L5 — CRITICAL / HIGH findings

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준, 라인은 audit 시점(2026-05-31, HEAD `57d78b8a`).

Legend — category: `silent-error`, `error-swallow`, `missing-feature`, `solid-violation`, `code-quality`, `wiring-bug`, `dead-code`, `race-cancellation`.

---

## 🔴 CRITICAL

### C-1 · `turn.cancel` reducer 핸들러가 완전 no-op — 취소 기능 전무
- **위치:** [src/kernel/session/reducer.ts:197-198](../../../../src/kernel/session/reducer.ts#L197) (+ 공개 API 부재: [src/sdk/runtime/types.ts:72-77](../../../../src/sdk/runtime/types.ts#L72))
- **카테고리:** dead-code / missing-feature · **상태:** [확인됨]
- **근거:** `TurnCancelCommand`는 protocol에 정의되고 reducer에 케이스도 있으나 본체가 `return { state, hostAction: { kind: "none" }, events: [] }` — **상태 변경 없음, host action 없음, 이벤트 없음**. 즉 실행 중인 host 턴을 중단시키는 부수효과가 0이다. 추가로 `RuntimeSession.turn`(types.ts:72)은 `run()`만 노출하고 `cancel()`이 없어 ergonomic API도 부재. `session.dispatch(turnCancelCommand)`로 명령을 보낼 수는 있으나 핸들러가 no-op이라 **어느 경로로도 턴 취소가 작동하지 않는다.**
  ```ts
  // reducer.ts:197
  case "turn.cancel":
    return { state, hostAction: { kind: "none" }, events: [] }
  ```
- **왜 문제:** 커널이 턴 취소를 "지원"하는 것처럼 보이지만(command 타입·reducer 케이스 존재) 실제 동작은 전무한 dead code. 횡단 취소 결함(H-2/H-6/H-9)의 머리 — 런어웨이 턴을 끊을 수단이 커널 레벨에 아예 없다.
- **수정:** (1) reducer 핸들러가 실제로 status를 전이하고 `hostAction`으로 진행 중 턴의 AbortController를 trigger하도록 보강. (2) `types.ts:72-77` turn 객체에 `cancel(meta?, options?)` 추가 → `session.ts`에 `buildTurnCancel` 구현 노출. (3) host runTurn 경로가 cancel hostAction을 받아 signal.abort()를 호출하도록 배선(H-9와 한 묶음).

---

## 🟠 HIGH

### H-1 · approval grant가 턴 경계 없이 생존 → 비-shell 도구 1회 무프롬프트 자동승인
- **위치:** [src/host/runtime/internal/context-binding.ts:632-668](../../../../src/host/runtime/internal/context-binding.ts#L632) (key 생성: [:613-621](../../../../src/host/runtime/internal/context-binding.ts#L613))
- **카테고리:** wiring-bug (security-adjacent) · **상태:** [확인됨 — 정정] (R2의 "무기한 재사용" framing은 부정확, 아래 참조)
- **근거:** `grants` Set은 `createRuntimeApprovalProtocolController` 스코프(634)에 살며 **턴 사이에 절대 clear 안 됨**. `resolveApproval`이 approve 시 `grants.add(actionKey)`(665), `onConfirm`이 매칭 시 `grants.delete(actionKey)`로 소비(638). `runWithProtocol`의 finally(657-658)는 confirm slot만 복원하고 grants는 안 건드림.
  - **정정 1 (single-use):** grant는 매칭 액션 1회에서 `grants.delete`로 소비된다. R2의 "무기한 재사용"은 과장 — 정확히는 **세션 끝까지 살아남아 최초 매칭 액션 1회를 무프롬프트 통과**시킨다(턴 N에서 승인 → 턴 N+k에서 첫 매칭 액션 자동승인).
  - **정정 2 (actionKey 입도):** shell은 `${tool}|${fullCommand}`(620)라 R2의 "bash:ls /tmp → ls /home" 예시는 **틀렸다**(전체 명령 포함 → 키가 다름). 진짜 이빨은 **비-shell 도구** — 키가 `action.tool`(도구 이름만)이라, `write_file`/`edit` 한 번 승인하면 임의 경로의 다음 동일 도구 호출이 무프롬프트로 1회 통과.
  - **부수:** 615-619의 `catch { shellCommand = null }` 때문에 `extractShellCommand`가 throw하면 shell 액션도 tool-name-only 키로 붕괴 → 의도보다 넓은 grant.
- **왜 문제:** 승인이 "액션 인스턴스"가 아니라 "도구 종류" 단위로 turn-cross 재사용된다. 사용자가 한 턴에서 파일 쓰기 1회를 승인하면 이후 턴의 무관한 파일 쓰기가 조용히 통과 — least-privilege 위반.
- **수정:** `runWithProtocol`을 `try { return await work() } finally { slot.current = previous; grants.clear() }`로 턴 스코프 제한. 또는 grant를 `approvalId`에 바인딩해 동일 인스턴스만 매칭. 추가로 615-619 catch에서 shell 추출 실패 시 fail-closed(승인 강제).

### H-2 · 5개 모드가 throwaway AbortController 생성 → SIGINT 무시
- **위치:** [headless.ts:67](../../../../src/apps/agent/mode-presets/headless.ts#L67), [batch.ts:80](../../../../src/apps/agent/mode-presets/batch.ts#L80), [daemon.ts:99](../../../../src/apps/agent/mode-presets/daemon.ts#L99), [ide.ts:101](../../../../src/apps/agent/mode-presets/ide.ts#L101), [ci-bot.ts:298](../../../../src/apps/agent/mode-presets/ci-bot.ts#L298) (근본: [index.ts:576](../../../../src/apps/agent/index.ts#L576))
- **카테고리:** race-cancellation · **상태:** [확인됨]
- **근거:** 5개 프리셋 전부 `signal: req.base.signal ?? new AbortController().signal`. 컴포지션 루트(index.ts:576)도 `signal: new AbortController().signal`로 base를 채운다 — 둘 다 **controller를 즉시 버려 `signal.aborted`가 영원히 false**. interactive.ts만 자체 controller(63)를 만들고 SIGINT를 배선(`process.on("SIGINT", onSigint)`, 103)한 뒤 그 signal을 base에 넣는다(64). 나머지 모드는 dead signal을 상속.
- **왜 문제:** 6개 모드 중 5개에서 Ctrl+C가 조용히 무시됨. 운영자는 `kill -9`를 쓰거나 자연 종료를 기다려야 함. C-1(커널 취소 부재)과 합쳐 "런어웨이 턴 중단 불가"의 표면 절반.
- **수정:** 프리셋이 throwaway controller를 만들지 말 것. 컴포지션 루트가 SIGINT를 최상위에서 한 번만 배선하고 live controller의 signal을 base에 주입(index.ts:576의 dead signal 제거). interactive.ts:121의 fallback throwaway도 동일 정리.

### H-3 · SDK bridge error 핸들러 미배선 + dispatch rejection 무음
- **위치:** [src/sdk/runtime/session.ts:47-56](../../../../src/sdk/runtime/session.ts#L47) (+ bridge 측: `src/sdk/runtime/bridge.ts:279-284`)
- **카테고리:** error-swallow / wiring-bug · **상태:** [확인됨(session.ts 측) + 검증됨(bridge.ts 측)]
- **근거:** `ensureTransportBridge`가 `createSessionTransportBridge`를 `snapshot`/`tailLimit`/`onCommand`만으로 호출 — `onBridgeError`/`onCommandRejected` 콜백 미제공(확인됨). bridge.ts:283의 `reportBridgeError`가 `opts.onBridgeError?.()`를 부르지만 undefined라 transport 에러가 로그·피어 알림 없이 소실(검증됨). 또한 `onCommand` 본체(51-54)는 `transportDispatchQueue = transportDispatchQueue.then(async () => { await dispatch(command) })` — dispatch가 reject하면 그 rejected promise가 큐가 되고, `await transportDispatchQueue`(54)가 onCommand로 throw하나 외부 핸들러 없음.
- **왜 문제:** transport가 실패하거나 잘못된 명령을 받으면 흔적 없이 사라짐 — 디버깅 불가, 클라이언트는 거부 통지 못 받음.
- **수정:** `createSessionTransportBridge`에 `onBridgeError`/`onCommandRejected` 콜백 배선(최소 `logger.error`/`logger.warn`). onCommand 큐 체인을 try-catch로 감싸 dispatch 실패를 로깅하고 큐가 rejected 상태로 오염되지 않게 격리(`.catch`로 시퀀싱 가드).

### H-4 · invalid `QUANTA_VECTOR_STORE`가 warn 한 줄 후 무음 비활성화 (fail-silent)
- **위치:** [src/runner/assemble/search-index-backend.ts:686-690](../../../../src/runner/assemble/search-index-backend.ts#L686) (disabled backend: [:655-669](../../../../src/runner/assemble/search-index-backend.ts#L655))
- **카테고리:** silent-error · **상태:** [확인됨]
- **근거:** `selection.kind === "invalid-explicit"`일 때 init에서 `logger.warn` 한 번 후 `newDisabledBackend()` 반환. 이 백엔드는 `query → []`, `upsert/delete → no-op`(주석 663-664: "explicit store request is disabled; do not silently index elsewhere"). 다른 store로 폴백하지 않는 의도 자체는 방어적이나, 오타(`QUANTA_VECTOR_STORE=lannce`)면 indexer가 upsert를 에러 없이 호출 → **청크가 조용히 버려지고 이후 query는 빈 결과**. init warn 한 줄 외엔 신호 없음.
- **왜 문제:** 운영자는 시맨틱 검색이 무음으로 깨진 걸 모름. 오타 한 글자가 검색 전체를 silent하게 무력화.
- **수정:** (1) 명시 store가 invalid면 init에서 throw(fail-loud) — 오타는 빠르게 터지는 게 맞음. 또는 (2) `SemanticBackend`에 `disabled`/`error` 플래그를 노출해 소비자(indexer)가 깨진 백엔드를 감지·표면화.

### H-5 · verdict 경로에서 pythonSwebench까지 AbortSignal 미전파
- **위치:** [src/runner/batch/eval/driver.ts:1235](../../../../src/runner/batch/eval/driver.ts#L1235) (signal 생성: [:1169](../../../../src/runner/batch/eval/driver.ts#L1169)) + [verdict.ts:37-43](../../../../src/runner/batch/eval/verdict.ts#L37) + [python-swebench.ts:84-102](../../../../src/apps/bench/python-swebench.ts#L84)
- **카테고리:** wiring-bug / race-cancellation · **상태:** [검증됨]
- **근거:** `const v = await verify(instance, phase.patch, sandbox, deps)`(1235)가 deadline `timeoutMs`로 만든 `abort.signal`(1169)을 안 넘김. `verify()`는 signal 파라미터 자체가 없고 `PySwebenchOpts`(python-swebench.ts:84-102)에도 `signal?: AbortSignal` 필드 부재 → `evaluateWithPythonSwebench`가 취소 신호를 받을 통로가 없음. 특히 python-swebench.ts:305의 5초 transient-crash 재시도 sleep이 abort 후에도 블록.
- **왜 문제:** 인스턴스 deadline이 떠도 이미 실행 중인 Python 하니스 평가를 중단 못 함 → 다음 인스턴스로 시간초과 cascade, 벤치 전체 deadline 보장이 무너짐.
- **수정:** `VerifyDeps`(verdict.ts:37-43)에 `signal?: AbortSignal` 추가, driver.ts:1235에서 `{ ...deps, signal: abort.signal }` 전달, `PySwebenchOpts`까지 forward해 spawn·재시도 sleep에서 `Promise.race([sleep, abortPromise])`로 취소 반응.

### H-6 · bench/eval/driver `logger` import 누락 → cleanup·repro-hint 실패 무음
- **위치:** [src/apps/bench/eval/driver.ts:1-60](../../../../src/apps/bench/eval/driver.ts#L1) (삼킴 지점: :192-193, :206-211)
- **카테고리:** error-swallow · **상태:** [검증됨]
- **근거:** `errMessage`만 import하고 `logger` 미import. 192-193의 `session/runtime.close().catch(() => undefined)`와 206-211의 빈 catch(Bun.write repro-hint 설치 실패)가 전부 무음. 자매 파일 `src/runner/batch/eval/driver.ts`는 logger를 import해 가시성 확보 — **동일 역할 두 드라이버 간 비대칭**.
- **왜 문제:** 세션/런타임 close 실패(자원 누수)와 repro-hint 설치 실패가 진단 없이 사라짐.
- **수정:** `import { logger, errMessage } from '@/shared'` 후 각 catch에 `logger.warn(...)` 추가. 자매 드라이버와 패턴 통일.

### H-7 · CLI 세션 초기화 중간 실패 시 runtimeFacade·playbook watcher 누수
- **위치:** [src/apps/cli/repl/session-loop.ts:256-280](../../../../src/apps/cli/repl/session-loop.ts#L256) (createSession: :214, close: :377/:495, detach: :382/:498)
- **카테고리:** race-cancellation / wiring-bug · **상태:** [검증됨]
- **근거:** `attachPlaybookHandle()`(280)로 file watcher를 시작한 뒤 후속 초기화(282-380+)가 throw하면 `playbookSeam?.detach()`(382/498) 분기에 도달 못 해 unreachable. 또한 `createSession()`(214)이 throw하면 one-shot(339)·interactive(489)의 finally 이전에 예외가 빠져나가 `runtimeFacade.close()`(377/495) 미도달.
- **왜 문제:** 비정상 종료 시 백그라운드 file watcher와 runtimeFacade가 세션보다 오래 생존 → 누수.
- **수정:** 세션 초기화 전체(약 177-388)를 `try/finally`로 감싸 `playbookSeam?.detach()`와 `runtimeFacade.close()`를 항상 보장.

### H-8 · 커널 dispatch가 AbortSignal을 받지만 `signal.aborted`를 어디서도 검사 안 함
- **위치:** [src/kernel/session/scheduler.ts:492](../../../../src/kernel/session/scheduler.ts#L492) (+ optional 선언: [ports.ts:170](../../../../src/kernel/session/ports.ts#L170))
- **카테고리:** race-cancellation · **상태:** [검증됨]
- **근거:** scheduler가 signal을 `ctx.host.runTurn`에 조건부 forward할 뿐, dispatch 레벨에서 `signal.aborted` 체크가 전무. signal이 `KernelDispatchContext`에서 optional이라 일부 호출은 안 넘기기도 함 → 취소가 일급 관심사처럼 보이지만 실제로는 host 위임에만 의존. C-1과 합쳐 커널이 취소를 거의 처리하지 않음.
- **수정:** (1) dispatch 임계 연산 전 `if (signal?.aborted) return abortedResult` 가드 추가, 또는 (2) signal을 필수로 만들고 C-1의 cancel hostAction과 연결. 최소한 "host-only 취소"임을 계약에 명시.

---

> 위 8개 HIGH 중 H-1~H-4는 Claude 본인 소스 재확인 완료(확인됨), H-5~H-8은 adversarial verifier 통과(검증됨)이며 수정 착수 전 라인 재확인 권장. R1/R2가 보고했으나 재확인에서 강등/기각된 항목은 [03-false-positives.md](03-false-positives.md) 참조.
