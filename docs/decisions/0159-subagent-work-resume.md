# ADR-0159: Subagent work-resume Phase 2 — interrupted-handle orchestrator

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0145 (background subagent scheduler — in-memory foundation), ADR-0153 (serialize/hydrate JSON), ADR-0158 (Phase 1 — disk-backed store + `"interrupted"` arm — **predecessor**)
- **참조**:
  - `src/agent/subagent-resume/policy.ts` — `ResumePolicy` port + `defaultResumePolicy(opts)` / `alwaysResumePolicy` / `askUserResumePolicy` 3 stock 정책.
  - `src/agent/subagent-resume/resumer.ts` — `resumeInterruptedHandles({scheduler, store, policy, workspace, now?})` orchestrator. NO-THROW per handle.
  - `src/agent/subagent-resume/index.ts` — 배럴.
  - `src/agent/subagent-persistence-store/types.ts` — 이미 `PersistedSubagentStatus` 에 `"resumed"` arm 정의 (ADR-0158 Phase 1 시점에 미리 선언, Phase 2 가 채움).
  - `tests/unit/subagent-resume-hellgate.test.ts` (22 case).

## 맥락

ADR-0158 Phase 1 이 `"interrupted"` arm 까지 honest 하게 surface 했지만 **caller 가 그 다음에 무엇을 해야 하는가** 가 미정의였다:

- A. 그냥 두면 disk 에 `"interrupted"` 로 영원히 남음 — `list()` 에 stale entry 누적.
- B. 자동으로 모두 re-fork: 위험. 원래 interruption 이 **그 작업 자체**가 원인일 수 있음 (looping tool, OOM, 의도적 kill).
- C. 모두 user prompt: noisy. 명백히 idempotent 한 작업도 매번 묻는다.

Phase 2 는 이 결정 surface 를 **closed port + 3 stock policy** 로 추출한다. orchestrator 는 pure mechanics — 정책이 무엇을 결정하든 동일하게 실행한다.

**왜 closed-port + injected policy**:
- 정책은 caller 별로 다를 수밖에 없음 (CLI 는 `defaultResumePolicy`, CI 는 `alwaysResumePolicy`, GUI 는 `askUserResumePolicy`).
- 정책이 pure function (`decide(handle): ResumeDecision`) — 모든 결정이 testable + auditable.
- orchestrator 와 정책이 분리되어 정책 변경이 orchestrator 회귀를 일으키지 않음.

## 결정

### 1. Closed port: `ResumePolicy`

```ts
type ResumeDecision =
  | { action: "resume"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "mark-failed"; reason: string }
  | { action: "ask-user"; promptHint: string }

interface ResumePolicy { decide(handle: PersistedHandle): ResumeDecision }
```

`decide` 는 PURE (no I/O). 4-arm decision 으로 surface 가 완전 enumerable.

### 2. Stock policies (3)

- **`defaultResumePolicy(opts)`** — conservative.
  1. `spec.metadata.idempotent === "true"` → `"resume"` (caller opt-in 이 staleness 검사보다 우선).
  2. `now - startedAt > maxAgeMs` (기본 24h) → `"mark-failed"`.
  3. `spec.maxTurns` 있고 `turns / maxTurns >= staleTurnsRatio` (기본 0.8) → `"mark-failed"` (likely looped).
  4. 그 외 → `"skip"`.
- **`alwaysResumePolicy`** — power user / test. 무조건 `"resume"`.
- **`askUserResumePolicy`** — most conservative. 항상 `"ask-user"` + `promptHint` 에 task head + turns + startedAt 포함.

**왜 idempotent='true'-marker 가정**: subagent caller 가 spec author 다. 본인이 멱등이라고 선언하지 않은 작업을 host 가 자동으로 멱등 추론할 방법은 없다 (semantic 정보 부재). 명시적 opt-in 이 honest.

### 3. Orchestrator: `resumeInterruptedHandles`

```ts
resumeInterruptedHandles({scheduler, store, policy, workspace, now?})
  → Promise<ReadonlyArray<ResumeOutcome>>
```

