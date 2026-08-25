# aug-25 — /goal v2: 사용자 소유 목표 + host 비용정산 + 현재소스 verifier + authority 단일 완료정책

역사 기준: goal baseline `d06161c85` + continuation/judge landing `e510389aa` + 계획 landing `93d1e40ee`
(2026-08-25). **실행 기준 SHA는 고정 문자열이 아니다.** 각 티켓 시작 시 live `main`/`origin/main`,
index, dirty owner를 다시 freeze하고 receipt에 남긴다. 2026-08-25 재감사 시 `main=93d1e40ee`,
`origin/main=412269e76`, local main `+4`였고, 실행 착수 시(같은 날 저녁) `HEAD=origin/main=b4f1b5286`, ahead 0, index empty,
unrelated dirty 57이었다. PTY `cli-goal-pursuit-e2e`는 착수 시점 9/9 ×2 GREEN(이전 8/1 순서의존 red는 HEAD에서 재현 안 됨).
티켓: [tickets/](tickets/) `GOAL-00` ~ `GOAL-10`. 공유 owner는 직렬, main-direct, 단일 writer.

## 목적
사용자가 한 채팅에 목표와 검증 가능한 종료조건을 설정하면, Quanta가 사용자 작업을 침범하거나
비용을 무제한 소비하지 않으면서 여러 turn에 걸쳐 계속 작업하고, 현재 소스에서 검증된 증거가
있을 때만 완료하며, pause/resume/edit/clear·재시작·attach 이후에도 일관된 상태를 유지한다.

Codex 공개 계약(durable objective, stopping-contract UX, `/goal edit|pause|resume|clear`,
checkpoint 보고, 장시간 실행 controls/status)만 parity 대상. Quanta의 자동 완료 정확성은 실제
criterion/verifier 계약이 있는 경우에만 주장한다. CAS/blocker hysteresis/verifier receipt/budget state는
Quanta 안전 확장으로 분리 표기한다.

