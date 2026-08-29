# aug-25 /goal v2 — 남은 작업 계획 (2026-08-30, 근거 명시)

이 문서의 모든 주장은 **오늘 main에서 직접 확인**한 것이다. 코드 주장은 `파일:심볼`,
행동 주장은 **프로브 실측치**를 함께 적는다. 추측은 "미측정"이라고 표시한다.
열린 항목의 요약 목록은 `README.md` "현재 상태"에 있고, 이 문서는 그 실행 계획이다.

---

## P0-1. 웹 승인 재개가 미귀속 — 예산/하드캡 밖에서 goal 작업이 돈다

**근거 (프로브 실측, 2026-08-30).** 실제 turn-runner를 승인 유발 도구로 돌렸다:

| 단계 | autonomousTurnsStarted | turnsUsed | tokensUsed | receipts | slot |
|---|---|---|---|---|---|
| goal 턴이 승인에서 멈춤 | 1 | 1 | 8 | 1 | empty |
| 승인 후 재개 턴(=데몬이 하는 `turn.run`) | **1** | **1** | **8** | **1** | empty |

재개 턴은 LLM 40+20 토큰을 쓰고 `completed`로 끝났는데 **어느 카운터도 움직이지 않았다.**

기전(코드):
- 승인 일시정지는 attempt를 그 자리에서 **정산**한다 — `turn-runner.ts` `runAgentSettled → ran.kind === "approval"` → `persistApprovalSettlement`. 기존 테스트가 고정: `tests/unit/host/turn-runner-objective-settlement.test.ts` "an approval pause durably settles once as `awaiting_approval`".
- 웹 재개는 provenance 없는 맨 턴이다 — `src/apps/web-daemon/server/approval-continuation.ts`가 `session.turn.run({commandId, causedByApprovalId}, {enqueue:true})`.
- `turn.run`은 절대 claim하지 않는다 — 커널 `claimGoalAttemptForTurn`은 `turn.submit`이 아니면 `undefined`. 고정: `tests/unit/kernel-turn-submit.test.ts` "turn.run (a plain user turn) never claims".

**영향.** 승인이 끼는 한 goal 작업은 무제한으로 무계량 진행된다(자율 하드캡은 최초 1회만 셈).
CLI는 해당 없음 — 승인이 턴 내부에서 해소돼 재개 dispatch 자체가 없다(`interactive-loop.ts`에 approval-resume 경로 0).

**할 일.** 재개를 귀속 턴으로 만든다. 결정 필요: (a) 재개 시 새 capability를 mint해 `turn.submit`으로 보내 새 attempt로 세거나, (b) 승인 구간 동안 attempt를 열어둔다. 현 정산 모델(승인=terminal)과 맞는 건 (a).
**헬게이트 RED**: 데몬 e2e — goal 턴 → 승인 → resolve → `autonomousTurnsStarted`/receipts가 정확히 2, 재개 턴의 토큰이 예산에 반영. 뮤턴트: 재개에서 claim 제거 → RED.
**크기**: medium(참고: round5 웹 goalWork 랜딩이 16파일). **의존**: 없음.

---

## P0-2. 제품 예산 상한 부재 — 유저가 임의 큰 예산을 넣을 수 있다

**근거 (프로브 실측).** `create`에 `{maxTurns: 1_000_000_000, maxTokens: 9_000_000_000}`를 넣으면
그대로 저장된다: `{"maxTokens":9000000000,"maxTurns":1000000000}`. `amendBudget`도 무검사 통과.
`src/objective/core-store/objective-ops.ts`는 `finiteNonNegInt`만 본다.

**왜 사라졌나.** GOAL-05A가 만든 `src/objective/budget-limits.ts`(`PRODUCT_BUDGET_CEILING`,
`clampBudgetLimit`)가 머지 `9b21d2fd2`에서 삭제된 뒤 복귀하지 않았다. 사건 자체는
`tests/unit/_arch/merge-symbol-loss-ratchet.test.ts`가 심볼 이름까지 들고 고정하고 있다.

**영향 한정.** 자율 하드캡(`GOAL_MAX_AUTONOMOUS_TURNS=20`, `goal-wake-policy.ts`)은 무관하게
살아 있으므로 **자율 폭주는 아니다**. 빠진 것은 유저가 스스로 적는 숫자의 sanity bound다.

**할 일.** create/replace/amendBudget 경로에 clamp 복귀 + 상한 상수 1곳.
**헬게이트 RED**: 상한 초과 create/amend가 clamp되는 유닛 3개 + clamp 제거 뮤턴트 RED.
**크기**: small. **의존**: 없음.

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

## P2-5. 주인 없는 rail 4개를 유닛으로 닫기

전부 "이월했는데 아무도 안 받은" 상태이고, 각각 **오늘 테스트가 0**임을 확인했다.

| rail | 내용 | 근거 |
|---|---|---|
| GOAL-04 rail 4 | `/goal verify`가 에이전트 턴을 소모하지 않음 | GOAL-05 티켓에 해당 rail 없음. verifier 테스트에 `turnsUsed` 참조 0(`tests/unit/host/objective-verifier-wire.test.ts`, `tests/integration/objective-verifier-real-command-e2e.test.ts`) |
| GOAL-04 rail 9 | pause가 비용은 기록하되 재무장을 막음 | 전용 테스트 없음(`attempt-lifecycle.test.ts`는 pause가 허용됨만 단언) |
| GOAL-07 rail 12 | fork = paused clone | `cloneObjectiveForFork` 구현돼 있으나 `tests/`에서 참조 0 |
| GOAL-05 rail 12 | 렌더러가 receipts에서만 파생(별도 저장 0) | 동작은 구현(`goal-render.ts`), `tests/unit/apps/cli/goal-render.test.ts`는 1케이스뿐이고 이를 단언 안 함 |

**크기**: 각 small(유닛 4개). **의존**: 없음. 값어치 대비 가장 싼 묶음.

---

## P2-6. PTY 배터리 결손 (GOAL-05 E2E / GOAL-10 1~14)

**근거.** 현재 PTY 10케이스의 제목을 전수 확인했다. 있는 것: 등록/`QUANTA_GOAL=0` · 생성·렌더 ·
자율 continuation · quiet window · draft 취소 · foreground 재무장 · Ctrl+B · 프로세스 재시작.
**없는 것**: `check add → verify`(+stale) · pause/resume · edit · 예산 소진(`--max-turns=2`) ·
no-progress 간격 증가 · blocker 2/3→3/3 · zero-criteria 완료 거절 · attach thread B.

**주의(측정된 제약)**: 이 파일은 이미 63초(10케이스)이고 GOAL-06 티켓의 "≤90초" 예산에 근접했다.
새 케이스는 **시나리오를 묶어** 1케이스로 만들어야 한다(예: check add→verify→pause→resume→edit 한 흐름).
**크기**: large(2웨이브 권장). **의존**: 없음.

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

## 순서와 근거

1. **P0-1 → P0-2**: 유일하게 "지금 틀린 숫자를 만드는" 항목들. P0-1은 프로브로 재현됨.
2. **P1-3 + P2-5**: 싸고(각 small) 값이 큰 묶음. P1-3은 북극성 직결, P2-5는 죽은 이월 정리.
3. **P1-4**: 방출 지점이 P1-3과 같아 이어서 하면 중복 작업이 없다.
4. **P2-6**: 느려서 뒤(웨이브 2회).
5. **P3-7 결정** → 필요 시 별도 티켓.

각 항목은 헬게이트 프로토콜로 간다: RED 먼저 → 구조 구현 → 적대 어딧(뮤턴트 포함) → receipt.
