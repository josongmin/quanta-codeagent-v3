# GOAL-05 — CLI facade: /goal 단일 control, preset gate, status renderer


> **구현 대조 (2026-08-30, 코드 확인)** — 대부분 구현됐고 두 가지가 다르다.
> - `currentSourceStale`과 렌더러 `(stale!)` 마커는 **미구현**(`src/apps/cli/slash/goal-render.ts`는 `source: <digest>|unverified`만 출력). RED 9의 후반부는 검증 불가.
> - RED 8("`QUANTA_GOAL` 미설정 ⇒ `/goal` 미등록")은 2026-08-27 default-ON 승격으로 **반전**됐다. 현재 테스트(`tests/unit/cli/objective-frontdoor.hellgate.test.ts`)는 "미설정이면 등록된다"를 단언한다.
> - 파일 배치: 05A가 계획한 `src/apps/cli/goal/{goal-args,goal-control,goal-render}.ts`는 머지 `9b21d2fd2`에서 사라졌다. 실물은 `slash/goal-cmd.ts`(파싱+리포트) · `slash/goal-render.ts`(렌더러) · `slash/objective.ts`의 `buildGoalControl`(컨트롤). `--keep-contract`는 없다.
> - 게이트는 `cli-feature-gates.ts`가 아니라 `src/objective/goal-preset.ts`(`applyGoalPreset`) + `knobs-b.ts`가 소유한다.
> - E2E 체인 중 PTY에 있는 것은 set / 렌더 / criterion add / clear+재기동뿐 — `check add`,`verify`,`pause`,`resume`,`edit`는 PTY에 없다.

**Priority:** P1 · **Depends on:** GOAL-04 · **크기:** ~30 tool-use, main-direct

**구현 상태 (2026-08-25):** 완료. `/goal`과 deprecated `/objective`가 `GoalControl` 및
`renderGoalDomain`을 공유한다. budget은 user/system 전용 same-ID `setBudget`; criterion/check는
새 generation `replace`로 확정했다. `QUANTA_GOAL=1`은 명시 override를 보존하며 세 내부 gate만
seed하고, OFF에서는 두 command가 registry discovery에서 제외된다.

## 목적
`/goal`을 유일한 공개 명령으로 만들고 `/objective`는 같은 control을 쓰는 deprecated alias로 남긴다.
set/edit/pause/resume/clear가 authority 전이표와 1:1이 되게 하고, 상태 출력을 renderer 하나로 통일한다. 6개 내부 gate를 공개 preset 1개가 seed한다.

## 작업명세
### 파일
- `src/apps/cli/slash/objective.ts` — `buildObjectiveSlashState()` → `buildGoalControl()`:
  ```ts
  interface GoalControl {
    read(): ObjectiveDomainSnapshot & { validationContract; currentSourceStale: boolean }
    create(def: GoalDefinition): ControlOutcome; replace(def): ControlOutcome
    pause(): ControlOutcome; resume(): ControlOutcome; clear(): ControlOutcome
    addCriterion(desc: string): ControlOutcome; addCheck(desc: string, argv: readonly string[]): ControlOutcome; setBudget(b): ControlOutcome
    verify(): Promise<ControlOutcome>   // GOAL-03 runVerification
  }
  ```
  내부 prepare/commit 재사용. `ControlOutcome`은 commit 결과 + **재읽은 status**.
- `src/apps/cli/slash/goal-cmd.ts` — 파서만 남기고 control 호출:
  `/goal <text>`(기존 있으면 "use /goal edit"), `/goal`, `/goal edit <text>`, `/goal pause`, `/goal resume`, `/goal clear`(실삭제), `/goal stop`(pause alias),
  `/goal criterion add <desc>`(manual), `/goal check add <desc> -- <argv…>`(checked), `/goal budget --max-turns=N --max-tokens=N`, `/goal verify`. `MAX_GOAL_CHARS=4000` 유지.
- 정의 변경 규칙(원문): criterion/check/budget 변경도 definition 교체 = `replace` 경로 → 새 objectiveId, completion/verifier/progress 증거 제거, 사용자 명시 승인 시만. **판단 필요**: budget 상향만으로 verifier 증거를 버리는 건 과도해 보임 — 구현 전 결정: (a) 원문대로 전부 replace, (b) criterion/check 추가만 replace이고 budget은 same-ID amend(`setBudget` mutation, user/system만). 권장 (b), 결정은 티켓 시작 시 README에 기록.
  `/goal <text>`는 단일 CAS `create`(set+updateStatus 2회 제거).
