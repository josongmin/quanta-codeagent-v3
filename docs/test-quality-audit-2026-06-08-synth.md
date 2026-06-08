I have all the findings I need. Let me synthesize the report directly.

# 테스트 품질 어딧 보고서

## 요약

확인된 불량 테스트 **80건** (소스 파일 1건 + 테스트 파일 다수). 전부 적대적 검증으로 confirmed_bad이며 false-positive는 제외됨.

**클래스별 집계**

| 클래스 | 건수 |
|---|---|
| LOC_STRUCTURE_BUDGET (소스 텍스트 grep을 행위 대신 검사) | 41 |
| TAUTOLOGICAL (방금 쓴 리터럴을 자기 자신에 단언) | 16 |
| DUPLICATE (다른 파일/테스트가 동일 계약을 이미 커버) | 8 |
| NON_EXECUTING (프로덕션 코드 경로 미실행) | 8 |
| REIMPLEMENTED (테스트가 SUT의 사본을 단언) | 7 |
| FLAKY (월클록 타이밍 게이트) | 7 |
| NO_ASSERTION / NO_SIGNAL | 3 |
| TESTING_FRAMEWORK (JS/런타임 내장만 검사) | 2 |
| OTHER (stale 주석/거짓 문서) | 1 |

(일부 finding은 단일 LOC가 두 클래스를 겸함 — 위 표는 1차 클래스 기준이라 합계가 finding 수와 정확히 일치하지 않음.)

**가장 먼저 고칠 3가지 (HIGH/위험순)**

1. **`tests/unit/apps/cli/slash-registry-split-hellgate.test.ts:128` [CHEATING_CIRCULAR/HIGH] — 현재 RED로 커밋됨.** 하드코딩된 `EXPECTED_NAMES` 세트가 프로덕션과 드리프트(신규 `/capabilities`, `/caps` 누락) → 스위트가 빨강. 즉시 두 이름을 추가해 그린 복구하고, 세트를 3개 레이어 배열에서 파생하도록 바꿔 재발 방지.
2. **`tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts:16` [LOC_STRUCTURE_BUDGET/HIGH]** — CLI 런타임이 `@/sdk/runtime`를 거치는 단 하나의 의미 있는 계약이 순수 import-fence grep으로만 지켜짐(이미 biome 룰로 강제됨). `composeCliRuntimeContext`를 실제 호출하는 행위 테스트로 교체하고 fence는 biome lint에 일임.
3. **`tests/integration/session-stress-and-concurrent.test.ts:188 / :705` + `tests/integration/eval-five-tier-compare-e2e.test.ts:249 / :282` [REIMPLEMENTED/MED, 위험]** — worktree 락-재시도와 cursor/aider argv 플래그 "회귀 가드"가 SUT가 아니라 **테스트 내 사본**을 단언. `--force`를 실제 `cursor.ts`에서 지우거나 worktree 재시도가 회귀해도 그린으로 통과 → 광고하는 회귀 보호가 존재하지 않음(더 나아가 worktree 하네스의 serial-retry는 실패를 적극적으로 가림).

---

## HIGH

### LOC_STRUCTURE_BUDGET

- **`tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts:16`** — repl.ts/runtime-context-compose.ts/session-setup.ts를 텍스트로 읽어 import 부분문자열만 단언; CLI repl 행위 미실행. → `composeCliRuntimeContext`를 fake `SessionBootstrapResult`/`StreamPort`로 호출해 반환 바인딩이 정상인지 단언하고, 아키텍처 fence는 이미 존재하는 biome 룰에 일임. (다른 두 파일과 삼중 중복이므로 잔여 고유 검사만 import-fence 테스트로 병합.)

### CHEATING_CIRCULAR

- **`tests/unit/apps/cli/slash-registry-split-hellgate.test.ts:128`** — 하드코딩 `EXPECTED_NAMES`가 프로덕션과 드리프트해 현재 테스트가 **실패(13 pass/1 fail)**; 누구도 신규 `/capabilities`,`/caps` 등록 시 갱신 안 함. → `EXPECTED_NAMES`에 두 이름 추가해 그린 복구; 이후 3개 레이어 배열 + 소량 allow-list에서 기대 세트를 파생해 매번 손으로 다시 타이핑하는 패턴 폐기.

---

## MED

### LOC_STRUCTURE_BUDGET — 소스 텍스트 grep을 행위 대신 검사 (프로덕션 코드 미실행, 리네임/리포맷에 깨짐)

