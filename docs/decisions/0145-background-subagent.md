# ADR-0145: Background subagent scheduler — Cursor `force_background_subagent` 흡수

> **Renumbered 2026-05-24** from ADR-0130 due to collision with `0130-extracted-source-absorption-roadmap.md`. User roadmap kept the original number; this slice moved to 0145. Historical cross-refs in `src/`/`tests/` may still read "ADR-130".

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0083 (branch-search — sibling fork pattern), ADR-0128 (plan-queue helper), ADR-0124 (conversation-checkpoint store), ADR-0125 (turn-diff wiring consolidation) — 모두 helper-only deferred-wire family
- **SOTA 출처**: Cursor `force_background_subagent` + `subagent_await` (sole industry pattern — Codex / Claude Code 2.1 / v0.dev 모두 sequential subagent only)
- **참조**: `src/agent/subagent-background.ts`, `src/tool/subagent-bg/`, `src/agent/tier1/subagent-bg.ts`, `tests/unit/subagent-background-hellgate.test.ts`

## 맥락

오늘 quanta의 subagent 슬라이스 (`src/subagent/`)는 **sequential**: parent의 `agent` 툴 호출이 child를 spawn하고 child가 끝날 때까지 parent loop가 **block**된다. 99% equivalent로 "multi-call orchestration" (parent가 `task_spawn` + `task_output` polling을 직접 driving)이 가능하지만, **structural background detach가 없다**. parent loop가 멈춰 있는 동안 다른 일을 못 한다.

Cursor의 `force_background_subagent`는 유일한 industry 패턴:
- `force_background_subagent(prompt)` → handle id 즉시 반환, parent loop 계속
- `subagent_await(handle)` → 나중에 결과 harvest
- 진정한 "go check CI for 30min while I keep coding" workflow

**다른 modern agent는 전부 없다**:
- Claude Code 2.1 — Task tool은 sequential (parent block)
- Codex 0.131 — 6-subagent tool (`spawn_agent`/`wait_agent`)이 있지만 wait는 blocking; closer to PTY 모델
- v0.dev — subagent 자체가 없음

quanta는 ADR-0011 subagent 슬라이스가 있지만 fork-then-block 모델이다. 본 ADR이 그 갭을 닫는다.

## 결정

신규 plane-clean 모듈 3개:

### 1. `src/agent/subagent-background.ts` (~310 LOC)

```ts
interface BackgroundSubagentScheduler {
  fork(spec: SubagentSpec): SubagentHandleId       // 즉시 handle 반환
  poll(id): SubagentResult | null                  // non-blocking
  await(id, opts?): Promise<SubagentResult | null> // blocking; optional signal
  cancel(id): boolean                              // idempotent
  list(): ReadonlyArray<{id, result, spec}>        // observability
  prune(maxAgeMs): number                          // terminal entry GC
}

class SubagentBackgroundError extends Error {
  code: "cap-exceeded" | "unknown-handle"
}

const defaultBackgroundSubagentScheduler = (opts: {
  runner: SubagentRunner            // 주입 — 실 subagent 실행자
  maxConcurrent?: number            // default 3
  maxRetained?: number              // default 32 (terminal LRU)
  now?: () => number                // default Date.now
  idGen?: () => string              // default crypto.randomBytes(8).hex
}) => BackgroundSubagentScheduler
```

4-arm `SubagentStatus`: `running | completed | failed | cancelled`. 상태 전이는 단방향 — `running → {completed, failed, cancelled}`, 그 후 terminal.

### 2. `src/tool/subagent-bg/` (~3 tool files + port + barrel)

LLM-facing 3 툴:
- `subagent_fork({task, modelOverride?, maxTurns?, metadata?})` → ok:true `"forked id=bg-xxx"`; cap-exceeded ⇒ ok:false `"cap-exceeded: …"`
- `subagent_poll({id})` → ok:true 멀티-라인 status; unknown ⇒ ok:false `"unknown-handle: …"`
- `subagent_await({id, timeoutMs?})` → timeout ⇒ ok:true `status=running`; complete ⇒ ok:true `status=completed` + full detail

