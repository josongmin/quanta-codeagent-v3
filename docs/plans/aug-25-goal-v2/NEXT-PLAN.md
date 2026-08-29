# aug-25 /goal v2 — 남은 작업 계획 (2026-08-30, 근거 명시)

이 문서의 모든 주장은 **오늘 main에서 직접 확인**한 것이다. 코드 주장은 `파일:심볼`,
행동 주장은 **프로브 실측치**를 함께 적는다. 추측은 "미측정"이라고 표시한다.
열린 항목의 요약 목록은 `README.md` "현재 상태"에 있고, 이 문서는 그 실행 계획이다.

---

## 실행 현황 (2026-08-30)

| 항목 | 상태 | 커밋 |
|---|---|---|
| P0-1 승인 후 재개(버려지던 goal 작업) | **DONE** — 커널이 일시정지 턴을 보관·재실행·재귀속, 승인 일시정지는 더 이상 stall로 집계되지 않음. 뮤턴트 7/7 RED | `0202570d3` |
| P0-2 manual 기준 attestation(`/goal criterion done`) | **DONE** — 뮤턴트 5/5 RED | `2b427b14f` |
| P0-3 멈춘 attempt 탈출(`/goal abandon`) | **DONE** — 뮤턴트 4/4 RED | `2b427b14f` |
| P1-3 정산 후 체크포인트 방출 | **DONE** — 정산 시임에 훅, CLI 한 줄(텍스트-free), PTY로 실증. 뮤턴트 6/6 RED | `57b7f4b6c` |
| P3-7a 승인 요약에 `check.argv` 노출 | **DONE** — 뮤턴트 3/3 RED | `d6eed6e6e` |
| P2-1 제품 예산 상한(파생, 조용한 clamp 아님) | **DONE** — 뮤턴트 5/5 RED | `30e3094c7` |
| P1-4 텔레메트리 | 남음 — `decision-counter-sink`의 예약된 `kind:"objective"` 재사용 + 턴 밖 사건 결정 |
| P2-5 주인 없는 rail | **DONE**(fork/verify/pause/render 테스트) | `0202570d3` |
| P2-6 PTY 배터리 | 남음 — 90초 목표 재설정 결정이 선행 |
| P3-7b 샌드박스 계약 | 남음 — 결정 필요 |
| 웹 objective 컨트롤 생산자 0 | 남음(어딧 B가 지적한 최대 누락: 웹은 goal을 읽기만 함) |
| 카탈로그 evidence 갱신 | 남음 — 오늘 추가된 8개 테스트/3개 소스 경로를 goal yaml에 반영해야 한다. 2026-08-30 시도했으나 동시 세션의 미커밋 `tools/feature-catalog/reachability.ts`가 생성물 `docs/10.feature-catalog.md`를 광범위하게 바꿔서, 내 yaml만 커밋하면 `fc diff`가 red가 되고 생성물까지 커밋하면 남의 in-flight 상태를 박제하게 된다 → **트리가 깨끗해진 뒤 재시도** |


## P0-1. 승인이 걸린 goal 턴은 **버려진다** (귀속 문제가 아니라 실행 자체가 안 됨)

> **정정 (2026-08-30 2차 어딧)**: 이 문서의 첫 판은 "재개 턴이 미귀속으로 돈다"고 적었다. **틀렸다.**
> 그 근거였던 프로브는 `runRuntimeTurn`을 host 레이어에서 직접 두 번 호출한 것이라, 실제로 사이에 서 있는
> **커널 리듀서 가드를 건너뛰었다**. 커널까지 태우면 재개 턴은 아예 시작되지 못한다.

**근거 (커널 e2e, 실측).** `tests/integration/goal-approval-resume-attribution-e2e.test.ts`(RED로 존재):
goal 턴을 `submitGoalContinuation`으로 보내고 → 도구가 승인을 요구해 멈춘 뒤 → 승인하면,
관측되는 이벤트는 `approval.resolved, session.state.updated` **둘뿐**이고 도구는 실행되지 않는다(`counts.n === 0`).
데몬 로그: `post-approval continuation turn.run settled without running {"error":"…empty_turn_input"}`.