- **`tests/unit/mode-cycle-permission-authority-hellgate.test.ts:61`** — bootstrap-session.ts를 문자열로 읽어 `createPermissionModeSessionState(...)` 등 토큰 단언. → `bootstrapSession(fakeDeps, runtime, {})` 호출 후 `result.permission.mode === runtime.mode`, `.set('acceptEdits')` 반영을 단언(기존 fake-deps 하네스 재사용).
- **`tests/unit/mode-cycle-permission-authority-hellgate.test.ts:71`** — context-binding.ts/context.ts 소스 토큰 단언. → `composeRuntimeBootstrapContext`/`createRuntimeFromBootstrap`로 바인딩 만들어 `runtimeContext.permissionModeState()`가 같은 cell 인스턴스를 반환하고 `.set()`이 snapshot으로 관측되는지 단언.
- **`tests/unit/mode-cycle-permission-authority-hellgate.test.ts:82`** — session-loop.ts에서 `beforeTurn` 등 3개 부분문자열 grep. 이 leg는 e2e가 유일하게 커버 안 하는데 grep으로만 지켜짐. → beforeTurn sync를 테스트 가능한 작은 단위로 추출, fake `ux.modeCycle`로 한 턴 구동해 엔진 cell 값이 cycle의 permissionMode와 같아지는지 단언.
- **`tests/unit/stream-timeout.test.ts:333`** — openai.ts에 `withStreamTimeout`/`provider:"openai"` 토큰 존재만 검사. → openai-adapter.test.ts에서 never-yield FakeOpenAI + 작은 `streamFirstChunkMs`로 `.stream()` 구동해 `LLMError{kind:'stream_corrupt',provider:'openai'}` throw 단언 후 grep 삭제.
- **`tests/unit/stream-timeout.test.ts:339`** — anthropic.ts에 동일 토큰 grep. → anthropic adapter 테스트에서 never-yield create로 hung-stream 행위 단언, grep 삭제.
- **`tests/unit/stream-timeout.test.ts:345`** — `input.signal ? {signal} : undefined` 등 **정확한 삼항 포맷**을 pin. → FakeOpenAI가 `create`의 2번째 인자를 캡처하게 해 `{signal}` 전달과 abort 시 teardown을 단언, grep 삭제.
- **`tests/unit/stream-timeout.test.ts:351`** — anthropic.ts에 동일 포맷-pin(우연히만 매치). → 주입 fake create의 2번째 인자 캡처로 signal 포워딩/teardown 단언, grep 삭제.
- **`tests/unit/mode-cycle-permission-authority-hellgate.test.ts`** (위 3건 포함).
- **`tests/unit/wire-batch-mode-focus-fork-otel-hellgate.test.ts:116`** — loop 소스에서 `cfg.focusChain`/`tracker.tickTurn()`/`getInjection()` 부분문자열 grep. → `injectFocusChainMessage` + `defaultFocusChainTracker({reinjectEveryN:1})`로 한 턴 경계 뒤 user Message append를 단언, N 미경과 시 no-append, default-OFF 시 no-append.
- **`tests/unit/agent/closeout-critic-hellgate.test.ts:193`** — closeout-critic.ts에 `try {`/`catch`/`critic:unavailable` 존재 검사. no-throw 계약은 같은 파일 139-157이 이미 행위로 증명. → 삭제.
- **`tests/unit/code-mode-default-off-hellgate.test.ts`** 계열은 LOW(아래) — 여기 아님.
- **`tests/unit/apps/agent/async-tools-deferred-wire-hellgate.test.ts:92`** — agent-arg-builder.ts에서 `asyncTools` 등 grep(주석에서도 매치되어 실행 게이트 삭제해도 통과). → 테스트 가능 seam을 export해 `QUANTA_ASYNC_TOOLS` on 시 tool 셋에 `poll_deferred` 포함/off 시 부재를 단언.
- **`tests/unit/apps/agent/async-tools-deferred-wire-hellgate.test.ts:102`** — internal.ts grep(`buildTooling`은 export됨에도 텍스트 검사). → `buildTooling(...)`을 env on/off로 호출해 `poll_deferred` 존재/부재 단언.
- **`tests/unit/apps/agent/async-tools-deferred-wire-hellgate.test.ts:109`** — `if (!cfg.asyncTools) return []` **정확 철자** pin(가장 취약). → root builder를 off/on으로 호출해 tool 리스트로 default-OFF 행위 단언.
- **`tests/unit/host/runtime-surface-hellgate.test.ts:17`** — 6개 파일 readFileSync; 그중 9개 단언은 **빈 re-export barrel**(session-host.ts)을 grep해 vacuously 참. → 소스 grep 삭제, 부재 계약은 test 1의 `'X' in runtime` import 체크로 확장.
- **`tests/unit/host/runtime-surface-hellgate.test.ts:43`** — types.ts/runtime.ts에서 `expectedCapabilities?` 등 토큰 grep. 실제 `assertCapabilityExpectation`/`createRuntimeFacade`는 런타임 검증 가능. → 모순되는 manifest로 host stub 만들어 `createSession()`이 capability_mismatch throw, 잉여 `capabilities` 무시를 단언.
- **`tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts:120`** — repl.ts import 라인 텍스트 grep. → `runSessionMain()`을 argv stub으로 구동해 runner 실행을 stdout/exit로 단언.
- **`tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts:127`** — 콜사이트 부분문자열 grep. → 단일 `runSessionMain()` 호출 테스트로 `args.slice(3)` 전달을 관측.
- **`tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts:132`** — import 라인 grep. → `session import <provider>`를 wired handler로 구동해 출력 단언.
- **`tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts:137`** — `resolveCliSessionListEnv` import grep. → `session ls`가 resolved 기본 포맷 따르는지 `runSessionMain()`으로 단언.
- **`tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts:142`** — 제목은 "deps에 wire"라 주장하나 본문은 import grep만(가장 호도적). → `runSessionMain()` 호출로 importHandler/listEnv 기본값 반영을 행위로 단언.
- **`tests/unit/apps/cli/slash-registry-split-hellgate.test.ts:104`** — registry-surface.ts에서 `from "@/agent"` 류 grep; 동일 fence가 biome:1712에 권위적으로 존재. → 삭제하고 biome 룰 의존(type-import/모든 서브패스까지 잡음).
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:82`** — 각 factory 파일에서 `export const X` 개수=1 grep. → 삭제(test 6/15의 런타임 호출이 이미 커버).
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:89`** — repl.ts에서 `const X = (`/`function X` 부재 regex. → 삭제(test 5/13이 커버).
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:142`** — factory 파일에 `CliFeatureConfig` 토큰 존재 grep. → 삭제, typecheck + test 15 의존.
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:215`** — `replSrc.split(helper).length-1 <= 3` 언급-횟수 예산(파일 헤더가 폐기했다고 밝힌 바로 그 패턴). → 삭제.
- **`tests/unit/apps/cli/runrepl-shape-hellgate.test.ts:38`** — runRepl 본문에서 `let`/inline-closure 토큰 금지(코딩 스타일 강제). → `setupSession`/`runSessionLoop` stub으로 runRepl 호출 행위 테스트로 교체, grep 삭제.
- **`tests/unit/apps/cli/runrepl-shape-hellgate.test.ts:33`** — 파일 전체가 repl.ts 텍스트 grep; runRepl 미실행. → module mock으로 runRepl 구동해 setupSession→runSessionLoop 순서/finally teardown 순서를 단언.
- **`tests/unit/cli/repl-extract-shape.test.ts:59`** — index.ts에서 `runRepl()` 존재 + `quanta›` 부재(잘못된 근거: 해당 리터럴은 turn-indicator.ts에 있음). → 삭제; 위임은 통합 테스트가 커버. 최소한 거짓 주석 수정.
- **`tests/unit/cli/repl-extract-shape.test.ts:71`** — slash-commands.ts/repl.ts/session-setup.ts에서 `from "./X"` import 리터럴 6개 grep. → 삭제(typeof-export smoke + 통합 테스트가 wiring 커버).
- **`tests/unit/host/bootstrap-host-extraction-hellgate.test.ts:312`** — types.ts에서 `export type BuildLlmFactory` 등 grep; 순수 compile-time 사실은 `SessionBootstrapDeps`가 이미 강제. → 삭제(필요시 `Function` 비할당 conditional-type 단언으로).
- **`tests/integration/decision-emit-wire-e2e-hellgate.test.ts:124`** — dispatch.ts에서 `emitCapReminderDecision(...)` import/콜 리터럴 grep; private `handleCapReminder`를 잇는 유일 seam. → `handleCapReminder`를 export해 실제 `decisionEmitter` collector로 구동, 정확히 1개 `kind:'cap'` deny row 단언.
- **`tests/integration/decision-emit-wire-e2e-hellgate.test.ts:137`** — turn-outcome.ts에서 `checkExhausted()`/`emitBudgetExhaustedDecision(...)` 리터럴 grep. → exported `resolveTurnLoopOutcome`를 exhausted budgetMeter + collector로 호출해 `{kind:'finish',reason:'budget_exhausted'}` + 1개 `kind:'budget'` row 단언.
- **`tests/integration/decision-emit-wire-e2e-hellgate.test.ts:231`** — session-setup.ts 텍스트 grep(install이 런타임 가드 `decisionEmitter !== undefined` 뒤에 있어 grep은 가드를 못 봄). → 3줄 sink-lifecycle을 `installFsJailSinkFromContext` 헬퍼로 추출해 collector로 install/clear 행위 단언.

