# aug-25 — /goal v2: 사용자 소유 목표 + host 비용정산 + 현재소스 verifier + authority 단일 완료정책

기준: `main` HEAD `1624c7ce707ed757e76936878cbca9609dc6abc0` + staged goal slice (2026-08-25).
티켓: [tickets/](tickets/) `GOAL-00` ~ `GOAL-10`. 순서 고정, 직렬, main-direct, 단일 writer.

## 목적
사용자가 한 채팅에 목표와 검증 가능한 종료조건을 설정하면, Quanta가 사용자 작업을 침범하거나
비용을 무제한 소비하지 않으면서 여러 turn에 걸쳐 계속 작업하고, 현재 소스에서 검증된 증거가
있을 때만 완료하며, pause/resume/edit/clear·재시작·attach 이후에도 일관된 상태를 유지한다.

Codex 공개 계약(durable objective, verifiable stopping condition, `/goal edit|pause|resume|clear`,
checkpoint 보고, 장시간 실행)만 parity 대상. CAS/blocker hysteresis/verifier receipt/budget state는
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
| web attach no-clobber 오염 | `objective-store-wire.ts:141-149`, `web-daemon/server.ts:340` | 확증 (CLI fork-attach 경로는 미정독) |
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

rail 재실행: arch+ratchet 69/0 · typecheck src/tests pass · goal 유닛 9파일 116/0 ·
PTY `cli-goal-pursuit-e2e` 8 pass/1 fail (`uses its own quiet window…`, `No matching recording`;
단독 `-t` 재실행 2/2 pass → 순서의존, 원인 미측정).

## 순서와 의존
```
GOAL-00 index split + staged landing
 → GOAL-01 domain-v2 (objectiveId, create/replace/clear, explicit active|paused)
 → GOAL-02 authority policy (actor×mutation 표, 파생 완료, judge shadow-only)
 → GOAL-03 verifier runtime (argv runner, source digest, batch commit)
 → GOAL-04 turn settlement (measured usage, receipt-before-persist)
 → GOAL-05 CLI facade (/goal 단일 control, preset gate, status renderer)
 → GOAL-06 wake safety (ticker 제거, quiescence projection, backoff, hard cap, bounded registry)
 → GOAL-07 attach transaction (CLI/web replace, generation fence)
 → GOAL-08 web turn.submit (원자 submit, scheduler lifecycle)
 → GOAL-09 blocker observation (3-attempt hysteresis)
 → GOAL-10 evidence + catalog (PTY/web E2E, fc gates, Modes 축소)
```
공유 owner(`src/objective/authority.ts`, `core-store/*`, `src/tool/objective/index.ts`,
`interactive-loop/setup`)라 **병렬 금지**. 티켓 하나 = 세션 하나.

## 공통 프로토콜 (모든 티켓)
- 헬게이트: RED 먼저(실패 확인 → 구현 → GREEN), 적대어딧 ≥3R(wiring-proof·red-on-injection·mutation), 셀프어딧.
- 새로 만들지 않는 것: objective/goal store, TurnInFlight(기존 `activeTurnRef`), thread-idle store, polling ticker,
  progress log, retry DB, 웹 전용 objective domain, tool 레이어 완료판단기, raw transcript judge, /goal·/objective 별도 전이.
- git: 커밋 직전 `git rev-parse HEAD` / `git status --short` / `git diff --cached --name-only` / `git diff --cached --check`.
  예상 외 staged path, 외부 HEAD 변경, touched file에 타 세션 diff → 중단. `git add -u`·`git add .`·amend·rebase 금지.
- 완료 rail(티켓별 Proof rails + 아래 공통):
  ```
  bun run typecheck && bun run typecheck:tests
  biome check --write <touched paths>   # repo-wide lint:fix 금지
  bun run lint:debt
  bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch
  bun test tests/unit/objective tests/unit/objective-*.test.ts tests/unit/goal-*.test.ts tests/unit/apps/cli
  bun test tests/integration/goal-continuation-live-e2e.test.ts tests/integration/objective-*.test.ts
  bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
  ```
- 측정 선행 항목: reasoning token 포함관계(GOAL-04 전) · PTY 순서의존 red 원인(GOAL-00) · registry eviction(GOAL-06 전).
- 잘라낸 것: SOTA verifier adapter(HTTP/eval/visual), 별도 telemetry 배치(각 티켓 decision-counter에 흡수), judge reject 모드, 별도 명령 엔진.
- 최종 상태 보고 규칙: GOAL-10 전까지 "CLI 구조/행위 GREEN, promotion 미완료". default OFF 유지. **(2026-08-27: GOAL-10 promotion 완료 — `QUANTA_GOAL` default ON 확정, `QUANTA_GOAL=0` 공개 opt-out; 아래 결정 기록·실행 기록 참조.)**