## 코드 대조 결과 (2026-08-25, 직접 확인)
| 주장 | 근거 | 판정 |
|---|---|---|
| judge unavailable=admit (mode 무관) | `src/agent/tier1/objective-completion-admission.ts:317-327` | 확증. catalog yaml:143-146에 설계로 명시돼 있음 → 정책 반전 |
| 마지막 manual criterion markCriterion이 judge 우회 | `src/objective/authority.ts:198-206` gateOn=false면 model met:true 허용, `core-store/cell.ts:109` 파생 | 확증, **기본 설정**(`QUANTA_PROPOSE_GOAL` default OFF)에서 재현 |
| judge unavailable → 15초 hot loop | `goal-continuation-hook.ts:164-176` settle→ordinal++; fire fence는 revision/active만 | 확증 (PTY 실패 출력에서 8초 내 3회 fire 관측) |
| verifier 실행 경로 부재 | `src/objective/criteria/verifier.ts:49-55` C5 PARKED | 확증 |
| budget은 모델 recordUsage 자기보고만 | `src/tool/objective/index.ts:459` 유일 발신자 | 확증. `BudgetMeter`는 `agent-config-assembler.ts:882`/`context-binding/base.ts:339`에 이미 wired |
| receipt가 persistTurn 뒤에 생성 | `turn-runner.ts:148→172`, CLI는 dispatch 반환 후 기록 | 확증 |
| web attach no-clobber 오염 | `objective-store-wire.ts:141-149`, `web-daemon/server.ts:340` | 확증. CLI/web 공통 attach SSOT는 `src/session/attach-session.ts`; transcript 뒤 단계 실패 rollback 없음 |
| `/goal clear`=paused, set+activate 2 mutation, 4000자 | `slash/goal-cmd.ts:50, 84-85, 21` | 확증 |
| `/objective`만 edit/pause/resume/clear, resume "re-armed" 무조건 | `slash/objective.ts:124-132, 246` | 확증 |
| planModeActive 정적 | `interactive-setup.ts:309` | 확증 |
| legacy setInterval ticker 잔존 | `goal-continuation-hook.ts:191-216` | 확증 |
| GOAL_QUIET_MS 하한 없음 | `runtime-config.ts:228` parsePositiveInt | 확증 |
| explicitStatus에 completed | `core-store/cell.ts:57`, `rehydrate.ts:45,225` | 확증 |
| fromSnapshot이 progress 안 비움 | `authority.ts:449-453` | 확증 |
| receipt가 delta 아님 + Date.now | `apps/cli/repl/objective-progress.ts:55-62, 66, 78` | 확증. 단 "foreground/background 이중 receipt"는 코드상 근거 없음(bg는 then(ok,err) 원샷, fg는 `interactive-loop.ts:266` skip). 실제 구멍은 `backgrounded` outcome을 넘기는 caller 0 |
| blocker hysteresis가 프롬프트 문장뿐 | `pursuit-prompt.ts:15,32`, addBlocker 즉시 파생 | 확증 |
| actor 구분 필요 | `mutations.ts:30` 이미 `model\|user\|system\|verifier\|continuation` | **이미 있음**. `continuation` actor writer 0 → 정책표+배선만 |
| web에 objective authority 없음 | `web-daemon/runtime-factory.ts:140` | **이미 있음**. goal wake·turn.submit만 없음 |
| zero-criteria goal | judge block은 unmetCriterionIds⊂projection.unmet(비어있지 않음) 요구 → 0개면 항상 무효→admit | 문서 누락, 추가 결함 |
| 게이트 통합 | `OBJECTIVE_TOOLS`(32참조)/`PROPOSE_GOAL`(21)/`GOAL_ENFORCE`(16)/`OBJECTIVE_BUDGET_ENFORCE`(10)/`GOAL_JUDGE`(5)/`GOAL_QUIET_MS`(4) | 제거 불가. 공개 preset 1개가 seed |
| wake registry unbounded | `goal-wake-controller.ts:181` `claims = new Map`, eviction grep 무결과 | 가능성 높음, 정독 전 |
| legacy `ObjectivePort` mutator가 system actor로 policy 우회 | `authority.ts:createAuthoritySurface`의 `set/updateStatus/...` | 확증. GOAL-01에서 read port와 mutation authority 분리 필요 |
| `readDomain` current-source stale 투영 | `readDomain`은 sync/pure, source digest는 async FS/git | host digest 주입 설계 불가. GOAL-03 async reconcile mutation으로 변경 |
| hard cap 우선순위 | 기존 티켓은 user max가 product cap보다 우선 | 결함. effective cap은 두 cap의 `min` |
| foreground 질문 goal 과금 | 기존 GOAL-04 초안이 active goal의 모든 foreground turn을 정산 | 결함. 명시 goal provenance만 정산 |

rail 재실행: arch+ratchet 69/0 · typecheck src/tests pass · goal 유닛 9파일 116/0 ·
PTY `cli-goal-pursuit-e2e` 8 pass/1 fail (`uses its own quiet window…`, `No matching recording`;
단독 `-t` 재실행 2/2 pass → 순서의존, 원인 미측정).

## 순서와 의존
```
GOAL-00 current-head baseline + owner freeze
 → GOAL-01 domain-v2 (objectiveId, create/replace/clear, public mutator 폐쇄, schema v2)
 → GOAL-02 authority policy (actor×mutation 표, 파생 완료, judge shadow-only)
 → GOAL-03 verifier runtime (read-only argv runner, source digest, async reconcile, batch commit)
 → GOAL-04 attributed turn settlement (measured usage, receipt-before-persist)
 → GOAL-05A CLI facade (/goal 단일 control, status renderer, public autonomous preset 미활성)
 → GOAL-06 wake safety (ticker 제거, quiescence projection, backoff, effective hard cap, bounded registry)
 → GOAL-07 attach rollback transaction (CLI/web replace, session epoch fence)
 → GOAL-08 web turn.submit (원자 submit, admission port, controls, scheduler lifecycle)
 → GOAL-09 typed blocker observation (host-validated dependency, transient 3-attempt hysteresis)
 → GOAL-05B public `QUANTA_GOAL` preset 활성 + contradictory config fail-closed
 → GOAL-10 evidence + catalog (PTY/web E2E, semantic claim ratchet, exact surfaces)
```
공유 owner(`src/objective/authority.ts`, `core-store/*`, `src/tool/objective/index.ts`,
`interactive-loop/setup`)라 **병렬 금지**. 티켓 하나 = 세션 하나.