### TAUTOLOGICAL — 방금 쓴 리터럴/직접 호출한 spy를 자기 자신에 단언

- **`tests/unit/cross-slice-mirrors.test.ts:39`** — `AssertEqual<PermissionHITLTier, ToolHITLTier>`가 둘 다 동일 `@/shared` SSOT라 **컴파일 타임에서도** 항상 참; 드리프트 보호를 거짓 광고. → `_assertHITLMirror` 삭제(독스트링의 `"sandbox-required"` 예시는 HITLTier에 불가능; 예가 필요하면 진짜 독립 쌍인 BlockerSurface 사용).
- **`tests/unit/doctor-selfcheck-hellgate.test.ts:194`** — `const writes = 0` → `expect(writes).toBe(0)` = `expect(0).toBe(0)`; runDoctor는 실행되나 단언과 분리됨. → 각 probe가 실제 `let` 카운터를 증가시키게 주입해 정확히 1회 호출됐는지(추가 호출 없음) 단언, 또는 삭제(read-only는 DoctorProbes 타입 불변식).
- **`tests/unit/knob-default-off-completeness-guard.test.ts:409`** — `evaluate`는 `classifyKnob`(7 branch)의 STRICT SUBSET(3 branch) 손사본; red-on-injection이 사본을 구동. → `evaluate` 삭제, 5개 injection 테스트를 `classifyKnob` 직접 호출로 재작성해 dead-read/stale-allowlist/field-mismatch 3개 누락 branch까지 커버.
- **`tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts:46`** — `.withAdmissibility(`/`.wrapRegistry(` 등 **존재하지 않는 API**의 부재 단언(항상 그린). → immutability를 `composeCliRuntimeContext` 호출로 증명하거나 dead API면 삭제.
- **`tests/unit/sdk/public-runtime-surface-hellgate.test.ts:9`** — `"RuntimeSessionInternal" in sdk` 등은 **interface(런타임 erase)** 라 항상 false; barrel이 그 타입을 re-export해도 통과. → 실제 RuntimeSession 인스턴스를 만들어 `__unsafePeekExecutionView`/`__unsafeReplaceMessages` 메서드 부재(value-level)를 단언.
- **`tests/unit/apps/cli/session-setup-hellgate.test.ts:135`** — `SessionSetupResult` 실제 44키인데 38키 리터럴을 `toHaveLength(38)`로 자기검사; 누락 6키 invisible(주석이 호도적). → `satisfies Record<keyof SessionSetupResult,1>`로 exhaustive compile-time lock 교체, 런타임 count/주석 삭제.
- **`tests/unit/apps/cli/session-loop-hellgate.test.ts:750`** — `RunSessionLoopDeps` 22필드인데 7키 subset을 `toHaveLength(7)`로 단언; add/drop 못 잡음(드리프트 탐지 주장 과장). → `Record<keyof RunSessionLoopDeps,true> satisfies ...`로 exhaustive lock 교체.
- **`tests/unit/retrieval-rerank-registry.test.ts:120`** — `[0,1] alpha-clamp` 검증을 표방하나 유일 단언이 `expect(true).toBe(true)`; rerank 출력 폐기되어 clamp 삭제해도 통과. → clamp가 관측 가능한 순서를 바꾸는 코퍼스로 `alpha=-5`가 `alpha=0`처럼, `alpha=99`가 `alpha=1`처럼 랭크하는지 단언.