**Flow**:
1. `store.list(workspace)` → `status === "interrupted"` 필터.
2. 각 handle 에 대해 `decision = policy.decide(handle)`.
3. Decision 별 applied effect:
   - `"resume"` → `scheduler.fork({...spec, metadata: {...metadata, resumedFrom: id}})` → newId. OLD handle 을 `"resumed"` (6th arm) 로 flip 하고 `outputSummary = "resumed as <newId>"` 로 store.save. endedAt = now().
   - `"skip"` → no-op.
   - `"mark-failed"` → store.save({...handle, status: "failed", endedAt: now(), errorMessage: decision.reason}).
   - `"ask-user"` → no-op. outcome.decision.promptHint 를 surface 가 렌더.
4. 각 handle 별 결과를 `ResumeOutcome[]` 으로 수집.

**NO-THROW per handle**: `policy.decide` / `scheduler.fork` / `store.save` 가 throw 하면 catch 해서 `outcome.errorMessage` 에 packaging, iteration 계속. `store.list` 만 bubble (disk-level 실패는 caller 책임).

### 4. `"resumed"` 6th arm (ADR-0158 types.ts 에 이미 선언)

`PersistedSubagentStatus = SubagentStatus | "interrupted" | "resumed"`. 6번째 arm `"resumed"` 가 `"completed"` overload 보다 honest:
- `list` filter 가 prose-parsing 없이 단일 arm 으로 branch 가능.
- `outputSummary = "resumed as <newId>"` 가 chain 을 한 hop 으로 따라갈 수 있는 mechanical link.
- newly-forked handle 의 `spec.metadata.resumedFrom = oldId` 가 역방향 chain 도 mechanical 하게 따라갈 수 있게 한다.

대안 거절: `"completed"` arm 에 `outputSummary: "resumed as <newId>"` 만 적기 — prose-parse 필요, list-filter 가 어색.

## 계약 (5)

1. **`policy.decide` PURE**: I/O 금지. 모든 입력이 `PersistedHandle` 단일 인자, 출력은 4-arm `ResumeDecision`. caller 가 mock 으로 강제 가능.
2. **NO-THROW per handle**: `applyDecision` 의 모든 실패 (`scheduler.fork` cap-exceeded / `store.save` io-failed / `policy.decide` throws) 가 catch 되어 `outcome.errorMessage` 로 surface. iteration 계속. `store.list` 실패만 bubble (disk-level → caller 결정).
3. **`spec` preservation**: resumed-fork 의 spec 은 OLD handle 의 spec 을 모든 optional 포함 wholesale 복사 (`modelOverride` / `maxTurns` / `workspace` / `metadata`). `metadata.resumedFrom = oldId` 만 merge — 기존 metadata 키는 보존, `resumedFrom` 만 overwrite.
4. **exactOptionalPropertyTypes**: `ResumeOutcome` 의 `newId` / `errorMessage` 는 absent 시 OMITTED, never `undefined`-set. `markResumed` / `markFailed` 가 OLD handle 의 모든 optional 을 보존.
5. **Default-OFF**: 본 슬라이스 어떤 코드도 loop / dispatch / apps bootstrap 에 자동 wire 안 됨. ADR-0145 (`subagent-background.ts`) / ADR-0158 byte-identical. 사용은 caller 가 `resumeInterruptedHandles({...})` 명시적 호출.

## Hellgate (22 case)

`subagent-resume-hellgate.test.ts`:

- **A. defaultResumePolicy** (8):
  - HG-01 idempotent='true' → resume.
  - HG-02 age > 24h → mark-failed.
  - HG-03 turns/maxTurns ≥ 80% → mark-failed.
  - HG-04 turns/maxTurns < 80% → skip.
  - HG-05 fresh + low + no marker → skip.
  - HG-06 idempotent='true' + very old → resume (idempotent 가 age 보다 우선).
  - HG-07 opts.maxAgeMs override (1h) → 2h-old → mark-failed.
  - HG-08 opts.staleTurnsRatio=0.5 → 60% → mark-failed.

- **B. alwaysResume + askUser** (3):
  - HG-09 alwaysResume → resume on stale handle.
  - HG-10 askUser promptHint 가 id + task 포함.
  - HG-11 long task → 80자 cap + `…` 삽입.