기전:
- `turn.submit`은 draft를 만들지 않는다(`reducer.ts` `handleTurnSubmit`은 오히려 draft가 비어 있기를 요구하고 `command.text`를 직접 실행한다).
- 재개는 양쪽 경로 모두 **맨 `turn.run`**이다 — 데몬(`approval-continuation.ts`, `QUANTA_INLINE_APPROVAL_RESOLVER` 게이트 ON일 때)과 **기본값인 브라우저**(`apps/web-frontend/src/ws/session-hooks.ts`). `turn.run`은 `hasDraftTurnInput`이 false면 `empty_turn_input`으로 거부된다.
- 그 에러는 "benign duplicate"로 분류돼 INFO 로그로 삼켜진다(`approval-continuation.ts`).
- 정산은 이미 끝나 있다: 승인 일시정지가 attempt를 `awaiting_approval`로 settle하고 영속화한다(`turn-runner.ts`, 기존 테스트가 고정). 즉 **하드캡 1칸과 토큰은 소비했는데 일은 안 됐다.**
- 더 나쁜 것: `madeProgress`(`goal-wake-policy.ts`)는 `criterionTransitions`/`verifierReceiptRefs`만 본다 — `turnOutcome`을 안 본다. 그래서 `awaiting_approval` receipt가 **정체(stall)로 집계**돼 백오프가 15s→…→15분으로 늘고, 20회 후 하드캡이 소진된다.

**사용자 체감**: 승인 버튼을 눌러도 아무 일도 안 일어난다. `/goal work`(user-requested)는 재점화조차 없어서 영구히 멈춘다.

**설계 (option c — 커널이 재개를 소유).** (a) "재개를 `turn.submit`으로 다시 보낸다"는 **커널이 거부한다**: 승인 후에도 draft는 남아 있어 `turn_submit_draft_not_empty`에 걸린다(원래 턴이 `turn.run`이었던 경우). 그리고 기본 설정에서 재개를 하는 주체는 브라우저라 클라이언트가 capability를 만들 수도 없다. 따라서:
- 커널이 일시정지된 턴의 **prompt와 provenance를 상태에 보관**하고, 승인 후의 `turn.run`이 그것으로 재개한다(claim 포함). 클라이언트는 지금 보내던 프레임을 그대로 보내면 된다 ⇒ 와이어 변경 0, 드리프트 계약 무영향, 게이트 ON/OFF 양쪽 수정.
- 회계: 실행된 body마다 1 attempt(정직한 과금). 승인이 잦은 goal은 실효 하드캡이 절반이 된다는 점을 receipt에 명시한다.
- 함께 고칠 것: `madeProgress`가 `awaiting_approval`을 정체로 세지 않도록.
- **하지 말 것**: "`turn.submit`이 draft를 채우게 한다" — 드롭은 고쳐지지만 이 문서 초판이 잘못 주장했던 *미귀속 재개*를 실제로 만들어낸다.

**헬게이트 RED**(이미 존재, 실패 중): 승인 후 (i) 도구가 실제로 실행되고 (ii) receipts 2·turnsUsed 2 (iii) 재개 토큰이 예산에 반영. 뮤턴트: provenance 보관 제거 / 재개 claim 제거 / `awaiting_approval`을 다시 stall로 집계.
**크기**: medium. **의존**: 없음(option c 기준). **위험**: 커널 리듀서·스케줄러 seam.

## P0-2. manual 기준을 단 goal은 **영원히 완료되지 않는다** (사용자 attestation 프런트도어 0)

**근거.** 정책표는 user의 `markCriterion`을 허용한다(`policy.ts`, 행 `markCriterion | allow`), 타입도 user capability에 있다. 그런데
`grep -rn 'kind: "markCriterion"' src | grep -v '^src/objective/'` → **0**. CLI는 `criterion add`만 있고(`goal-cmd.ts`),
`GoalControl`에도 mark/complete가 없다. 웹은 objective mutate 생산자 자체가 0.
완료 판정은 `completionSatisfied`가 **모든** 기준 충족을 요구하므로(`policy.ts`), manual-only 계약은 만족될 수 없다.
모델이 `met:true`를 시도하면 `manual-attestation-required`로 거절된다.

**체감.** 렌더러가 "validation contract missing — add a check or criterion"이라고 안내하고, 그대로 `criterion add`를 하면
**완료 불가능한 계약**이 생긴다. goal은 예산/캡이 마를 때까지 계속 추적된다.
**할 일.** `/goal criterion done <n>`(또는 `/goal complete <n>`) → user `markCriterion`. 웹은 P2-web 항목으로.
**헬게이트 RED**: manual 기준 1개 goal → attest → `completionSatisfied` → completed. 뮤턴트: attest 경로 제거 / actor를 model로 위조(거절).
**크기**: small. **의존**: 없음.

