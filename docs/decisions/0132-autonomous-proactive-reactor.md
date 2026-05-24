# ADR-0132 — Autonomous proactive reactor: SIMULATED_MSG_REASON + cloud-agent branch snapshot 사다리

- **Status**: Proposed (2026-05-24, W2 of [[0130-extracted-source-absorption-roadmap]])
- **Related**: [[smoke-fixture-system]] (자동화 트랙 reference), [[may-23-git-axis-absorption]] (git axis 흡수 1라운드), [[no-heuristics-only-validated]] (시뮬레이션 트리거는 검증된 외부 신호만)
- **References**:
  - Cursor `workbench.desktop.main.js`: `SIMULATED_MSG_REASON_{PLAN_EXECUTION, COMMIT_REMINDER, BACKGROUND_TASK_COMPLETION, DIFF_TAB_CREATE_PR, MULTITASK_SPLIT_PRS, BUILD_IN_PARALLEL, BABYSIT_PR_IN_CLOUD, CI_PANEL_INVESTIGATE_FAILURE}` (8 reasons)
  - Cursor `cursor-checkout/dist/main.js` line 167-217: `cursor/cloud-agent-{timestamp}-{rand}` 임시 branch + force-with-lease push
  - Cursor `cursor-commits/dist/main.js`: `babysit_pr_in_cloud_params` + `ConversationSummaryStrategy.ArbitrarySummaryPlusToolResultTruncation`

## Problem

우리 agent는 **사용자 prompt 이외로 turn 시작 불가**. 다음 케이스 모두 사용자가 손으로 trigger:

1. CI 실패 → 사용자가 "CI 실패 분석해" 입력
2. PR comment 달림 → 사용자가 "PR 코멘트 보고 응답해" 입력
3. background job 완료 → 사용자가 "끝났어? 다음 step 가" 입력
4. test 통과 → 사용자가 "OK 다음 task" 입력

Cursor (R1+R5 분석)는 **자기 자신에게 가짜 user message를 발화해서 self-wake** 패턴:
- 8 reasons: `PLAN_EXECUTION` / `COMMIT_REMINDER` / `BACKGROUND_TASK_COMPLETION` / `DIFF_TAB_CREATE_PR` / `MULTITASK_SPLIT_PRS` / `BUILD_IN_PARALLEL` / `BABYSIT_PR_IN_CLOUD` / `CI_PANEL_INVESTIGATE_FAILURE`
- producer side는 `cursor-checkout`이 **로컬 dirty changes를 `cursor/cloud-agent-{ts}-{rand}` 임시 branch에 stash → push → 클라우드에서 babysit → 결과는 SIMULATED_MSG로 self-wake**

전체 사다리: **로컬 dirty → temp branch snapshot → cloud babysit → 완료 시 self-simulated message → 다음 turn 자동 시작**.

## Decision

3-stage seam, **default-OFF** (env var `QUANTA_PROACTIVE_REACTOR=1` 필요):

### Stage 1: 외부 트리거 source 모듈 (closed-port, 1주 implement)

`src/reactor/trigger-source.ts` 신규:

```typescript
type TriggerReason =
  | "ci_completion"           // gh pr checks → completed event
  | "pr_comment"              // gh api ... new comment
  | "build_completion"        // background bash job exit
  | "diff_ready"              // git diff stable, awaiting review
  | "test_pass"               // pytest/jest exit 0
  | "manual_resume";          // user 직접 `/resume` 명령

interface ProactiveTrigger {
  reason: TriggerReason;
  evidence: { kind: "url" | "sha" | "log_path"; value: string };
  simulated_message: string;  // synthesized user message
  abort_signal: AbortSignal;
}
```

- **포트는 다 inject** ([[branch-search-adr0083]] closed-port pattern)
- evidence required — message 합성 시 file:line/url anchor 강제 ([[no-heuristics-only-validated]])
- abort signal로 사용자 interrupt 가능

### Stage 2: Cloud-agent branch snapshot (1주 implement)

`src/git/cloud-branch-snapshot.ts` 신규:

```typescript
async function snapshotDirtyToCloudBranch({
  branchPrefix = "quanta/cloud-agent-",
  pushRemote = "origin",
}): Promise<{ branch: string; sha: string }> {
  // 1. detect dirty (git status --porcelain)
  // 2. create temp branch `${prefix}${ts}-${rand}` (UUID v7 rand)
  // 3. add -A + commit -m "snapshot for cloud agent" (--allow-empty OK)
  // 4. push with --force-with-lease (NOT --force) — overwrite safety
  // 5. return branch + sha
}
```

- 메모리 [[may-23-git-axis-absorption]] HARD_DENY 9 rule 중 destructive force-push는 ban이지만, **`--force-with-lease`는 lease 검증 후만 overwrite** → 안전 ([[may-23-git-axis-absorption]] ADR-0100 destructive 정의 보강 필요)
- branch prefix `quanta/cloud-agent-`로 격리 — `git branch -D quanta/cloud-agent-*` cleanup 안전
- detached HEAD detection (Cursor 패턴) 추가

### Stage 3: Self-simulated message injection (2주 implement, 가장 careful)

`src/reactor/self-wake.ts`:

