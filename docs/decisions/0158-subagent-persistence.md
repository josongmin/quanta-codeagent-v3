# ADR-0158: Subagent persistence Phase 1 — disk-backed store + interrupted arm

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0145 (background subagent scheduler — in-memory foundation), ADR-0153 (serialize/hydrate JSON + disk helper, **single-file** snapshot — predecessor), ADR-0108 (shadow-odb workspace-hash policy — directory layout 참조)
- **참조**:
  - `src/agent/subagent-persistence-store/types.ts` — closed-port `PersistentSchedulerStore`, `PersistedHandle`, `PersistenceError`, `PersistedSubagentStatus = SubagentStatus | "interrupted"`.
  - `src/agent/subagent-persistence-store/jsonl-store.ts` — `defaultJsonlSchedulerStore` JSONL-on-disk adapter (`<baseDir>/<workspaceHash>/<handleId>.jsonl`, append-only, last-line-is-current).
  - `src/agent/subagent-persistence-store/hydrating-scheduler.ts` — `persistentBackgroundSubagentScheduler` 가 ADR-0145 인메모리 scheduler 를 wrap, hostPid liveness check 로 `"running" → "interrupted"` 재분류, fork/cancel/runner-complete 마다 save-through.
  - `src/agent/subagent-persistence-store/index.ts` — 배럴.
  - `tests/unit/subagent-persistence-jsonl-hellgate.test.ts` (16 case), `tests/unit/subagent-persistence-hydrate-hellgate.test.ts` (15 case).

## 맥락

ADR-0153 가 `serialize()` / `hydrate()` JSON primitive + 단일 `snapshotToFile` helper 를 살렸지만 2 가지 갭이 남았다:

1. **Single-file snapshot 의 부재 윈도우**: caller 가 periodic OR shutdown-handler 로 `snapshotToFile` 을 호출하므로 직전 snapshot 이후 ~N 초 전체가 디스크에 없다. 30 분짜리 detached subagent 가 시작 직후 process kill 되면 **handle 자체가 사라진다**.
2. **"Running" handle 의 honesty 부족**: ADR-0153 hydrate 는 모든 running 을 `failed + "lost across restart"` 로 동일 처리. 사실은 두 가지를 구분해야 한다:
   - **원래 host process 가 살아있음** (PID alive): subagent 가 진행 중일 가능성, runtime ownership 이 그 process 에 있음.
   - **원래 host process 가 죽었음** (PID dead OR PID 없음): 작업이 확실히 끊겼다 — `interrupted` 라는 별도 5번째 arm 으로 honest 표현.

본 ADR 은 이 두 갭을 닫는 Phase 1 surface 다. **Phase 2 — 실제 re-spawn (spec 으로 fresh fork)** 는 명시적으로 본 ADR 의 scope 밖.

**왜 JSONL-per-handle**:
- 매 fork/cancel/runner-result 가 단일 line append 로 끝남 — process kill 이 직후라도 직전 transition 까지의 history 는 디스크에 있다 (Codex `archived_sessions/*.jsonl` 와 동일 보장).
- corrupt file 한 개가 workspace 전체의 list() 를 깨지 않음 (silently skip).
- atomic snapshot 불필요 — last-line-is-current.

**왜 closed-port + 별도 wrapper**:
- ADR-0145 인메모리 scheduler 와의 **byte-identical 무회귀**: 본 ADR 은 그 모듈을 1줄도 안 건드린다. `persistentBackgroundSubagentScheduler` 는 순수 composition wrapper.
- caller 는 jsonl adapter 대신 in-memory fake 또는 future SQLite adapter 로 교체 가능.

## 결정

### 1. Closed port: `PersistentSchedulerStore`

5 methods, NO-THROW 계약은 method 별 차별화 (port doc 참조):

- `save(handle)` — append-only 1 line; underlying I/O 실패는 `PersistenceError("io-failed")`.
- `load(id)` — `null` on ENOENT; parse-failure 는 `PersistenceError("parse-failed")`.
- `list(workspace)` — startedAt DESC 정렬; corrupt 파일은 skip.
- `delete(id)` — idempotent (unknown id 도 OK).
- `prune(workspace, maxAgeMs)` — terminal state 만 prune, running 은 절대 prune 안 함.