HITL tier: `fork="pre-approval-ok"` (REVERSIBLE — cancel 가능), `poll`/`await` 기본 추론 (read-only).

`@/tool` slice fence: duck-typed `BackgroundSubagentSchedulerPort` mirror in `port.ts` — `@/tool`은 `@/agent`를 import하지 않는다.

### 3. `src/agent/tier1/subagent-bg.ts` builder

`buildShadowBlock` 모양 그대로:
```ts
buildSubagentBgBlock(config) = config.subagentBackground?.scheduler ? subagentBgTools(scheduler) : []
```

Caller wire는 deferred (0125-pattern): `AgentConfig.subagentBackground?: { scheduler }` 슬롯은 sibling PR에서 추가. 그 전까지 본 빌더는 duck-typed 구조적 cast로 슬롯을 읽는다.

## 계약 (6)

1. **NO-THROW 공개 surface**. `await`/`poll`/`cancel`/`list`/`prune` 절대 throw 안 함. subagent 실패는 `result.status==="failed"` + `errorMessage`로. `fork()`만 `SubagentBackgroundError("cap-exceeded")` typed throw (caller가 deterministic하게 branch 가능).
2. **인메모리 PURE**. `Map<handleId, entry>`. 0 I/O, 0 SQLite. process restart 시 사라짐 — persistence는 Phase 2.
3. **exactOptionalPropertyTypes**. `outputDetail`/`errorMessage`/`endedAt`/`modelOverride`/`maxTurns`/`workspace`/`metadata` 미설정 시 key 자체 OMITTED — never `undefined`-set (HELL-21 검증).
4. **CANCELLATION**. handle마다 자기 `AbortController` 소유. `cancel()`이 fire → 동기적으로 `status="cancelled"` flip + `endedAt` 기록 + abort signal trigger. runner의 in-flight promise는 그 후 cancel 상태를 유지하며 resolve. Idempotent.
5. **LRU eviction**. `maxRetained` 초과 시 **terminal entries만** drop (oldest insertion-order first). running entries는 **절대 auto-drop 안 함** (in-flight promise를 깨면 caller의 await가 깨진다).
6. **AWAIT SIGNAL은 cancel이 아니다**. `await(id, {signal})`가 signal abort로 깬다 = 현재 snapshot 반환 + subagent는 **그대로 실행 중**. caller가 명시적으로 `cancel()` 호출해야 actual cancel. "지쳐서 더 안 기다림" vs "죽여라"가 분리된 surface (HELL-6 검증).

## Default-OFF

이 슬라이스를 **자동으로 wire하는 곳 없음**. `AgentConfig.subagentBackground` 슬롯은 sibling PR에서 추가될 예정 — 그 전까지 `buildSubagentBgBlock`는 duck-typed cast로 슬롯이 부재하면 `[]` 반환 → ToolRegistry는 byte-identical. 모든 기존 caller에 zero regression.

미래 consumer 후보:
- **apps/agent bootstrap** — `defaultBackgroundSubagentScheduler({runner: createSubagentRunner(...)})` 생성 + AgentConfig에 주입
- **CLI `/spawn-bg` slash command** — long-running task을 detach (e.g. `/spawn-bg "loop on CI until green"`)
- **Plan-queue 통합 (ADR-0128)** — `pausedReason="subagent_running"` 을 본 scheduler의 running list와 sync

## Hellgate (23 cases)

`tests/unit/subagent-background-hellgate.test.ts` 가 4 cluster로 봉인:

- **A. scheduler core (10)**: fork-happy / cap-exceeded throw / poll-unknown null / await-unknown null / await-running waits / await-signal returns snapshot (no cancel) / cancel→cancelled / cancel-unknown false / list cross-status / prune drops terminal only
- **B. runner integration (4)**: runner-ok→completed+detail / runner-reject→failed+errorMessage / runner-abort→cancelled / multi-concurrent fork
- **C. tools (6)**: fork ok / fork cap-exceeded ok:false / poll ok / poll unknown ok:false / await timeout ok:true running / await happy ok:true completed
- **D. invariants (3)**: exactOptional fields omitted / idGen+now injection / cancel-after-terminal idempotent