## 원문 항목 → 티켓 매핑 (빠짐 대조, 2026-08-25 재검토)
| 원문 항목 | 티켓 |
|---|---|
| objectiveId/generation, authority 발급, legacy migration | 01 |
| create/replace/clear 분리, clear 실삭제·revision 증가, explicit completed 제거 | 01 |
| fromSnapshot progress clear, receipt에 objectiveId | 01 |
| actor×mutation 정책표, rejection code, 상태 전이표, completed 후 model mutation 금지 | 02 |
| 파생 완료정책(manual attestation, checked verifier, zero-criteria contract missing, blocker) | 02 |
| 모델 도구 축소(status/recordUsage/markCriterion met:true 제거), thread_id deprecate | 01(op 제거) / 02(스키마·정책) |
| judge shadow-only, reject 강등, sanitization 유지 | 02 |
| verifier ports(objective slice) + host adapter, `runArgv` 추출(join 금지), cwd 고정, env scrub, digest만 | 03 |
| source digest manifest, before/after, stale-on-change, batch 단일 commit, passed 재계산 | 03 |
| 모델 검증 요청(`requestVerification`), 승인된 check만 실행, HITL escalation | 03 |
| runRuntimeTurn attempt context, BudgetMeter delta, settleAttempt, settle→persist, CAS restore | 04 |
| outcome SSOT(`stopCategoryForReason`)+executionMode, injected clock, delta receipt, foreground 질문 제외 | 04 |
| task budget prompt 연결(두 번째 renderer 금지), pursuit prompt attemptKey 제거 | 04 |
| /goal 단일 facade, /objective alias, set 단일 CAS, edit 요구, clear/stop, criterion/check/budget/verify | 05 |
| resume 결과 status 분기, status renderer(lifecycle/verified/remaining/blocker/next/budget/last attempt/last verified/checkpoint) | 05 |
| 공개 gate 1개(preset seed), OFF면 discovery 제외 | 05 |
| legacy ticker 제거, quiescence projection(9종), live plan mode, arm+fire 2회 검사 | 06 |
| backoff(progress/no-progress/error/429 1회/unavailable cooldown/user reset), knob SSOT+clamp, hard cap | 06 |
| registry bounded, attempt claim/local-input/throw-cleanup RED, idle-suppress 독립 | 06 |
| attach replace transaction(0/1 domain, fail-closed, 순서, mid-turn 거절), fork paused clone, live identity | 07 |
| web `turn.submit` 원자, provenance 재검증, scheduler lifecycle, `createTurnActivity` 1회 | 08 |
| blocker observation(typed dependencyRef, 3 distinct attempts, same-turn once, progress reset, user 즉시) | 09 |
| PTY/web 배터리 인덱스, mutant receipt, telemetry label allowlist, catalog 재작성(Modes/Level), promotion 판정 | 10 |
| index 분리, staged 정직 랜딩, PTY 순서의존 red 격리 | 00 |

## 소유권 (중복 작업 방지)
| 항목 | 정의(타입) | 구현 | 비고 |
|---|---|---|---|
| `settleAttempt` | 01 | 04 | 01은 kind+deny 핸들러만 |
| `applyVerificationBatch` | 01 | 03 | 동일 |
| `completionSatisfied` | 02 | 02 | 01은 기존 all-met 파생 유지 |
| 하드캡 `maxAutonomousTurns` | 06 | 06 | 04는 turnsUsed 카운트만 |
| slash 파일 수정 | 01(컴파일 최소) | 05(구조·문구) | 01에서 UX 손대지 않음 |
| catalog yaml | 00(정직화), 02(judge 문구) | 10(재작성) | 중간 티켓은 자기 knob 문구만 |
| web wake cancel/re-arm | 07(콜백 슬롯 no-op) | 08 | |
| registry entry 삭제(attach/clear) | 06(구조) | 07(attach 호출) | |
| telemetry 이벤트 | armed/canceled/skipped/cooldown=06 · enqueue admitted/rejected/stale dequeue=06(CLI)/08(web) · attempt started/settled=04 · completion satisfied/rejected=02 · verifier batch applied/stale-source=03 · label allowlist 테스트=10 | | 이벤트는 소유 티켓이 추가, 10은 검사만 |
| PTY 시나리오 | 각 티켓이 추가 | 10은 인덱스+누락분+mutant receipt | |