## 공통 프로토콜 (모든 티켓)
- 헬게이트: RED 먼저(실패 확인 → 구현 → GREEN), 적대어딧 ≥3R(wiring-proof·red-on-injection·mutation), 셀프어딧.
- 새로 만들지 않는 것: objective/goal store, TurnInFlight(기존 `activeTurnRef`), thread-idle store, polling ticker,
  progress log, retry DB, 웹 전용 objective domain, tool 레이어 완료판단기, raw transcript judge, /goal·/objective 별도 전이.
- git: 티켓 시작/커밋 직전 `git rev-parse HEAD` / `git rev-parse origin/main` / `git status --short` /
  `git diff --cached --name-only` / `git diff --cached --check`.
  예상 외 staged path, 외부 HEAD 변경, touched file에 타 세션 diff → 중단. `git add -u`·`git add .`·amend·rebase 금지.
- 완료 rail(티켓별 Proof rails + 아래 공통):
  ```
  bun run typecheck && bun run typecheck:tests
  node_modules/.bin/biome check --write <touched paths>   # run-biome.ts 래퍼는 path 인자를 무시하고 repo 전체를 --write 함(collateral) — 절대 사용 금지
  bun run lint:debt
  bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch
  bun test tests/unit/objective tests/unit/objective-*.test.ts tests/unit/goal-*.test.ts tests/unit/apps/cli
  bun test tests/integration/goal-continuation-live-e2e.test.ts tests/integration/objective-*.test.ts
  bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
  bun run test:contract
  ```
- 측정 선행 항목: reasoning token 포함관계(GOAL-04 전) · PTY 순서의존 red 원인(GOAL-00) · registry eviction(GOAL-06 전).
- 잘라낸 것: SOTA verifier adapter(HTTP/eval/visual), 별도 telemetry 배치(각 티켓 decision-counter에 흡수), judge reject 모드, 별도 명령 엔진.
- 최종 상태 보고 규칙: GOAL-10 전까지 "구조/행위 부분 GREEN, promotion 미완료". GOAL-06+07 종료 전
  및 GOAL-09 blocker 신뢰경계 종료 전 public autonomous preset 활성 금지, 전체 캠페인 default OFF 유지.
- 각 티켓 write set에는 `docs/plans/aug-25-goal-v2/receipts/GOAL-XX.yaml`이 포함된다. 구현 source commit
  S에서 rail을 실행하고 receipt-only evidence commit E를 만든다. receipt는 `testedSourceSha=S`와 source-tree
  digest를 기록하고, GOAL-10 final manifest가 path→E를 기록한다. E 자체 SHA를 E 안에 쓰는 자기참조는 금지.