전부 인메모리 (controllable fake runner). 23 pass / 0 fail.

## Alternatives rejected

1. **Promise-only API (no handle id)** — 관측성/취소 surface 손실. 두 번째 `await` 호출이 같은 작업을 가리킬 방법이 없고, `list()` 같은 introspection도 못 함. Handle은 cheap (16 hex chars).
2. **Auto-await at turn end** — "long-running"의 본래 목적 (turn 경계 가로지르기) 무력화. parent가 다음 turn에서 다른 일 하다가 N turn 뒤에 harvest하는 게 정확한 use case.
3. **Thread pool / OS threads** — JS는 single-threaded. concurrency는 promise overlap으로 model. worker_threads 도입은 IPC 복잡도 + serialization 비용 + ToolRegistry 공유 불가 → 가치 < 비용.
4. **Persistent handles across process restart** — 흥미롭지만 scope creep. 인메모리는 plane-clean; persistence는 ADR-0037 `followUpQueueSnapshotStore` 패턴 차용해 별도 ADR.
5. **Cancel auto-fires on await-signal abort** — "지쳐서 그만 기다림"과 "죽여라"를 conflate. UI에서 progress bar 누르고 떠나는 것이 작업 자체를 죽이는 게 아니다. 분리된 surface가 옳다 (Cursor도 동일 분리).
6. **Re-use ADR-0011 `agent` tool with `detach:true` flag** — 같은 툴의 두 모드는 LLM이 헷갈리는 prompt surface. 명시적 `subagent_fork` + `subagent_await`가 Cursor도 따른 분리 — semantic clarity 우선.

## SOTA++ 자리매김

| Agent | Background fork | Handle id | Cancel | List/observability | Typed error code |
|---|---|---|---|---|---|
| Cursor 3.2 | ✅ `force_background_subagent` | ✅ | ✅ | partial | ❌ (prose) |
| Codex 0.131 | partial (`spawn_agent`+blocking `wait_agent`) | ✅ | ✅ | ❌ | ❌ |
| Claude Code 2.1 | ❌ (Task sequential) | — | — | — | — |
| v0.dev | ❌ (no subagent) | — | — | — | — |
| **quanta (본 ADR)** | ✅ helper (deferred-wire) | ✅ `bg-<16hex>` | ✅ idempotent | ✅ `list()`+`prune()` | ✅ `SubagentBackgroundError.code` closed-union |

= "Cursor의 background-subagent surface를 closed-port + typed error code + 관측성 surface로 흡수한 첫 helper primitive". Cursor의 모델보다 typed error + list/prune까지 더한 SOTA++.

## Follow-up (이 ADR이 닫지 않는 것)

- **Caller wire** (sibling PR): `AgentConfig.subagentBackground?: { scheduler }` 슬롯 + `apps/agent` bootstrap에서 `defaultBackgroundSubagentScheduler(...)` 생성 + `FeaturesConfig` Pick 갱신
- **Persistent scheduler**: process restart 살아남게 JSONL/SQLite 백업. `followUpQueueSnapshotStore` 패턴.
- **Per-thread queueing**: 현재는 process-global. multi-session/multi-thread surface 진입 시 thread별 isolation.
- **Plan-queue integration**: `pausedReason="subagent_running"` 을 본 scheduler의 running list 기반으로 자동 set (ADR-0128 consumer wire).
- **`subagent_cancel` tool**: 본 ADR에서는 scheduler에 method만 노출, LLM-facing tool은 미포함. mid-turn-steering wire 정착 후 결정.
- **Progress streaming**: 현재는 terminal status 전까지 `outputSummary="(running)"` static. runner가 progress event를 emit하면 update하는 surface 필요.
