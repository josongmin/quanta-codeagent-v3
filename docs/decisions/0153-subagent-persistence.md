# ADR-0153: BackgroundSubagentScheduler cross-restart persistence

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0145 (background subagent scheduler — the foundation; originally numbered ADR-0130), ADR-0124 (conversation-checkpoint store — serialize/hydrate voice match), ADR-0136/0138 (token budget ledger — same serialize/hydrate posture)
- **SOTA 출처**: 어떤 modern agent도 background subagent state를 process restart 가로질러 보존하지 않음 (Cursor 3.2.16 `force_background_subagent` 도 in-memory). quanta가 typed handle history를 살리는 첫 surface.
- **참조**: `src/agent/subagent-background.ts`, `src/agent/subagent-persistence.ts`, `tests/unit/subagent-persistence-hellgate.test.ts`

## 맥락

ADR-0145의 `BackgroundSubagentScheduler` 는 plane-clean **인메모리** primitive — `Map<handleId, entry>` 한 개로 fork/poll/await/cancel/list/prune 6 surface를 제공한다. process restart 시 모든 handle (running + completed + failed + cancelled) 가 **사라진다**. ADR-0145 §"Follow-up" 의 첫 항목이 정확히 이 갭:

> **Persistent scheduler**: process restart 살아남게 JSONL/SQLite 백업. `followUpQueueSnapshotStore` 패턴.

본 ADR이 그 약속을 deferred follow-up으로 닫는다.

**왜 지금**: ADR-0145 이후 sibling track에서 `subagent_fork` LLM tool이 정착하면 long-running detached subagent (e.g. `/spawn-bg "loop on CI until green"`) workflow가 생긴다. 30분/60분짜리 작업이 process restart로 흔적도 없이 사라지면 관측성 zero — fork 결과를 영영 알 수 없다. 본 ADR은 **handle history를 가로질러 보존**해 최소한 "그 작업이 있었음" + "어디까지 갔는지" 를 살린다.

**왜 in-memory 아닌 disk가 아니라 closed-port인가**: ADR-0124 (conversation-checkpoint store) / ADR-0136 (budget-ledger) 와 동일 패턴 — primitive 본체는 `serialize()`/`hydrate()` JSON in/out 만 노출하고, **caller가 disk policy를 소유**한다. 이유:
1. 어디에 쓸지 (`~/.quanta/subagents.json` vs session-scoped `<sessionDir>/subagents.json`) 는 surface 결정.
2. 언제 쓸지 (turn 경계마다? shutdown handler에서만? periodic timer?) 도 surface 결정.
3. plane-clean fence: scheduler가 `node:fs` 를 import하면 storage plane을 침범. 별도 helper (`subagent-persistence.ts`) 가 disk wire를 owning.

## 결정

3-part scope:

### 1. `BackgroundSubagentScheduler` surface에 3 method 추가

```ts
interface BackgroundSubagentScheduler {
  ...existing 6...
  serialize(): string
  hydrate(json: string): number
  hydrateWithPrune(json: string, maxAgeMs: number): { restored: number; pruned: number }
}
```

- **serialize**: 모든 handle (running + terminal) snapshot → `{v:1, handles: SerializedHandle[]}` JSON. `abortCtrl` + `promise` 는 **비직렬화** 이므로 omit; `result.status === "running"` 으로 hydrate 가 감지하게 marker만 살림.
- **hydrate**: parse → for each entry, store entry 복원. **running entries → reborn as `failed` + `errorMessage="lost across restart"`** (Promise object 가 재구성 불가). returns 복원 개수. parse 실패/shape mismatch → 0 (NO-THROW).
- **hydrateWithPrune**: hydrate 전에 age filter — terminal은 `endedAt`, running은 `startedAt` 기준으로 `now() - x <= maxAgeMs` 만 살림. returns `{restored, pruned}`.

### 2. Factory option 추가 — `hydrateFrom` / `hydrateMaxAgeMs`

```ts
interface BackgroundSubagentSchedulerOpts {
  ...existing...
  readonly hydrateFrom?: string         // auto-hydrate at construction
  readonly hydrateMaxAgeMs?: number     // optional age filter for auto-hydrate
}
```

`defaultBackgroundSubagentScheduler` 가 `opts.hydrateFrom` 가 present 면 constructor 안에서 `hydrate` (or `hydrateWithPrune`) 호출. ADR-0124의 `restoreFrom` 와 동일 voice.

### 3. `src/agent/subagent-persistence.ts` (NEW, ~70 LOC)

3 pure helpers — caller가 disk wire를 owning:

```ts
snapshotToFile(scheduler, path): Promise<void>      // periodic OR shutdown
restoreFromFile(json | null, scheduler): Promise<number | null>
readSnapshotFile(path): Promise<string | null>      // ENOENT → null
```

Plane-clean imports: `./subagent-background` + `node:fs/promises` ONLY.

## 계약 (4)

1. **NO-THROW** on hydrate / hydrateWithPrune / restoreFromFile / snapshotToFile (the last only throws on genuine filesystem error — disk full, EPERM — which the caller must surface).
2. **Lost-running honesty**: running entries reborn as `failed` + `errorMessage="lost across restart"` + `endedAt = now()`. Promise resume은 본 ADR 의 scope 밖. (caller가 spec 으로부터 task replay 를 원하면 별도 ADR — §"Follow-up" 참고).
3. **exactOptionalPropertyTypes** 유지: `outputDetail`/`errorMessage`/`endedAt`/`modelOverride`/`maxTurns`/`workspace`/`metadata` 부재 시 key 자체 OMITTED, never `undefined`-set. 직렬화 → hydrate roundtrip 에서도 동일.
4. **Default-OFF**: `hydrateFrom` 부재 시 scheduler 동작은 ADR-0145 와 **byte-identical** (no regression). `subagent-persistence.ts` 는 자동 호출 zero — caller가 명시적으로 wire 해야 동작.