## 원문 항목 → 티켓 매핑 (빠짐 대조, 2026-08-25 재검토)
| 원문 항목 | 티켓 |
|---|---|
| objectiveId/generation, authority 발급, canonical legacy migration, snapshot schema v2, null tombstone revision | 01 |
| create/replace/clear 분리, clear 실삭제·revision 증가, explicit completed 제거 | 01 |
| fromSnapshot progress clear, receipt에 objectiveId, legacy public mutator 폐쇄 | 01 |
| actor-fixed capability port, actor×mutation 정책표, rejection code, 상태 전이표, completed 후 model mutation 금지 | 01/02 |
| 파생 완료정책(manual attestation, checked verifier, zero-criteria contract missing, blocker) | 02 |
| 모델 도구 축소(status/recordUsage/markCriterion met:true 제거), thread_id deprecate | 01(op 제거) / 02(스키마·정책) |
| judge shadow-only, reject 강등, sanitization 유지 | 02 |
| verifier ports + host adapter, 기존 spawn/sandbox helper 공유 `runArgv`, read/network/resource 격리, cwd 고정, env scrub | 03 |
| source digest manifest, before/after, async reconcile/invalidate, batch 단일 commit, passed 재계산 | 03 |
| 모델 검증 요청(`requestVerification`), 승인된 check만 실행, HITL escalation | 03 |
| durable beginAttempt→paid run→settleAttempt, BudgetMeter delta, authority-state 정산, uncertain/fail-stop persistence | 04 |
| outcome SSOT(`stopCategoryForReason`)+executionMode, injected clock, delta receipt, 일반 foreground 무과금 | 04 |
| task budget prompt 연결(두 번째 renderer 금지), pursuit prompt attemptKey 제거 | 04 |
| /goal 단일 facade, /objective alias, set 단일 CAS, atomic contract edit, clear/stop, criterion/check CRUD·complete/reopen, budget/verify | 05 |
| resume 결과 status 분기, status renderer(lifecycle/verified/remaining/blocker/next/budget/last attempt/last verified/checkpoint) | 05 |
| 공개 gate 1개(preset seed), OFF면 discovery 제외 | 05 |
| legacy ticker 제거, quiescence projection(9종), live plan mode, arm+fire 2회 검사 | 06 |
| backoff(progress/no-progress/error/429 1회/unavailable cooldown/user reset), knob SSOT+clamp, `min(user,product)` hard cap | 06 |
| registry bounded, attempt claim/local-input/throw-cleanup RED, idle-suppress 독립 | 06 |
| attach prepare/commit/rollback(0/1 domain, mid-turn 거절), fork paused clone, live identity/sessionEpoch | 07 |
| web `turn.submit` 원자, expectedRevision, payload-bound admission claim, approval resume, controls, scheduler lifecycle | 08 |
| blocker observation(host-validated dependencyRef, transient 3 attempts, confirmed user/approval 즉시) | 09 |
| PTY/web 배터리, mutant receipt manifest, telemetry allowlist, semantic catalog parity, exact surfaces | 10 |
| current-head baseline, owner freeze, PTY 순서의존 red 격리 | 00 |

## 소유권 (중복 작업 방지)
| 항목 | 정의(타입) | 구현 | 비고 |
|---|---|---|---|
| `beginAttempt`/`settleAttempt` | 01 | 04 | 01은 타입+actor-fixed capability; 04가 durable two-phase attempt를 구현 |
| `applyVerificationBatch` | 01 | 03 | 동일 |
| `invalidateVerification` | 01(타입 자리) | 03 | async host reconcile만 verifier actor로 발신 |
| `completionSatisfied` | 02 | 02 | 01은 기존 all-met 파생 유지 |
| 하드캡 `maxAutonomousTurns` | 06 | 06 | 04는 전체 attributed usage와 autonomous-started를 분리 기록; 06은 후자만 product cap에 사용 |
| slash 파일 수정 | 01(컴파일 최소) | 05A(구조·문구), 05B/06(public preset) | 01에서 UX 손대지 않음 |
| catalog yaml | 02(judge 문구) | 10(재작성) | GOAL-00은 현 상태만 기록하고 catalog를 수정하지 않음 |
| web wake cancel/re-arm | 07(transaction hook+rollback) | 08(controller 실배선) | no-op callback으로 성공을 가장하지 않음 |
| registry entry 삭제(attach/clear) | 06(구조) | 07(attach 호출) | |
| telemetry 이벤트 | armed/canceled/skipped/cooldown=06 · enqueue admitted/rejected/stale dequeue=06(CLI)/08(web) · attempt started/settled=04 · completion satisfied/rejected=02 · verifier batch applied/stale-source=03 · label allowlist 테스트=10 | | 이벤트는 소유 티켓이 추가, 10은 검사만 |
| PTY 시나리오 | 각 티켓이 추가 | 10은 인덱스+누락분+mutant receipt | |
| shadow judge lifecycle | 02(경계: telemetry-only, 상태 불변) | 04(`ObjectiveJudgeObserverPort` 세션 task lifecycle 배선) | 04 전까지 production shadow 호출 비활성 |
| `sessionEpoch` | 07 | 07 | 04/06은 `when available`로만 참조 |
| GOAL-09 producer 인벤토리 | 09 선행 | 09 | network retry evidence 레지스트리는 현재 없음(openai adapter 내부 retry뿐) — 09 착수 시 producer 존재 확인 후 없는 것은 scope-out 기록 |