- **C. resumeInterruptedHandles** (11):
  - HG-12 no interrupted → `[]`.
  - HG-13 resume → fork called + outcome.newId set.
  - HG-14 skip → no fork, no save.
  - HG-15 mark-failed → store.save with status=failed + errorMessage + endedAt.
  - HG-16 ask-user → no scheduler call, promptHint surfaced.
  - HG-17 scheduler.fork throws → outcome.errorMessage, iteration continues.
  - HG-18 mixed 3 (resume/skip/mark-failed) → 3 outcomes in order.
  - HG-19 resume → OLD handle saved with status='resumed' + outputSummary='resumed as <newId>'.
  - HG-20 resume → newly-forked spec.metadata.resumedFrom = oldId, 다른 metadata 키 보존.
  - HG-21 cross-workspace → 다른 workspace 의 interrupted 무시.
  - HG-22 policy.decide throws → outcome.errorMessage, iteration continues.

총 22 pass / 0 fail. ADR-0145 의 20 case + ADR-0158 의 31 case 도 byte-identical 유지.

## Default-OFF / byte-identical

- `subagent-background.ts` / `subagent-persistence-store/*` (ADR-0158 의 4 파일) 모두 1줄 미수정. `types.ts` 의 `"resumed"` arm 은 Phase 1 시점에 미리 선언된 것 — 본 슬라이스가 추가하지 않음.
- 본 슬라이스 어떤 모듈도 `apps/agent` bootstrap 에 자동 wire 안 됨. caller 가 `resumeInterruptedHandles` 를 명시적 호출해야 효과 발생. CLI command 와이어는 별도 sibling PR.

## Alternatives rejected

1. **Auto-resume all interrupted handles unconditionally**. 거절: 원래 interruption 의 원인이 자기 자신 (looping tool, OOM) 일 수 있음 — 자동 replay 가 사고를 반복. `defaultResumePolicy` 가 `idempotent='true'` opt-in 으로 caller 책임 명시.
2. **HEURISTIC 으로 idempotency 추론** (e.g. "read-only tool 만 썼으면 idempotent"). 거절: ADR-0044 의 negative invariant — semantic 정보 없이 휴리스틱 추론 금지. caller 가 spec author 이므로 spec 에 명시.
3. **Resume by REPLAYING transcript** (Codex `archived_sessions` style). 거절: scope creep. Phase 2 는 `spec.task` 로 fresh fork 만 함. transcript replay 는 Phase 3 후속.
4. **`"completed"` 에 `outputSummary: "resumed as <newId>"` 을 끼워넣기**. 거절: prose-parse 필요. 6th arm `"resumed"` 가 mechanical branch enabling.
5. **Block on user confirmation in orchestrator**. 거절: orchestrator 는 pure mechanics. `"ask-user"` decision 은 surface (CLI / Web) 가 렌더 — orchestrator 가 stdin 을 읽지 않음.
6. **Per-handle parallel `Promise.all`**. 거절: scheduler.fork 의 cap-exceeded 가 throw — sequential 이라야 다음 handle 의 fork attempt 가 의미 있다 (앞 fork 가 cap 안에 들어왔는지). semantic-deterministic order.

## SOTA matrix

| Agent | "Interrupted" detection | Auto-resume safety gate | Explicit user-confirm seam |
|---|---|---|---|
| Cursor 3.2.16 | ❌ (in-memory only) | — | — |
| Codex 0.131 | partial (session JSONL) | ❌ | — |
| Claude Code 2.1 | — (sequential subagent) | — | — |
| v0.dev | — | — | — |
| **quanta (ADR-0158)** | ✅ | — | — |
| **quanta (본 ADR)** | ✅ | ✅ `idempotent='true'` opt-in + 24h age + 80% turn-ratio guard | ✅ `askUserResumePolicy` |

## Follow-up (본 ADR 이 닫지 않는 것)

- **Apps/agent bootstrap wire** — CLI `/resume` slash command, system-skill `subagent-resume`. sibling PR.
- **Transcript replay** — Phase 3. spec.task 로 fresh fork 가 아니라 OLD transcript 마지막 turn 부터 이어쓰기. 새 ADR.
- **Per-policy observability** — outcome stream 을 OTel span 으로 surface (ADR-0074 span tree).
- **Encrypted-at-rest spec.metadata** — `idempotent='true'` marker 가 secret 포함하지 않도록 caller 가이드라인. 별도 ADR.
- **`mark-failed` for spec.metadata.do-not-resume='true'`** — 5번째 fast-path decision. Phase 2 후속에서 추가 검토.