## Hellgate (12 cases)

`tests/unit/subagent-persistence-hellgate.test.ts` 가 4 cluster 로 봉인:

- **A. serialize/hydrate roundtrip (5)**: fork 3 + complete 2 → roundtrip → 3 entries / running → reborn as failed-lost / spec preserved (task+modelOverride+maxTurns+workspace+metadata) / empty → 0 entries / malformed JSON → 0 (NO-THROW)
- **B. hydrateWithPrune (3)**: maxAgeMs filter (fresh 살림, old 드롭) / all within age → restored = count, pruned = 0 / all past age → restored = 0, pruned = count
- **C. Auto-restore on construction (2)**: `hydrateFrom` set → entries appear in `list()` / `hydrateFrom + hydrateMaxAgeMs` → old pruned + fresh restored
- **D. Disk-backed helpers (2)**: `snapshotToFile` writes serialize() verbatim / `restoreFromFile` with missing path → null (graceful)

전부 인메모리 (controllable fake runner + tmpdir for disk helpers). 12 pass / 0 fail.

## Default-OFF / byte-identical

`opts.hydrateFrom` 부재 시:
- constructor 가 `restoreHandles` 호출 안 함 → store가 비어있는 채 시작 → ADR-0145 동작과 동일.
- 어떤 caller도 자동으로 `serialize()` / `hydrate()` 를 호출하지 않음 — fork/poll/await/cancel/list/prune 의 hot path 는 변하지 않음.
- `src/agent/subagent-persistence.ts` 는 별도 모듈, scheduler 가 그것을 import 하지 않음.

ADR-0145 와의 byte-identical 보장 → 기존 caller (sibling PR 의 `apps/agent` bootstrap) 에 zero regression.

## Alternatives rejected

1. **SQLite-backed scheduler** (`subagents.db`) as default. 거절 이유: plane-clean fence 침범 — scheduler가 `@/storage` 를 import 하게 됨. closed-port + JSON 은 storage-agnostic — caller가 SQLite/flat-file/redis 중 고른다.
2. **Continuous WAL** (매 fork/cancel/완료마다 disk write). 거절 이유: in-memory primitive의 본래 hot-path latency를 깨는 over-engineering. periodic snapshot (또는 shutdown-only) 면 충분 — handle 손실 가능성은 "restart 직전 N초" 윈도우로 제한적.
3. **Resume running subagents** (재시작 후 in-flight task 이어서 실행). 거절 이유:
   - Promise object 가 재구성 불가 — runner closure 의 진행 상태 (LLM 호출 어디까지 했는지 / tool call 어디까지 했는지) 가 disk 에 없음.
   - Honest signal: `errorMessage="lost across restart"` 가 명확하게 "이 작업은 죽었으니 알아서 결정해라" 라고 caller 에게 전달.
   - 정 resume 이 필요하면 `spec` 을 사용한 **task-replay** (fresh fork) 가 깔끔 — 별도 ADR 로 분리 (§"Follow-up").
4. **Per-handle separate file** (`subagents/<id>.json`). 거절 이유: file-system fragmentation + cross-handle atomic snapshot 불가 (한 turn 중 fork 5개 후 단일 snapshot 이 안 됨). 단일 파일 + 단일 write 가 atomicity 보장.
5. **Encrypt-at-rest by default**. 거절 이유: scope creep. plain JSON 이 debugging-friendly + caller 가 원하면 별도 layer 추가 가능.

## SOTA matrix

| Agent | Background fork | Handle persistence | Cross-restart recovery |
|---|---|---|---|
| Cursor 3.2.16 | ✅ `force_background_subagent` | ❌ in-memory only | ❌ |
| Codex 0.131 | partial (`spawn_agent`+blocking `wait_agent`) | ❌ | ❌ |
| Claude Code 2.1 | ❌ (Task sequential) | — | — |
| v0.dev | ❌ | — | — |
| **quanta (본 ADR)** | ✅ ADR-0145 | ✅ serialize/hydrate JSON | ✅ honest "lost across restart" reborn + spec 보존 |

= "Background subagent scheduler 가 process restart 를 가로질러 typed handle history 를 보존하는 최초 surface". 다른 agents 는 in-memory only 이거나 background 자체가 없다.

## Follow-up (이 ADR 이 닫지 않는 것)

- **WAL-like incremental snapshot** (Phase 2): 매 fork/cancel/완료마다 append-only diff write. 현재는 단일 snapshot — periodic 이 충분하지 않은 surface 에서만 필요.
- **Resume-by-task-replay**: `spec` 을 사용해 lost-running handle 을 fresh fork 로 재시작하는 별도 surface. caller policy (e.g. "5 분 이내 lost 만 replay") 가 본질이라 별도 ADR.
- **Per-thread isolation**: 현재는 process-global. multi-session/multi-thread surface 진입 시 thread별 file 분리.
- **Encryption at rest**: secrets / token / API key 가 spec.metadata 에 들어갈 가능성 있으면 별도 layer (e.g. age/sops) 추가.
- **Apps/agent bootstrap wire**: 본 ADR 은 primitive 만 — 실제 `~/.quanta/subagents.json` 경로 결정 + shutdown handler 등록 + startup hydrate 는 sibling PR 의 bootstrap 책임.