### DUPLICATE / NON_EXECUTING / REIMPLEMENTED (MED)

- **`tests/unit/cli/runtime-sdk-cutover-hellgate.test.ts:21` [DUPLICATE/MED]** — cli-sdk-parity.test.ts와 repl-thin-surface-ownership-hellgate.test.ts가 동일 import 계약 + biome 룰까지 중복. → 하나의 canonical CLI import-fence로 병합(또는 biome로 일임), biome 미커버분만 유지.
- **`tests/unit/apps/cli/cli-sdk-parity.test.ts:9` [LOC_STRUCTURE_BUDGET/MED]** — runtime-context-compose.ts/session-setup.ts import 부분문자열만; parity 행위 0. runtime-sdk-cutover/repl-thin-surface와 verbatim 중복 + biome로 강제. → 삭제(또는 `composeRuntimeBootstrapContext` 실호출 parity 테스트로 재작성).
- **`tests/unit/apps/cli/cli-sdk-parity.test.ts:25` [DUPLICATE/MED]** — session-loop.ts에서 src에 존재하지 않는 심볼 부재 grep; runtime-sdk-cutover:42-57의 strict subset. → 삭제.
- **`tests/unit/repair-validator.test.ts:143` [NON_EXECUTING/MED]** — SUT는 `@/runner/batch/.../validator`를 import하나 구조 가드는 **다른 경로** `src/runner/batch/...`를 하드코딩; 구현 이전 시 stale src를 스캔해 false-green. → import된 `validate`의 resolved 경로에서 ROOT 파생, shim/impl 두 디렉터리 모두 스캔하고 shim이 순수 `export *` re-export인지 단언.
- **`tests/unit/runtime/exec-cluster-spawn-env-scrub-ban-hellgate.test.ts:60` [NON_EXECUTING/MED]** — `buildPtyEnv`(분기 많은 env-policy)가 tests 전체에서 문자열 토큰으로만 등장, 호출/단언 0 → PTY 자격증명 누출 경로 런타임 증명 없음. → `buildPtyEnv`에 행위 단위 테스트 4개(API_KEY 드롭/allowlist 보존/declared overlay 필터/inheritEnv escape-hatch) 추가.
- **`tests/integration/eval-five-tier-compare-e2e.test.ts:249` [REIMPLEMENTED/MED]** — cursor 플래그 "회귀 가드"가 프로덕션 `buildCursorAdapter()` 대신 인라인 사본의 `--force`를 단언; 실제 cursor.ts에서 `--force` 삭제해도 통과. → 프로덕션 adapter argv를 노출/구동해 실제 argv에 -p/--output-format/text/--force 단언.
- **`tests/integration/eval-five-tier-compare-e2e.test.ts:282` [REIMPLEMENTED/MED]** — aider 동일 결함(`--yes-always`/`--no-git` 사본 단언). → `buildAiderAdapter()` 실제 argv로 단언.
- **`tests/integration/session-stress-and-concurrent.test.ts:188` [REIMPLEMENTED/MED]** — "no lock-retry" 주석이 stale(프로덕션은 `runWorktreeAddWithRetry` 사용); 테스트가 분류기/serial-retry를 발산 사본으로 재구현, happy-path에서 dead이고 실제 회귀를 가림. → 5개 parallel fork를 직접 발사해 모두 exitCode===0 + 5개 distinct id/path를 단언, serial-retry 제거.
- **`tests/integration/session-stress-and-concurrent.test.ts:705` [REIMPLEMENTED/MED]** — 분류기가 **잘못된 버퍼**(`.out`, 실패 시 빈 값)를 읽음; 실제 락 회귀 시 오히려 오도 메시지로 FAIL. → 가드 유지 시 `captured[i].err`를 읽되, 권장은 가드 제거 + all-5 success 직접 단언.
- **`tests/integration/decision-emit-wire-e2e-hellgate.test.ts:124/137`** (위 LOC 항목).
- **`tests/integration/resume-e2e.test.ts:717` [REIMPLEMENTED/MED]** — `isPathLikeToken`을 하네스 로컬 사본에서 import(fence가 강제하지 않음에도); 미래 분기 시 사본을 pin해 false confidence. → `import { isPathLikeToken } from "@/runner/orchestrate"`로 변경하고 dead 사본 삭제.

### TESTING_FRAMEWORK (MED)