## GOAL-01 실행 기록 (2026-08-25)
- 랜딩 범위: objectiveId/createdBy/migrationSource, `create|replace|clear|setExplicitStatus|amendBudget|settleAttempt`(+기존), explicit `active|paused`, 세대 경계에서 evidence 전량 삭제, receipt의 objectiveId 바인딩, tombstone revision, 세션 스냅샷 v2(+v1 로드/1회 마이그레이션, 4000자 초과 거부), `knownThreadIds`, `ObjectiveReadPort` 타입, authority-boundary ratchet(allowlist 10 파일, 02가 축소).
- 소유권 표와 다른 점(기록): `settleAttempt`의 authority 측 정산(usage debit + receipt)은 01에서 구현했다 — `recordUsage` 제거 후 budget_limited 파생/테스트가 살아 있으려면 유일한 usage feeder가 필요했기 때문. 04는 durable `beginAttempt` + runtime 배선을 추가한다. actor-fixed capability 객체(`ModelObjectiveCommands` 등)는 02에서 정책표와 함께 도입(01은 read port 타입 + ratchet까지).
- port 표면 규칙: 타입된 rejection(objective-exists 등)은 `null`, rejection 없는 no-op(unknown criterion id)은 기존 objective 반환(기존 계약 유지).
- `objective_set` 도구: objective가 있으면 `replace`(새 세대). `/goal <text>`도 동일(05가 `edit` 강제로 바꿈).
- 도구 하자: `tools/dev/run-biome.ts check --write <paths>`는 path 인자를 무시하고 repo 전체를 --write 한다(collateral 위험). 티켓 rail은 `node_modules/.bin/biome check --write <paths>`로 교체됨.

## GOAL-02 실행 기록 (2026-08-25)
- 랜딩 범위: `src/objective/policy.ts`(actor×mutation `MUTATION_POLICY` + 모듈 로드 drift-guard `assertMutationPolicyComplete` + `authorizeMutation` + `completionSatisfied`/`criterionSatisfied`/`validationContractOf` + 전이표), authority가 `classify`를 버리고 정책표를 소비, `deriveStatus`가 신뢰 증거(user/system manual receipt, bound passing verifier receipt)로만 completed 파생, `readDomain.validationContract`, `src/objective/capabilities.ts`(`createObjectiveCapabilities` → read/user/model/continuation/verifier/system, `asObjectiveReadPort`), 모델 도구 축소(`objective_set`=create 제안만, `objective_update`=addBlocker|nextActions만, `thread_id` deprecated/ignored), judge `reject` 제거+`objective-judge-observer.ts`(telemetry-only, 프로덕션 호출은 04 lifecycle까지 비활성), boundary ratchet allowlist 10→4.
- 티켓과 다른 점: 모델 `clearBlocker` op는 스키마에서 제거(정책이 어차피 거부 — 스키마와 정책 불일치를 두지 않음). RED 12(`attempt-in-flight`: durable started attempt 중 replace/clear 거부)는 attempt 저장이 04에 있으므로 04에서 RED 고정. shadow observer의 production 배선은 04.
- commit 순서: CAS → policy. 경쟁에서 진 writer는 `stale`(재읽기), 현재 writer만 정책 verdict를 본다. 세대 전제조건(`objective-exists`/`objective-missing`)은 정책에 있어 gate-on 승인 프롬프트 전에 거부된다(프롬프트 후 거부 UX 결함 제거).
- 마이그레이션 영향: 레거시 v1 스냅샷의 model-attested manual receipt는 `met:true`를 유지하되 status는 `active`(신뢰 증거 아님) — 의도된 하향.