## 실행 기록 — 2026-08-27 셀프어딧 (main 기준, 헬게이트)
- 배경: `main`은 두 레인의 머지(`9b21d2fd2`)다. Codex 레인(`65f759203`, GOAL-04→10 + GOAL-10-RECEIPT)과 overlay 레인(`fa71870db`/`3c60751a2`/`f197dd889`, receipts 04/05A). 머지는 Codex 레인의 컨트롤러/파사드 형태를 취했고 overlay의 attempt slot·SETTLEMENT_OUTCOME·onPush 자기취소 fix를 흡수했다.
- 어딧 방법: 티켓 rail을 코드에 대조하고 probe 스크립트(사용자예산 5/제품캡 3 → 5회 arm, authority `beginAttempt` 25회 accept, contract 없는 goal 15s arm, env 999 → 999)로 확증한 뒤 RED→GREEN→뮤턴트로 닫았다.
- 닫은 위반(티켓 GOAL-06 rail 번호):
  - rail 3/4/5 + stop condition "User configuration can exceed the product cap": 제품캡이 `amendBudget maxTurns:20`으로 **유저 예산에 기록**되고 `turnCap = budget.maxTurns ?? cap`이었다 → `autonomousAllowance = min(userRemaining, productRemaining)`(product는 durable `autonomousTurnsStarted`), host는 예산에 쓰지 않음. `90ad48022`.
  - rail 13: authority `beginAttempt` 재검사 없음 → `hard-cap-exhausted`/`budget-exhausted` 거부 + `budget.limitedBy` 파생. `90ad48022`.
  - rail 16: contract 없는 goal이 arm → policy typed skip `validation-contract-missing`. `90ad48022`.
  - rail 7/"no public unsafe override": `QUANTA_GOAL_MAX_AUTONOMOUS_TURNS`/`_MAX_BACKOFF_MS` 상향 가능 → runtime-config·policy 이중 clamp(정책 상수와 동일성 테스트 핀), quiet<15s 경고 1회. `90ad48022`.
  - 구조 결함: 컨트롤러가 정책 skip(undefined)에 `?? delayMs`로 기본 quiet를 붙여 **모든 정책 거부가 advisory** → skip 바인딩. `90ad48022`.
  - rail 11: activityEpoch 부재 → 컨트롤러 epoch·fire 펜스·dequeue 드롭(continuation만). `48d020ac5`.
  - PTY 85/87: sub-clamp 케이스·실제 사이클 4회(122s) → `/goal` 리포트 typed `wake:` 라인(armed/pending/idle(reason)/stopped/not composed)으로 단정, 실제 15s 사이클 1회, 58s. `8418df17d`.
- 07/08/09 셀프어딧: 티켓 verification 명령 전부 GREEN(07: 621/0, 08: 712/0, 09: 73/0, contract 10/0). 뮤턴트 7개 중 2개 생존 → 전용 테스트 추가 후 RED(07 attach-generation 펜스, 08 approval-pending 전용 가드). receipts/GOAL-07~09.yaml.
- 결정: `QUANTA_GOAL` default ON은 GOAL-10 promotion의 결과로 확정(계획서 "GOAL-10 전까지 OFF"와 정합). 티켓05 함정 문구·README 보고규칙에 병기.
- 남은 non-Goal red(내 것 아님): lint:debt(`tools/feature-catalog/*` complexity, `tests/unit/apps/bench/promax/zz-adv-r1-*` console), typecheck:tests의 `tests/unit/zz-audit-r2-probe.test.ts`(미추적, bench 작업).
- 2026-08-27 (round 2, "다 제대로 해결"): GOAL-07 rail 13 / GOAL-08 rails 14·15 / GOAL-09 rails 11·12 closed with mutants (receipts updated). Probe found a real GOAL-08 defect — web/SDK goal turns were never attributed (no slot claim, no slot on the daemon base) — fixed via the SessionHost claim seam + daemon slot + sdk claim-before-dispatch; `submitGoalWork` / `/goal work` mint `user-requested-goal-work`; `session.objective.work` wire command deferred (reason in GOAL-08.yaml). 11/11 mutants RED (two pins added after survivors). Protocol bundle regenerated (`bun run build:protocol`).

## 결정 기록
- judge `reject` 모드 제거(shadow만). 원문은 "reject 유지 시 unavailable=거부"도 허용했으나 완료권이 authority로 가면 judge에 판정권이 없음.
- budget 변경은 user/system 전용 `setBudget` mutation으로 same-ID amend한다. criterion/check 변경만
  `replace`로 새 objectiveId를 발급하고 이전 completion/verifier/progress 증거를 폐기한다.
- fork는 paused clone.