- **`tests/unit/silent-catch-24h-ratchet.test.ts:168`** — 테스트 작성자가 쓴 `BARE_CATCH_RE`가 같은 작성자가 쓴 문자열 리터럴에 매치/비매치하는지만 검사(자기참조). → 삭제; regex 의도는 인라인 주석으로 강등.

---

## LOW

### LOC_STRUCTURE_BUDGET (LOW)

- **`tests/unit/code-mod-closeout.test.ts:75`** — 모듈 자신의 상수 `CODE_MOD_CLOSEOUT_REMINDER`에 단어 존재 grep(sibling이 vapor로 삭제한 패턴). → 삭제, tombstone 주석만 남김(routing-by-identity + sota-codex-full e2e가 커버).
- **`tests/unit/code-mod-closeout.test.ts:87`** — 같은 상수에 `/all four/i` 부분문자열 grep. → 삭제(line 75와 머지).
- **`tests/unit/memory-fence-stays-clean-hellgate.test.ts:70`** — telemetry-port.ts에서 6개 export 심볼명 부분문자열 grep. → 삭제; companion memory-telemetry-port-hellgate.test.ts가 live 값 import로 커버. 유지 시 live 심볼 import + 동결/allow-list 행위 단언.
- **`tests/unit/nicknames.test.ts:94`** — nicknames.ts 소스에서 `Math.random` 부재 grep(주석/Math.imul 언급에 양방향 취약, 행위 테스트가 이미 결정성 커버). → describe 블록 + 미사용 import 삭제.
- **`tests/unit/silent-catch-24h-ratchet.test.ts:138`** — `} catch {` 매직 카운트를 baseline과 STRICT-EQUAL 비교(정당한 refactor도 빨강). → per-site 행위 테스트로 이전; ratchet 유지 시 `observed <= baseline`으로 완화하거나 baseline 자동파생.
- **`tests/unit/silent-catch-24h-ratchet.test.ts:122`** — 11개 label `<label>:` 존재 grep; approval-state는 hellgate가 행위로 커버(중복), 나머지 ~9개는 grep만(false confidence). → approval-state label 제거, 나머지는 per-site 행위 테스트 추가.
- **`tests/unit/verify-signal.test.ts:107`** — `importLines.toHaveLength(0)`만; `Date.now()`/`Math.random()`/`fetch()` 등 전역은 import 없이 추가 가능(주장한 purity 미강제). → closeout-guard.test.ts purity 블록 미러: allowlist import-scan + 직접 hazard regex(`Bun.spawn`/`new Date`/`Date.now`/`Math.random`/`fetch`/dynamic import) 추가.
- **`tests/unit/agent/closeout-critic-hellgate.test.ts:88`** — recovery-executor.ts에서 시그니처 regex + exact 문자열 + 라인 2회 등장 카운트(구현 워딩 pin). → `runCloseoutCritic`을 undefined/`{enabled:false}`/`{enabled:true}`(no critic)로 호출해 동기적 undefined 반환 + never-settling critic이 OFF 경로를 hang 안 시킴 단언.
- **`tests/unit/agent/closeout-critic-hellgate.test.ts:200`** — knobs/closeout-critic.ts 소스에서 `envKey:"QUANTA_CLOSEOUT_CRITIC"` 등 grep. → `closeoutCriticKnob.parse(...)`를 import해 undefined/'0'/''/'garbage'→undefined, '1'/'on'/'true'→`{enabled:true}` 단언, registerKnob grep 삭제.
- **`tests/unit/git/conflict-parser-ssot-ratchet.test.ts:27`** — forwarder에서 `for(`/`while(` 금지(map/forEach 재구현엔 false-pass, 주석/문자열엔 false-fail). → 두 라인 삭제, `expect(forwarder.parseConflicts).toBe(canonical.parseConflicts)` identity 단언으로 교체.
- **`tests/unit/runner/public-old-seam-hellgate.test.ts:45`** — run-once.ts에서 `./prompt-payload"` import 리터럴 pin(off-theme positive grep, run-once-multimodal.test.ts가 행위 커버). → line 45 삭제.
- **`tests/unit/runtime/exec-cluster-spawn-env-scrub-ban-hellgate.test.ts:200`** — 5개 파일 텍스트 스캔이지만 실제 spawn site `scrubbed-spawn.ts`는 CLUSTER_FILES에 없어 맹점; type-brand+행위 테스트로 대체됨. → 삭제하고 ScrubbedEnv brand + scrubbed-spawn-brand/sandbox 행위 테스트 의존(최소한 scrubbed-spawn.ts를 스캔 대상에 추가).
- **`tests/unit/apps/cli/t06-external-prompt-queue-hellgate.test.ts:21`** — external-prompt-queue.ts(runner)에서 클래스 헤더/`removeEventListener`/import-direction grep. → toContain 삭제, import-direction fence는 repo의 surface-coupling ratchet으로 이전(QUEUE-1..5가 행위 커버).
- **`tests/unit/apps/cli/t06-external-prompt-queue-hellgate.test.ts:37`** — surface alias 파일에서 `#waiters`/`removeEventListener` 부재 grep(copy-paste 리네임에 false-pass). → 삭제, thin-alias는 QUEUE-1..5가 보장.
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:101`** — barrel index.ts에 helper명 부분문자열 grep. → 삭제(line 118 런타임 typeof가 strictly stronger).
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:196`** — barrel에 `LifecycleBundle` 타입명 grep(런타임 erase, 주석에도 매치). → 삭제, typecheck/`satisfies` fixture 의존.
- **`tests/unit/apps/agent/mode-presets/batch.test.ts:55`** — batch.ts에서 `BENCH_EVAL_MODULE` const 철자 + `import(...)` grep. 실 fence는 surface-coupling-ratchet의 AST 스캐너. → 삭제, AST ratchet 의존(또는 dynamic-import seam mock으로 lazy-load 행위 단언).
- **`tests/unit/apps/cli/slash-registry-split-hellgate.test.ts:204`** — slash-commands.ts export 선언 토큰 grep(re-export로 바꾸면 false-fail). → `import * as sc` 후 `typeof sc.runSlashCommand==='function'` 등 심볼 존재 단언.
- **`tests/unit/apps/cli/slash-registry-split-hellgate.test.ts:220`** — `...SURFACE_SLASH_COMMANDS` 등 spread 토큰 + inline 부재 grep; 의도는 CASE-6/7이 이미 행위 커버. → CASE-15 삭제(필요시 identity 기반 layer-ownership 단언).
- **`tests/integration/decision-emit-wire-e2e-hellgate.test.ts:151`** — service.ts에서 `indexOf('emitJailDeny...') < indexOf('throw...')` 토큰 순서; CASE-6b/6d가 이미 emit-before-throw를 행위로 증명. → 삭제.
- **`tests/integration/review-kind-gate-hell.test.ts:388`** — admissibility-gate.ts에서 `/steerInjection\s*:/g` 카운트===1; R-5가 행위로 커버, admissibility-deny-steer-hell.test.ts:625의 verbatim 중복(원본에선 paired control이라 의미 있음). → R-10 삭제(canonical owner는 G-1d).
- **`tests/integration/nicknames-hell-e2e.test.ts:201`** — nicknames.ts 소스에서 RNG 토큰 banned grep; section 2/3의 11,000 seed-pair 행위 결정성이 strictly stronger. → describe 블록 + 미사용 import 삭제.