## GOAL-03 실행 기록 (2026-08-26)
- 랜딩 범위: `src/objective/criteria/ports.ts`(runner/evidence/batch/outcome 포트 + `checkPassed`), mutation `applyVerificationBatch`/`invalidateVerification`(verifier only; authority가 passed 재계산, 세대·revision·check id 전량 재검증, all-or-nothing), core `resetCheckedCriterion`, `src/runtime/run-argv.ts`(shell.ts에서 env scrub·snapshot restore·per-call wrap·sandbox slot·honest status를 추출, shell.ts 881→737; `runShell`은 같은 레이어를 소비), `src/host/runtime/objective-verifier-wire.ts`(runner=runArgv+digest only, git/non-git manifest digest+precheck, coordinator verify/reconcile, CAS 재시도 2회, `maybeWireObjectiveVerifier`), AgentConfig `objectiveVerifier` 슬롯 + capability wire `objectiveVerifier`(objective 뒤), 모델 도구 `objective_verify`(argv 없음), 매니페스트 group 등록.
- 티켓과 다른 점: `markCriterionVerified`(단건 verifier 경로)는 forgery hellgate가 고정하고 있어 유지(배치와 동일 검증 규칙; 둘 다 verifier 전용). posture는 README 결정대로 workspace-write+digest 불변(소스를 바꾸는 check는 stale-source·receipt 0 — "write blocked before damage"는 아님). `/goal check add`/`/goal verify` CLI는 05. 모델 검증 요청의 attempt당 1회 제한은 attempt identity가 04에 있어 04에서. HITL 약한 진단 경로는 미구현(runner 외 receipt 경로 자체가 없음).

## GOAL-04 실행 기록 (2026-08-26)
- 랜딩 범위: `src/objective/attempt.ts`(attempt context/state/slot: claim·take·release·failStop·recover, provenance `autonomous-continuation|user-requested-goal-work`), mutation `beginAttempt`(system only; turn + autonomous hard-cap 슬롯을 provider 호출 **전** 예약, `attempt-in-flight`/`attempt-replayed` 거부)·`settleAttempt`(started attempt 일치 필수, 재차감 없음, 측정 usage만)·`abandonAttempt`(user/system; 소비된 슬롯은 환불하지 않음), policy: started attempt 아래 `replace`/`clear`는 `attempt-in-flight`(pause는 허용), snapshot v2 `attempts` 영속(orphan started는 restore 후에도 슬롯 소비·재실행 없음), `src/host/runtime/internal/context-binding/objective-settlement.ts`(begin: stale claim 무과금·BudgetMeter 없으면 composition error+slot fail-stop·start persist 실패는 fail-stop+provider 미호출 / settle: reconcile→`settleAttempt` 1회→judge; `SETTLEMENT_OUTCOME: Record<StopReason, ProgressTurnOutcome>`), turn-runner: `runAgentSettled`(정상·approval pause·throw 모두 정확히 1회 정산)→`persistTurnOrFailStop`(정산 후 영속 실패는 환불 없이 fail-stop), `persistObjectiveSnapshotNow`(id-mode `updateSessionAtomic`), CLI: `claimGoalAttempt`(goal-continuation 프롬프트만 host provenance로 claim; `objective-progress.ts` 삭제), tooling-bundle: `QUANTA_GOAL_ENFORCE`면 BudgetMeter 구성(rail 13).
- 실측 근거: PTY e2e 첫 실행이 RED — 실제 CLI REPL은 turn assembler를 쓰지 않아 `cfg.budgetMeter`가 없었고 rail 13이 continuation을 전부 거부(wake 루프가 같은 composition error로 20회 재claim). 수정 = 부트 meter 구성 + composition error시 slot fail-stop. 수정 후 임시 계측으로 확인: `attributed=true meter=true prov=autonomous-continuation`, objective budget `tokensUsed 2 / turnsUsed 1`(replay cassette 1+1) 정확히 1회.
- usage 정의: meter delta = `inputTokens + outputTokens`(loop tick과 동일; reasoning은 outputTokens 안에 포함 — `src/llm/openai-responses-wire-reasoning-usage.test.ts`가 핀; cache read/creation은 meter와 동일하게 제외). stream accumulator는 `usageSource:"legacy-stream-events"` 명시 opt-in에서만.
- 티켓과 다른 점: `/goal verify` 무과금·`/goal work` user-requested provenance(rail 4·5)는 CLI facade(05)에서. wake 전 slot 상태 확인·paused 재arm 억제(rail 9 후반·E2E "restart auto-rearm rejected")는 06. `renderTaskBudgetBlock` 재사용(objective budget을 같은 렌더 owner로)은 05 renderer 항목으로 이관 — 04는 정산만. approval pause 정산은 id-mode에서만 즉시 영속(path-mode는 다음 persistTurn). 부트 meter 배선의 wiring-proof는 PTY e2e(9/9; 배선 전 RED)로 갈음 — tooling-bundle 단위 fake는 미작성.
- 사전 존재 red(04 소유 아님): god-code 900-999 cohort 26>24(HEAD==worktree, GOAL-04 파일 진입 없음 — 정확 metric으로 대조), `src/apps/bench/resume/store.ts:63` magic-timeout(e510389aa). GOAL-03 잔여 6건(magic timeout ×5, run-argv env seam)은 이번에 정리.