### 2. New status arm: `PersistedSubagentStatus = SubagentStatus | "interrupted"`

`SubagentStatus` (`running` | `completed` | `failed` | `cancelled`) 4-arm 위에 5번째 `"interrupted"` 만 추가. wrapper 의 hydration 단계가 이 arm 으로 재분류한다.

### 3. JSONL on-disk adapter — `defaultJsonlSchedulerStore`

Layout (shadow-odb ADR-0108 parity):

```
<baseDir>/<workspaceHash>/<handleId>.jsonl
```

- `baseDir` 기본 `~/.quanta/scheduler/` (caller override 가능).
- `workspaceHash` = `SHA-256(workspace).slice(0, 16)` — shadow-odb 와 같은 hex prefix.
- Each line = `JSON.stringify(handle) + "\n"`; last non-empty line is current.

### 4. Hydrating wrapper — `persistentBackgroundSubagentScheduler`

`{inner, store, workspace, isProcessAlive?, now?, hostPid?}` 받아 `BackgroundSubagentScheduler` 반환 (async 생성자 — `store.list(workspace)` 가 await 이라).

- **On construct**: store 의 모든 handle 을 fetch. status === "running" 이면 `hostPid` liveness 확인. PID dead OR PID 부재 → `"interrupted"` 로 재분류 + 그 새 상태를 `store.save` 로 write-through (다음 process 가 같은 reclassify 를 중복하지 않게).
- **On fork**: `inner.fork` → 즉시 save (running snapshot). runner 완료 watcher 등록.
- **On cancel**: `inner.cancel` → save (cancelled snapshot).
- **On runner settle**: save (completed/failed snapshot).
- **poll/await**: live (inner) → interrupted cache → hydrated cache 순서.
- **cancel(interruptedId)**: false (live handle 없음).
- **list()**: live + hydrated 합쳐 startedAt DESC 정렬.

## 계약 (5)

1. **NO-THROW** on poll/await/cancel/list/prune. fork 는 cap-exceeded 에 한해 `SubagentBackgroundError` (ADR-0145 와 동일). save-on-event 의 I/O 실패는 wrapper 내부에서 swallow (hot path 안정성 — Phase 2 에서 observability 와이어로 surface 예정).
2. **PID liveness honesty**: hostPid 가 있고 alive 면 running stays running. dead OR 부재 → interrupted.
3. **exactOptionalPropertyTypes** 유지: `endedAt` / `outputDetail` / `errorMessage` / `hostPid` / `workspace` / `modelOverride` / `maxTurns` / `metadata` 부재 시 key OMITTED, never `undefined`-set. JSONL round-trip 보존.
4. **Crash safety**: JSONL append-only — 직전 transition 까지 디스크에 있음. torn write 의 마지막 line 은 load-walker 가 trailing-newline 기준으로 skip.
5. **Default-OFF**: wrapper 미사용 시 ADR-0145 byte-identical. 본 슬라이스의 어떤 코드도 loop/dispatch/llm 에 자동 와이어되지 않음.

## Hellgate (31 case = 16 jsonl + 15 wrapper)

`subagent-persistence-jsonl-hellgate.test.ts` (16):
- **A. save + load** (5): roundtrip / load unknown null / 두 번 save → latest line / 옵션 필드 부재 → key 자체 absent / nested SubagentSpec round-trip.
- **B. list** (4): empty → `[]` / startedAt DESC / workspace 필터 / 한 파일 corrupt → 그것만 skip.
- **C. delete + prune** (4): delete 후 load null / unknown delete idempotent / prune terminal old / **prune NEVER touches running** regardless of age.
- **D. Crash safety** (3): single complete line + trailing \n / ENOENT load → null / EACCES write → `PersistenceError("io-failed")`.