### TAUTOLOGICAL (LOW)

- **`tests/unit/connectors-types.test.ts:20`** — 손수 쓴 `["oauth","none"]` 배열을 순회해 `seen===2` 재카운트; `SupportedAuth`는 type-only(런타임 erase), `default: never` arm 없어 widening을 컴파일/런타임 어디서도 못 잡음. → `default:{const _x:never=v}` sink + `Record<SupportedAuth,true>` key-exhaustive source로 교체, 런타임 count 삭제.
- **`tests/unit/connectors-types.test.ts:36`** — `RefreshOutcome` 동일 패턴(`seen===3`). → 동일 fix 또는 실제 `refresh()` producer 테스트.
- **`tests/unit/connectors-types.test.ts:51`** — `AvailabilityVerdict` 동일(`seen===4`). → 동일 fix 또는 `createAvailabilityProber()/probe()` 단언.
- **`tests/unit/connectors-types.test.ts:67`** — `Connector` 리터럴 구성 후 `c.id==='x'` 등 방금 쓴 값 read-back. → 컴파일-only fixture로 두고 런타임 expect 삭제(또는 real registry round-trip).
- **`tests/unit/connectors-types.test.ts:78`** — `oauthIssuer` read-back 동일. → 동일.
- **`tests/unit/runner/knobs-telemetry.test.ts:43`** — literal `AgentEvent` 필드를 자기 자신에 단언; 가치는 `: AgentEvent` 타입 annotation(컴파일). → 런타임 expect 제거, 타입 annotation만 유지.
- **`tests/unit/runtime/guarded-spawn.test.ts:74`** — `cleanupSpy`가 `withSpawnedChild`에 전달조차 안 됨 → `toHaveBeenCalledTimes(0)` 구조적으로 항상 참. → dangling 단언 + spy 선언 삭제(omitted-cleanup는 `out===42`+`killed===0`가 이미 증명).
- **`src/llm/system-prompt-cache/__tests__/port-contract.test.ts:145`** — `reasons.length).toBe(3)`는 방금 3원소 쓴 배열; exhaustiveness는 `never` switch + `_ReasonSet` 타입이 강제. → literal-length expect 삭제(또는 각 reason이 `cache.invalidate`로 stats 증가시키는지 행위 단언).
- **`tests/unit/runner/knobs-telemetry.test.ts:104` [OVER_MOCKED/LOW]** — `CapturingStream.emit`은 array push만; 자기 호출 후 `events.length===1` 단언(SUT 없음). → describe 블록 + 미사용 클래스 삭제(실 JsonlRecorder/StdoutStream 테스트가 110-224에 있음).
- **`tests/unit/apps/cli/session-setup-hellgate.test.ts:77`** — `SetupSessionDeps` 27키인데 12키 subset을 `toHaveLength(12)` 자기검사. → 런타임 count 삭제, `satisfies Record<keyof SetupSessionDeps,1>` lock 유지.
- **`tests/unit/apps/cli/session-setup-hellgate.test.ts:61`** — line 77과 동일 물리적 단언(중복 기록). → line 77 fix로 함께 해결, 이중 카운트 금지.
- **`tests/unit/apps/cli/session-loop-hellgate.test.ts:735`** — `SessionLoopSinks` 4키 subset `toHaveLength(4)`(여기선 전부 나열돼 rename은 잡음, 런타임 단언만 무의미). → `satisfies Record<keyof SessionLoopSinks,true>`로 교체.
- **`tests/unit/memory/auto-trigger-hellgate.test.ts:696`** — `TriggerPolicy` 리터럴의 자기 키를 자기 자신에 단언. → 삭제; 필요시 `Object.keys(DEFAULT_TRIGGER_POLICY).sort()` 단언(프로덕션 상수 읽기).
- **`tests/integration/git-tools.test.ts:91`** — `test.skipIf(!HAS_GIT)` 하에 `expect(HAS_GIT).toBe(true)`는 실행 시 항상 참. → 삭제(skipIf가 이미 git 부재 시 skip 처리).