## 결정 기록 (구현 전에 고정, 티켓 내 재결정 금지)
- verifier 실행 posture는 **workspace-write + before/after source digest 불변 검증**이다. read-only source mount는 `bun test`(.cache/tsbuildinfo)·pytest(`__pycache__`)·cargo(`target/`) 같은 실용 check를 전부 fail-closed로 만들어 verifier를 무용하게 하므로 기본이 아니다. digest가 변하면 stale-source, receipt 0. network deny·outside-workspace read deny·resource cap은 유지. 더 엄격한 read-only 프로필은 opt-in.
- receipt rail은 `git worktree add <scratch> S`에서 실행해도 된다(동시 세션이 main에 커밋하므로 S와 rail 사이 tree 불변 조건은 worktree로 충족). receipt에 worktree 경로/`git rev-parse HEAD`를 기록.
- wake 전 reconcile은 `git status --porcelain` + HEAD 다이제스트의 싼 precheck를 먼저 하고, 변경이 있을 때만 full manifest를 해시한다(대형 repo 15s 주기 비용 방지).
- judge `reject` 모드 제거(shadow만). shadow도 명시 eval gate에서만 실행하고, 별도 metered budget/abort/dispose를 가진다.
- goal text/criterion/check 변경은 새 objectiveId를 발급한다. `/goal edit`은 새 stopping contract를 원자 입력하거나
  기본적으로 contract를 비우고 wake-ineligible로 둔다. 기존 contract 재사용은 명시 `--keep-contract` + 사용자 확인일 때만 허용한다.
- budget 변경은 same-ID `amendBudget` user/system mutation. 기존 verifier 증거를 버리지 않으며 product hard cap을 넘지 못한다.
- 일반 foreground turn은 goal budget에 넣지 않는다. host가 발급한 goal provenance가 있는 turn만 정산한다.
- validation contract가 missing이면 자동 wake/완료 모두 금지하고 renderer가 criterion/check 추가 명령을 표시한다.
- current-source freshness는 domain `readDomain` 주입이 아니라 host async `reconcile` → verifier-only invalidation mutation으로 유지한다.
- confirmed pending approval/user request는 즉시 blocked/awaiting-user; 3-attempt hysteresis는 transient network/tool dependency만 적용한다.
- fork는 새 objectiveId, paused clone, progress 미복제.
- web daemon 증거는 `ui_surfaces:web`, `modes:daemon`; IDE/Tauri 증거가 없으면 `ide`로 승격하지 않는다.