`subagent-persistence-hydrate-hellgate.test.ts` (15):
- **A. Hydration** (5): empty store / terminal 2개 list() / running + alive PID → stays running / running + dead PID → reclassify + save-through / running + 부재 PID → conservatively interrupted.
- **B. Save-on-event** (5): fork → save(running) / cancel → save(cancelled) / runner success → save(completed) / runner fail → save(errorMessage) / prune → store.prune delegate.
- **C. Interrupted arm** (5): poll / await (즉시 resolve, <50ms) / cancel (false) / fresh fork 와 공존 / list 정렬 (live > interrupted > old-terminal by startedAt DESC).

총 31 pass / 0 fail. ADR-0153 의 12 case + ADR-0145 의 20 case 도 byte-identical 유지.

## Default-OFF / byte-identical

- ADR-0145 `subagent-background.ts` 는 1줄 미수정.
- 본 슬라이스 어떤 모듈도 `apps/agent` bootstrap 에 자동 wire 안 됨 — Phase 1 은 **primitive 만**. 실제 `~/.quanta/scheduler/` 경로 결정 + wrapper 생성 + shutdown handler 등록은 sibling PR 책임 (별도 ADR follow-up).

## Alternatives rejected

1. **SQLite-backed store** (단일 db). 거절: JSONL append-only 가 crash-safety 와 debuggability 양쪽에서 더 honest (corrupt 파일 1 개가 전체 DB 를 깨지 않음, `tail -f` 로 history 추적 가능, schema migration 불요).
2. **Single big file like ADR-0153**. 거절: 직전 snapshot 이후 윈도우가 비어있음. per-handle JSONL 은 매 transition 이 디스크에 있다.
3. **Resume by re-binding runner** (Phase 2 즉시 진입). 거절: separate ADR 로 분리. Phase 1 은 **honesty-first** — `interrupted` 라는 단어가 caller 에게 "이 작업은 죽었다" 를 명확히 전달, replay 정책은 surface 결정.
4. **Encrypt-at-rest**. 거절: scope creep. plain JSON 이 debugging-friendly. caller 가 원하면 별도 layer.
5. **Cross-workspace global file**. 거절: workspace 격리가 ADR-0108 정책. 한 workspace 의 corrupt 가 다른 workspace 에 새지 않음.

## SOTA matrix

| Agent | Per-transition disk snapshot | "Interrupted" arm | Cross-restart honest reclassify |
|---|---|---|---|
| Cursor 3.2.16 | ❌ in-memory only | ❌ | ❌ |
| Codex 0.131 | partial (session JSONL) | ❌ | ❌ |
| Claude Code 2.1 | ❌ (subagent sequential) | — | — |
| v0.dev | ❌ | — | — |
| **quanta (ADR-0153)** | weak (periodic single-file) | ❌ | partial |
| **quanta (본 ADR)** | ✅ JSONL append-only | ✅ 5-arm union | ✅ PID liveness probe + save-through |

## Follow-up (본 ADR 이 닫지 않는 것)

- **Phase 2 — resume by spec replay**: lost-running OR interrupted handle 을 그 `spec` 으로 fresh-fork. caller policy ("5 분 이내 interrupted 만 replay") 가 본질.
- **Apps/agent bootstrap wire**: 실제 path 결정 + wrapper 합성 + shutdown handler. sibling PR.
- **save-on-event observability**: 현재 wrapper 가 store.save 실패를 swallow — Phase 2 에서 ToolEvent / metrics 로 surface.
- **Token / secrets in spec.metadata**: encrypt-at-rest 가 필요하면 별도 adapter.
- **`PersistenceError("missing")`** code 는 reserved — 현재는 load-unknown 이 null 반환. future strict-mode 용.
- **Biome cognitive-complexity warnings (3)**: `jsonl-store.ts` 의 `parseHandle` / `prune` / `findHandleFileAcrossWorkspaces` 가 max 15 초과. 기능적으로는 모두 closed-port 검증 logic — 후속 round 에서 helper 추출로 분해 가능 (현재는 inline 이 의도 명료).