### NON_EXECUTING (LOW)

- **`tests/unit/code-mode-default-off-hellgate.test.ts:84`** — `not.toHaveProperty("newQuickJSAsyncWASMModule")`는 third-party export라 barrel이 절대 re-export 안 함 → 절대 실패 불가; lazy-load와 무관. → require cache에서 quickjs 항목 0개 단언(`Object.keys(require.cache).filter(k=>k.includes("quickjs-emscripten"))`)으로 교체(in-repo 0 검증됨).
- **`tests/unit/deny-reason-structure-hellgate.test.ts:177`** — 손빌드 `envelopeOff` 리터럴을 동일 리터럴에 `.toEqual` + 안 넣은 키 부재 단언(SUT 0). 실 knob-OFF는 admissibility-gate.ts:874 conditional spread. → 삭제(deny-reason-reachability-hellgate.test.ts:320-338가 실코드로 byte-identity 증명).
- **`tests/unit/deny-reason-structure-hellgate.test.ts:184`** — 실 `structuredDenyReason` 호출하나 envelope는 손조립, 방금 추가한 키를 destructure-out 후 나머지=손작성 리터럴 단언. → 삭제(reachability suite knob-ON이 커버) 또는 `runAdmissibilityGate`로 구동.
- **`tests/unit/cli/runtime-sdk-cutover-hellgate.test.ts:50`** — src 전역에 0회 등장하는 ghost 심볼 부재 grep(이미 삭제된 코드 재출현만 방지). → zero-occurrence 심볼/경로 가드 삭제, live-boundary subset(replaceMessages/assembleConfig/모듈 경로)만 유지.
- **`tests/unit/integrations/github/webhook-tier1-integration-hellgate-r5.test.ts:73`** — `src.poll`은 deliveryStore 유무와 무관히 항상 존재(store는 `start()`→`routeRequest`에서만 읽힘). → `start()`로 동일 x-github-delivery 2회 전달해 두 번째 dedup(큐 +1만) 단언, 또는 삭제(webhook-server.test.ts:206-220이 커버).
- **`tests/integration/mcp-client.test.ts:112` [NO_ASSERTION/LOW]** — 본문에 expect 0개(real 서브프로세스는 돎). → 두 번째 `start()` 후 still-live 연결로 round-trip(`listTools()` 결과 단언)해 handshake 완료 + idempotent를 증명.

### REIMPLEMENTED (LOW)

- **`tests/unit/memory/auto-trigger-hellgate.test.ts:767`** — 로컬 `inspect` switch(kind→string)는 프로덕션에 없음; 자기 리터럴을 자기 switch에 먹임. → local-switch 삭제(HELL-MAT-01/03/05가 실 onSessionEnd 결과 커버); `new TriggerError('phase1_throw','x').reason` 1줄만 유지.

### DUPLICATE (LOW)

- **`tests/unit/surface-coupling-ratchet.test.ts:77`** — line 57과 동일 SUT/필터/단언, allowlist가 빈 Set이라 logically identical. → 두 번째 테스트 삭제(또는 allowlist를 실제 debt로 seed해 두 세트를 분리).
- **`tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts:16` [DUPLICATE/LOW]** — cli-sdk-parity/runtime-sdk-cutover와 동일 파일/부분문자열 grep 삼중. → 하나의 owner로 병합(또는 biome 룰로 일임).
- **`tests/unit/apps/cli/repl-host-slim-hellgate.test.ts:187`** — `/function X(/` regex가 test 3(line 95)과 거의 동일(주석도 인정). → 블록 삭제.
- **`tests/unit/apps/cli/runrepl-shape-hellgate.test.ts:56`** — "6 helper 모듈 존재" + slice import가 repl-host-slim-hellgate.test.ts와 near-identical 구조 lock. → host-slim hellgate로 통합, 여기선 제거.
- **`tests/unit/memory/auto-trigger-hellgate.test.ts:644`** — line 632의 `assembleMemoryAuto({QUANTA_MEMORY_AUTO:'off'})).toBeNull()` 동일 호출/단언 복사(host-skip 서사는 미실행). → 삭제, 서사는 632 주석으로.

### FLAKY (LOW) — 월클록 타이밍 게이트