## P0-3. 멈춘 attempt에서 빠져나올 방법이 없다 (`abandonAttempt` 생산자 0)

**근거.** `abandonAttempt`는 mutation union과 user capability, 정책, authority 핸들러까지 전부 있는데
`grep -rn 'kind: "abandonAttempt"' src` → **선언 1줄뿐, 생산자 0**. 한편 durable start가 남아 있으면
`replace`/`clear`는 `attempt-in-flight`로 거절된다(`policy.ts`, `authority.ts`).
**체감.** 크래시나 정산 실패로 attempt가 남으면 그 goal은 **수정도 삭제도 불가**가 된다(설계된 탈출구가 도달 불가).
**할 일.** `/goal abandon` 프런트도어 + `/goal` 리포트에 stuck 표시. **크기**: small.

## P2-1. 제품 예산 상한 부재 (P0에서 강등 — 자율 하드캡과 무관)

**근거 (프로브 실측).** `create`에 `{maxTurns: 1_000_000_000, maxTokens: 9_000_000_000}`를 넣으면
그대로 저장된다: `{"maxTokens":9000000000,"maxTurns":1000000000}`. `amendBudget`도 무검사 통과.
`src/objective/core-store/objective-ops.ts`는 `finiteNonNegInt`만 본다.

**왜 사라졌나.** GOAL-05A가 만든 `src/objective/budget-limits.ts`(`PRODUCT_BUDGET_CEILING`,
`clampBudgetLimit`)가 머지 `9b21d2fd2`에서 삭제된 뒤 복귀하지 않았다. 사건 자체는
`tests/unit/_arch/merge-symbol-loss-ratchet.test.ts`가 심볼 이름까지 들고 고정하고 있다.

**영향 한정.** 자율 하드캡(`GOAL_MAX_AUTONOMOUS_TURNS=20`, `goal-wake-policy.ts`)은 무관하게
살아 있으므로 **자율 폭주는 아니다**. 빠진 것은 유저가 스스로 적는 숫자의 sanity bound다.

**할 일 (형태 변경).** 삭제된 원본은 **조용한 `Math.min`**이었다(`git show 3c60751a2:src/objective/budget-limits.ts`).
그대로 되살리면 유저가 1,000,000을 넣었는데 `/goal`은 10,000을 보여주는 거짓말이 된다 — 이 캠페인이 `90ad48022`에서
정책 레이어에서 걷어낸 바로 그 형태다. 대신 둘 중 하나: (i) 초과 시 **타입드 거절**(한도를 말해주는 메시지), 또는
(ii) 저장은 정직하게 하고 집행 시 `min()` + `limitedBy: "product-budget-ceiling"`(기존 `BudgetLimitSource` 확장).
적용 지점은 3곳이 아니라 **4곳**: `cellFromDefinition`(create+replace 공용), `objective-ops.amendBudget`, 그리고 **`rehydrate.ts`**
(이미 저장된 1e9가 재시작으로 살아 돌아오면 유닛은 green인데 프로덕션은 거짓).
**헬게이트 RED**: create·replace·amend·restore 4경로 + 초과값이 사용자에게 **보이는지**(거절 메시지 또는 limitedBy).
**크기**: small~medium. **의존**: 없음.

---

## P1-3. 정산 후 체크포인트 리포트 방출 (GOAL-05A rail 16, 죽은 이월)

**근거.** 리포트 데이터 모델과 렌더는 있다 — `src/objective/progress-receipt.ts`,
`src/apps/cli/slash/goal-render.ts`가 `checkpoint:`/`last attempt:` 줄을 만든다. 그런데
**방출 훅이 없다**: CLI 세션 루프에서 정산 후 출력하는 코드는 0
(`src/apps/cli/repl/session-loop/*.ts`에 receipt 출력 없음; 유일한 소비처는
`interactive-setup.ts`가 continuation 프롬프트에 `progressReceipts.at(-1)`을 넣는 것).
05A receipt는 "06/10으로 이월"이라 적었고 **GOAL-06·GOAL-10 receipt 어디에도 언급이 없다**.