```typescript
async function injectSimulatedTurn({
  trigger,
  agentLoop,
}: {
  trigger: ProactiveTrigger;
  agentLoop: AgentLoop;
}): Promise<void> {
  // 1. hard guard: env QUANTA_PROACTIVE_REACTOR === "1"
  // 2. hard guard: 마지막 사용자 input 이후 ≥30초 (race condition 방지)
  // 3. hard guard: outcome enum (0131) 이 이전 turn = "success" 또는 "uncertain" (fail 시 자동 안 깨움)
  // 4. agentLoop.enqueueUserMessage(trigger.simulated_message + " [reason=" + trigger.reason + " evidence=" + trigger.evidence.value + "]")
  // 5. emit event "reactor.self_wake" with full trigger context (audit trail)
}
```

- **3 hard guard** (env, 30s, prior outcome)는 모두 closed-port — test로 강제
- simulated message에 reason/evidence 강제 inject — 후속 transcript에 audit
- "reactor.self_wake" event는 telemetry 전체 export (debugging)

### CI/PR 외부 트리거는 별도 process (`.quanta/reactor-watch.ts` script + cron) — agent loop와 분리

## Alternatives considered

1. **사용자 manual /resume 명령만** (no auto wake): rejected — Cursor 흡수 가치의 핵심이 사라짐. 단 manual은 `manual_resume` reason으로 같은 path 통과.
2. **Webhook server**: rejected for V1 — webhook 받으려면 public endpoint 필요, security 부담. CLI/desktop은 폴링 (cron + gh CLI).
3. **외부 trigger 없이 in-process auto-continue** (예: agent가 자기 판단으로 다음 turn): rejected — runaway loop 위험, [[no-heuristics-only-validated]] 위반 (검증된 외부 신호 없음).
4. **BugBot AUTO_MERGE 흡수까지**: rejected — [[0130-extracted-source-absorption-roadmap]] negative invariant 3 (auto-merge ban, verify discipline 충돌).

## Invariants preserved

1. **default-OFF**: `QUANTA_PROACTIVE_REACTOR=1` 없으면 모든 path inactive. byte-identical replay 보장 ([[codex-absorption-complete]]).
2. **3 hard guard** (env + 30s + prior outcome): runaway loop 불가능. abort signal 항상 wire.
3. **branch prefix isolation**: cloud-agent branch는 `quanta/cloud-agent-` prefix로 cleanup 안전. 메인 branch 절대 미터치.
4. **closed-port** ([[branch-search-adr0083]]): trigger source / git snapshot / self-wake 모두 inject. unit test로 mock 가능.
5. **smoke battery** ([[smoke-fixture-system]]): tier-0 replay에서 reactor OFF default. tier-1 신규 case "proactive" 카테고리 추가.
6. **`--force-with-lease` only**: `--force`는 절대 안 씀. lease 검증 실패 시 trigger abort.

## Tradeoffs

- **외부 trigger 폴링 cost**: cron + gh CLI로 CI/PR 폴링은 분당 1~2 API call. GH API rate-limit (5000/hr) 안전. 다만 large org에서 100 PR 폴링 시 차오름. mitigation: workspace 단위 폴링, 글로벌 X.
- **simulated message가 transcript에 섞임**: user message로 보임. mitigation: `[reason=X evidence=Y]` suffix 강제 + reactor.self_wake event로 audit trail. UI에서 system message로 별도 렌더 가능.
- **branch snapshot은 disk write**: 큰 working tree (>1GB) 시 commit 느림. mitigation: HARD_DENY pre-check로 `>500MB diff`는 reject + 사용자 명시 opt-in.
- **`--force-with-lease`도 race condition 가능**: 두 reactor 인스턴스가 동시 push 시 한쪽 reject. mitigation: file lock (`.quanta/cloud-snapshot.lock`) + 30s timeout.
- **메모리 [[may-23-git-axis-absorption]] HARD_DENY와 충돌 우려**: ADR-0100의 "destructive 9 rule"에 `--force-with-lease`도 포함? — **확인 필요** (이 ADR 채택 전 ADR-0100 review).

## Out of scope (deferred)

- **Webhook server (in-process)**: V2. 현재는 외부 cron + gh CLI.
- **BugBot 완전 흡수** (AUTO_PR + AUTO_MERGE): [[0130-extracted-source-absorption-roadmap]] negative invariant 3, 영구 deferred.
- **Multi-tenant cloud agent infra**: enterprise V3, 현재는 single-user.
- **PR comment 응답 auto-draft**: 별도 ADR (W7 connectors REST API와 합쳐서 GitHub connector 안에).
- **Cancel/pause UI**: V2. 현재 abort_signal로 process-level만.

## Validation (post-implementation)

- [ ] smoke battery 신규 "proactive" 카테고리 5 case (각 trigger reason 1+) all pass
- [ ] reactor OFF 기본값일 때 모든 기존 smoke pass (byte-identical)
- [ ] reactor ON일 때 30s guard 작동 (race condition unit test)
- [ ] cloud-agent branch cleanup `git branch -D quanta/cloud-agent-*` zero-residue 확인
- [ ] reactor.self_wake event count <50/day per workspace (runaway 안전 margin)
- [ ] simulated message에 reason/evidence suffix 100% 존재 (lint check)