- **`tests/unit/hard-deny-redos-bound.test.ts:70`** — PATTERN.test 결과 폐기, 유일 단언이 `elapsed<100`. → `const result = PATTERN.test(adversarial)` 캡처 + `.toBe(<correct>)`, 타이밍은 부차 가드로.
- **`tests/unit/pii-redaction-hellgate.test.ts:144`** — clean 고정길이 입력에 `dur<2000`(원리상 flaky + 사실상 no-op ReDoS 가드). → line 144 삭제, 필요시 길이 증가 입력으로 sub-quadratic 스케일링 단언.
- **`tests/unit/shadow-odb-hellgate.test.ts:503`** — 두 ISO-초 suffix를 다르게 하려 real-clock `setTimeout(1100)`; `now()` seam이 public. → advancing fake clock 주입(`now:()=>new Date(t+=1000)`)으로 deterministic·sub-ms 교체.
- **`tests/unit/agent/streaming-boomerang-hellgate.test.ts:284`** — 1000 chunk drain에 `elapsed<5000`(선행 count/last가 이미 no-leak 커버). → `t0`/`elapsed`/타이밍 단언 제거, perf 가드는 perf-suite flag 뒤로.
- **`tests/unit/connectors/custom-3p-hellgate.test.ts:288`** — 100 register에 `elapsed<50`(바로 위 length===100이 이미 커버). → 타이밍 제거, `list.map(s=>s.id)` 삽입순서 보존 단언 추가.
- **`tests/integration/session-stress-and-concurrent.test.ts:299` [FLAKY/MED]** — stress 블록 월클록 게이트들(280/299/300/320/329/408/413/440)이 같은 파일이 flaky로 문서화하고 `QUANTA_PERF_STRICT` 뒤로 게이트한 것과 동일 클래스인데 ungated(파일 내 불일치). → 각 타이밍 단언을 `if (process.env.QUANTA_PERF_STRICT==='1')`로 래핑.
- **`tests/integration/session-chaos-and-attack.test.ts:905` [FLAKY/LOW]** — `elapsed<5000`(behavioral L898/902/903이 real-IO 커버); sibling이 확립한 `QUANTA_PERF_STRICT` 컨벤션 위반. → `QUANTA_PERF_STRICT` 게이트로 감싸거나 삭제.

### TAUTOLOGICAL / NO_ASSERTION (LOW) — shadow-odb spy

- **`tests/unit/shadow-odb-hellgate.test.ts:661`** — FS 단언은 load-bearing이나 `toHaveBeenCalledTimes(1)`(661/676/687/696)은 직접 호출한 spy 1회 단언(bun mock bookkeeping 검사). → 4개 spy 단언 + `mock()` wrapper 삭제, 프로덕션 fn 직접 호출.

### NO_ASSERTION / NO_SIGNAL (LOW)

- **`tests/unit/auto-sweep-hellgate.test.ts:660`** — 제목은 음수 `walSizeThresholdBytes(-1)` 거부 주장이나 유일 단언 `h.scheduled===true`는 모든 sqlite 스윕에 참(resolver 거부 미관측); 실 metricsEmitter 있으나 counters 미검사. → `codex_r2.sweep.sqlite_wal_restarted` delta===0 단언(IB처럼 non-empty WAL 실DB로 resolver 격리).

### LOC_STRUCTURE_BUDGET (LOW) — 외부 메타데이터/lint-config

- **`tests/unit/llm-providers/foundry-real-stream-hellgate.test.ts:285`** — third-party package.json의 `@anthropic-ai/sdk` range에 `"0.50.3"` 부분문자열 단언; 어댑터 행위 0, 게다가 benign lower-bound widen엔 false-fail/실 `<2` widen엔 false-pass. → HELL-D1 삭제; major-bump tripwire는 CI dependency-policy로.
- **`tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts:36`** — biome.json의 verbatim lint 메시지 문자열 단언(룰 효과 아닌 config 스냅샷). → 메시지 문자열 pin 삭제; 필요시 biome.json을 JSON 파싱해 override 블록 구조만 단언, 실 강제는 CI `biome lint`.
- **`tests/unit/apps/agent/mode-presets/batch.test.ts:55`** (위 LOC 항목, interactive.test.ts:57도 동일 패턴).

### OTHER (LOW)

- **`tests/integration/browser-real-chrome-adversarial-e2e.test.ts:595`** — 10줄 주석이 테스트가 `test.skip`이고 프로덕션 pressKey가 Enter submit을 생략한다고 주장하나 **둘 다 거짓**(test는 live, 버그는 fixed, 테스트 실제 PASS). 테스트 본문은 정직. → stale 주석 블록(595-604) 삭제, 정확한 regression-guard 설명으로 교체(본문 변경 불필요).

---

## 교차 관찰 (행동 권고)

- **CLI surface import-fence 삼중화**: `cli-sdk-parity`, `runtime-sdk-cutover-hellgate`, `repl-thin-surface-ownership-hellgate` 3개 파일 + biome 룰이 동일 계약을 중복 강제. biome `noRestrictedImports`가 type-import·전 서브패스까지 잡는 SSOT이므로 테스트는 하나로 병합하고 나머지는 biome에 일임.
- **`session-setup-hellgate` / `session-loop-hellgate`의 `keyof[] + toHaveLength(N)` 패턴**은 subset 배열이라 add/drop 드리프트를 못 잡음. 전부 `satisfies Record<keyof T, true>` exhaustive lock으로 통일하면 런타임 카운트 타우톨로지가 사라지고 진짜 드리프트(추가/삭제/리네임)를 컴파일 타임에 잡음.
- **월클록 게이트 컨벤션 위반**: `session-stress-and-concurrent.test.ts`가 이미 `QUANTA_PERF_STRICT` 게이트 패턴을 확립했는데 같은 파일의 stress 블록과 `session-chaos-and-attack.test.ts`가 ungated. 단위 타이밍 게이트(`hard-deny-redos`, `pii-redaction`, `streaming-boomerang`, `custom-3p`, `shadow-odb`)는 행위 단언으로 교체, 통합 perf 게이트는 flag 뒤로 일괄 통일.