**왜 중요한가.** 유저 북극성이 agent state 가시성인데, 지금은 `/goal`을 쳐야만 진행이 보인다.
**할 일.** 정산 직후 1줄(결과·검증 카운트·다음 wake 사유) 방출. CLI stderr + 웹은 기존 obs 경로.
**헬게이트 RED**: 정산 후 방출 여부를 PTY 1케이스 + 유닛으로; 훅 제거 뮤턴트 RED.
**크기**: small~medium. **의존**: 없음(P1-4와 같은 자리를 건드리니 묶으면 이득).

---

## P1-4. 텔레메트리 — 결정 카운터와 label allowlist (GOAL-10 요구, 전량 미구현)

**근거.** `src/objective/**`, `src/apps/web-daemon/goal-*.ts`, `src/apps/cli/slash/goal-cmd.ts`에
카운터/`recordDecision`류 0. `tests/unit/observability/`에 goal label 테스트 0.
`src/observability/`에 objective 관련 프레임 0. GOAL-10 receipt도 이 항목을 주장하지 않는다.

**왜.** "왜 안 깨어났나"를 세는 수단이 현재 `/goal`의 `wake:` 한 줄뿐이라, 운영에서 빈도·분포를
못 본다. 티켓이 요구한 최소 집합: armed/canceled/skipped(reason) · enqueue admitted/rejected ·
attempt started/settled(outcome) · completion satisfied/rejected(reason) · verifier batch applied/stale.
**금지 사항도 티켓에 있다**: label에 goal text/thread id/attempt key 금지 → allowlist 테스트가 그 게이트.
**크기**: medium. **의존**: 방출 지점이 P1-3과 겹침.

---

## P2-5. 주인 없는 rail 닫기 (2026-08-30 실행됨 — 아래는 정정된 근거)

초판은 4개 rail 모두 "테스트 0"이라 적었다. 2차 어딧이 둘을 반증했고, 확인 결과 맞다:

| rail | 초판 주장 | 실제 | 조치 |
|---|---|---|---|
| GOAL-07 rail 12 (fork=paused clone) | 테스트 0 | **틀림** — `tests/unit/session-store.test.ts`가 공개 `forkSession` 시임으로 이미 단언 | 그래도 v1 분기·tombstone·blockers/attempts 초기화·check id 재키잉은 미커버라 `tests/unit/session/fork-objective.test.ts` 추가(뮤턴트 6/6 RED) |
| GOAL-04 rail 9 (pause가 재무장 억제) | 테스트 0 | **절반 틀림** — 정책 시임(`goal-wake-controller.test.ts`)이 이미 `goal-not-active` skip을 단언 | 미커버였던 "일시정지 중에도 비용은 기록된다" 절반을 host 시임에 추가(no-progress 백오프까지 함께 고정) |
| GOAL-04 rail 4 (`/goal verify` 무과금) | 테스트 0 | 맞음 | 추가(뮤턴트 2/2 RED: 검증이 turn을 쓰거나 verifier 포트를 우회하면 RED) |
| GOAL-05 rail 12 (렌더러 파생) | 단언 안 함 | **틀림** — 기존 1케이스가 이미 파생을 단언 | 그래도 "receipt 0 ⇒ checkpoint: none, receipt 추가 ⇒ 이동"이라는 파생성 자체는 미커버라 케이스 추가 |

**교훈(문서화)**: grep으로 "테스트 0"을 판정하면 다른 시임에서 이미 덮인 것을 놓친다. 시임 이름이 아니라 **행동**으로 찾아야 한다.

## P2-6. PTY 배터리 결손 (GOAL-05 E2E / GOAL-10 1~14)

**근거.** 현재 PTY 10케이스의 제목을 전수 확인했다. 있는 것: 등록/`QUANTA_GOAL=0` · 생성·렌더 ·
자율 continuation · quiet window · draft 취소 · foreground 재무장 · Ctrl+B · 프로세스 재시작.
**없는 것**: `check add → verify`(+stale) · pause/resume · edit · 예산 소진(`--max-turns=2`) ·
no-progress 간격 증가 · blocker 2/3→3/3 · zero-criteria 완료 거절 · attach thread B.