- resume 메시지는 결과 status로 분기: active "Goal resumed" · blocked "Cannot resume: clear blocker first" · budget_limited "increase budget or edit" · usage_limited "Will resume after <t>" · completed "edit or create a new goal". "re-armed" 무조건 출력 제거.
- 신규 `src/apps/cli/slash/goal-render.ts` — renderer 1개:
  ```
  🎯 Goal: …
  status: active · rev 18 · id 7f3a…
  validation: 3/5 verified (contract: checked) | "validation contract missing — add a check or criterion"
  remaining: c4, c5   next: …   blocked: none | <waitingOn>
  budget: 8/20 turns · 24,812/100,000 tokens   last attempt: refusal · 2m ago (attempt 7f…)
  last verified: 5m ago · rev 16   checkpoint: rev 18 · 3 receipts   source: sha256:… (stale!)
  ```
  데이터는 `ObjectiveDomainSnapshot.progressReceipts`에서만(별도 log 없음). `/objective show`도 같은 renderer.
- 게이트: `src/apps/cli/cli-feature-gates.ts`에 `QUANTA_GOAL` 추가 — `"1"`이면 `QUANTA_OBJECTIVE_TOOLS=1, QUANTA_GOAL_ENFORCE=1, QUANTA_OBJECTIVE_BUDGET_ENFORCE=1`을 **미설정 시에만** seed(`cli-seeded-gates.ts` 메커니즘). `PROPOSE_GOAL`/`GOAL_JUDGE`/`GOAL_QUIET_MS`는 내부 override로 유지. help-render에 `QUANTA_GOAL` 1행, 나머지는 advanced.
  `QUANTA_GOAL` OFF면 `registry-session.ts`에서 `/goal`·`/objective` 미등록(discovery 제외; "not wired" 문구 제거).
- `src/apps/cli/repl/surface-compose/dispatch-compose.ts` — control 1개 mint, slash·wake·progress가 같은 인스턴스.

## RED
`tests/unit/goal-cmd-hellgate.test.ts`, `tests/unit/apps/cli/objective-slash*.test.ts`(존재 확인), 신규 `tests/unit/apps/cli/goal-render.test.ts`, `tests/unit/apps/cli/goal-gate-seed.test.ts`
1. `/goal a` 후 `/goal b` → 교체 안 됨, "use /goal edit" 안내, objectiveId 불변.
2. `/goal edit b` → objectiveId 변경, validation 0/0.
3. `/goal clear` → `readDomain.state === null`(paused 아님).
4. completed 상태 `/goal resume` → 거절 문구, status 불변.
5. blocked 상태 resume → "clear blocker first".
6. `/goal <text>`가 authority commit **1회**(spy).
7. `QUANTA_GOAL=1`만 설정 → 3개 내부 gate seed; 명시 `QUANTA_GOAL_ENFORCE=0`은 seed가 덮지 않음.
8. `QUANTA_GOAL` 미설정 → `/goal` 미등록, `/help`에 없음.
9. renderer: zero-criteria → "validation contract missing"; stale digest → "(stale!)".
10. `/objective pause`와 `/goal pause`가 동일 mutation(spy 인자 deep-equal).
11. `/goal criterion add x` → manual criterion 1개 추가, contract `manual-only`; 모델 markCriterion met:true 여전히 거절(GOAL-02).
12. renderer에 `last verified`/`checkpoint`가 progressReceipts·verifier receipt에서만 파생(별도 저장 0).

## E2E
- PTY `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` 확장: set → `/goal`(렌더 확인) → `check add` → `verify` → `pause`(wake 0) → `resume` → `edit`(id 변경) → `clear`(no goal) → 재기동 후 `/goal` no goal.
- 컴파일 바이너리: `bun run install:cli` 후 `~/.local/bin/quanta`로 같은 시나리오 1회(자산 parity).

## Proof rails
GOAL-04 rail + `bun test tests/unit/goal-cmd-hellgate.test.ts tests/unit/apps/cli`.

## 함정
- `CLI_FEATURE_GATES`는 default-OFF gate를 미설정 시 "1"로 seed하는 역가 있음(memory) — `QUANTA_GOAL` 자체는 seed 대상에서 제외. (2026-08-27 확정: GOAL-10 promotion 이후 `QUANTA_GOAL`은 **default ON**, `QUANTA_GOAL=0`이 공개 opt-out. 명시 내부 gate가 우선. README 결정 기록 참조.)
- knob 3계통(runtime-config / knob-inventory / feature-gates) 모두에 등록해야 `knob-inventory` 테스트가 통과.