**측정 정정**: 초판의 "63초"는 한 번의 낙관적 실측이었다. 재측정 3회 — 84.7s / 103.1s / 113.5s(모두 10 pass).
즉 GOAL-06 티켓의 "≤90초"는 **새 케이스를 하나도 안 넣은 지금 이미 초과**다. 부팅 비용은 케이스당 ~6초 하한이고
(컴파일 바이너리로 바꿔도 6.33s로 동일 — 부팅은 CLI 자체 기동 비용), 8개를 그대로 추가하면 ~150초가 된다.
또한 그 90초는 **강제되는 게이트가 아니다**(`bun run e2e:pty`는 맨 `bun test`이고 속도 라쳇 없음).
**따라서 P2-6은 "묶기"가 아니라 순서가 하나 앞선다**: (1) 90초 목표를 실측 기준으로 재설정하거나 폐기할지 결정,
(2) 느린 케이스(22.4초짜리 idle continuation 등)를 integration으로 내릴지 결정, (3) 그 다음에 케이스 추가.
묶기는 진단 가능성을 해치므로(1 실패=5 후보) 기본값으로 삼지 않는다.
**크기**: large. **의존**: 위 결정.

---

## P3 — 코드보다 결정이 먼저인 것

**P3-7. GOAL-03 샌드박스 절반.** verifier는 `perCallWrap`을 넘기지 않는다
(`objective-verifier-wire.ts` `maybeWireObjectiveVerifier` → `createObjectiveCheckRunner()` 무옵션).
전역 슬롯이 있으면 그건 탄다(`run-argv.ts`: 슬롯 없으면 `sandboxedArgv = perCallArgv`,
상태는 `{applied:false, reason:"no-sandbox-installed"}`). 그 전역 슬롯은 **CLI가 `QUANTA_SANDBOX`를
켰을 때만** 설치된다(`src/apps/cli/sandbox-wire.ts` `installCliSandbox`, 기본 unset ⇒ 미설치)이고
웹 데몬은 호출조차 하지 않는다. 즉 **기본값에서 checked criteria 커맨드는 무샌드박스로 실행**되고,
verifier 자신은 정책을 요구하지도, 실패 시 fail-closed 하지도, posture를 기록하지도 않는다.
→ 티켓의 "읽기전용 실행 계약"을 되살릴지, "설치 슬롯 계약"으로 남길지 **결정 먼저**.

**P3-8. `tests/smoke/goal/`** — 없음(`tests/smoke/`엔 swebench·LSP만). 운영 측정용, ROI 낮음.
**P3-9. headless/batch goal** — `startGoalWakeController` 프로덕션 호출자는 2곳뿐
(`interactive-setup.ts`, `goal-wake-compose.ts`). 단 stdio door는 objective authority를 노출한다
(`serve-stdio-cmd.ts` `resolveGatedObjectiveAuthority`) — 없는 건 자율 추적뿐.
**P3-10. 웹 UI goal-work 버튼** — `sendGoalWork`/`onGoalWorkResult`는 있고
(`apps/web-frontend/src/ws/client.ts`) 호출하는 컴포넌트가 없다.

---

## 순서와 근거 (2026-08-30 3렌즈 어딧 반영)

1. **P0-1** — 유일하게 "승인해도 아무 일이 안 일어나는" 사용자 체감 결함이고, 커널 시임을 옮기므로 먼저.
   option (c)를 택하면 와이어 변경이 없어 드리프트 계약·프로토콜 재생성이 필요 없다.
2. **P0-2 / P0-3** — 각각 small이고 사용자가 막히는 dead end(완료 불가 / 수정·삭제 불가).
3. **P1-3 + P1-4** — 방출 시임을 **한 번만** 정한다(정산 지점 = `objective-settlement.ts`). 텔레메트리는
   이미 존재하는 `decision-counter-sink`의 **예약된 `kind:"objective"` arm**(생산자 0)을 재사용하고,
   턴 밖 사건(armed/skipped/verifier stale)만 별도 결정. 새 카운터 시스템을 처음부터 만들지 말 것.
4. **P2-1** — 형태 결정(거절 vs 파생 min) 후 4경로.
5. **P2-6 결정** → 그 다음 케이스 추가.
6. **P3-7a**(승인 요약에 `check.argv` 노출)은 결정 없이 지금 가능한 작은 보안 개선 — 3~4번 사이에 끼울 수 있다.

**제약(측정됨)**: `src/objective/authority.ts`가 951/1000줄이다. P2-1과 P1-4가 둘 다 그 파일에 붙으면 god-module
라쳇에 걸린다 — 새 모듈로 빼거나 먼저 분할한다.
