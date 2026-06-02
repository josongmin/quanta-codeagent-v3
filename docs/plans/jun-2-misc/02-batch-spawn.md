# RFC: Batch / List subagent spawn (`spawn_batch`)

ADR 후보: **ADR-0435** (`docs/decisions/` 최신 free 번호 — 0434까지 사용됨, 0435 free 확인)
상태: Draft / implementation-ready
슬라이스: `src/tool/subagent-batch/**` (신규) + `src/agent/tier1/subagent-batch.ts` (composition-root 어댑터, deferred-wire)
Default-OFF: 도구는 wiring 전까지 ToolRegistry에 부재 → root 경로 byte-identical

---

## 1. Problem

"이 50개 항목 각각에 대해 X를 해라" 같은 bulk fan-out 작업을 현재 quanta는 모델이
직접 N번의 `agent` / `subagent_fork` 호출을 손으로 풀어 쓰는(hand-rolled for-loop)
방식으로만 처리할 수 있다. 결과:

- **토큰 낭비**: N개 항목 각각에 대해 거의 동일한 prompt를 모델이 매번 재생성 →
  입력/출력 토큰이 항목 수에 선형 비례. 50개면 50개의 tool_call 블록.
- **항목 누락(dropped items)**: 모델이 루프를 풀다 중간에 항목을 빠뜨리거나
  중복 spawn 하는 비결정성. N이 커질수록 신뢰도 급락.
- **동시성 제어 부재**: 모델이 `subagent_fork`를 N번 연속 호출하면 스케줄러의
  `maxConcurrent` cap(`src/agent/subagent-background.ts:474`)에 걸려 `cap-exceeded`
  throw를 받고, 모델이 그걸 보고 재시도하는 fragile한 백오프 루프를 또 손으로 짜야 함.
- **부분 실패 격리 부재**: 한 항목이 실패하면 모델이 나머지를 계속 할지 멈출지를
  매 턴 판단해야 함. 구조적 보장이 없음.

Codex는 이걸 `spawn_agents_on_csv`라는 단일 구조화 도구로 흡수했다 (아래 §2).
quanta는 이미 **concurrency-capped background scheduler**와 **TaskRegistry**를
보유하므로(아래 §3), 새 워커풀을 재발명하지 않고 그 위에 batch 도구만 올리면 된다.

---

## 2. Competitor research — Codex `spawn_agents_on_csv`

소스: `.extracted_source/codex/_codex-rs-0.135-symbols.txt`

핵심 핸들러 경로 (line 6021–6054):
```
6021: core/src/tools/handlers/agent_jobs.rs
6027: core/src/tools/handlers/agent_jobs/spawn_agents_on_csv.rs
6034: failed to serialize spawn_agents_on_csv result:
6045: id_column
6054: core/src/tools/handlers/agent_jobs/report_agent_job_result.rs
6341: state/src/runtime/agent_jobs.rs
```

도구 description + 파라미터 verbatim (line 50009 묶음):
> **spawn_agents_on_csv** — "Process a CSV by spawning one worker sub-agent per
> row. The instruction string is a template where `{column}` placeholders are
> replaced with row values. Each worker must call `report_agent_job_result`
> with a JSON object (matching `output_schema` when provided); missing reports
> are treated as failures. This call **blocks until all rows finish** and
> automatically exports results to `output_csv_path` (or a default path)."

`struct SpawnAgentsOnCsvArgs with 8 elements` (line 50909). 파라미터 shape:
- **csv_path** — "Path to the CSV file containing input rows."
- **instruction** (template) — "Instruction template to apply to each CSV row.
  Use `{column_name}` placeholders to inject values from the row."
- **id_column** — "Optional column name to use as stable item id."
- **output_csv_path** — "Optional output CSV path for exported results."
- **max_concurrency** — "Maximum concurrent workers for this job. **Defaults to
  16 and is capped by config.**"
- **max_workers** — "**Alias for max_concurrency. Set to 1 to run sequentially.**"
- **output_schema** — JSON object schema each worker result must match.
- **max_runtime_seconds** (per worker) — "Maximum runtime per worker before it
  is failed. **Defaults to 1800 seconds.**"

Job 상태 머신 컬럼 (line 50009, `state/src/runtime/agent_jobs.rs` + line 50450
`COUNT(*) AS total_items`): `total_items` / `completed_items` / `failed_items` /
`job_error` / `failed_item_errors` / `assigned_thread_id` / `running item`.

워커 보고 도구 (line 50009): **report_agent_job_result** — "Worker-only tool to
report a result for an agent job item. Main agents should not call this."
`struct ReportAgentJobResultArgs with 4 elements`: `job_id`, `item_id`,
`result`(JSON object), `cancel_remaining`(bool — "When true, cancels the
remaining job items after this result is recorded").

제약(verbatim, line 50009):
- "**spawn_agents_on_csv is not supported for remote environments**"
- "**spawn_agents_on_csv requires exactly one local environment**"
- "csv input must include a header row"
- "instruction must be non-empty"
- "result must be a JSON object"
- "worker finished without calling report_agent_job_result" (→ 실패 처리)
- "agent thread limit reached; this session cannot spawn more subagents"
- "agent depth limit reached; this session cannot spawn more subagents"
- "agent job has failed items but no error details were recorded"
- 템플릿 escape: `{{__CODEX_OPEN_BRACE__}}` / `__CODEX_CLOSE_BRACE__` — 리터럴
  중괄호를 placeholder와 구분하기 위한 sentinel 치환.

문맥(multi_agents_v2, line 50909/56621): `ListAgentsArgs`(1) / `FollowupTaskArgs`(2)
/ `SpawnAgentArgs`(7~8) / `SendMessageArgs`(2). 즉 Codex의 일반 multi-agent는
spawn→followup→list 라는 수동 fan-out이고, `spawn_agents_on_csv`는 그 위에 얹은
**구조화된 fan-out + 워커풀 + 자동 집계** 레이어다.

### 흡수 시 quanta가 의도적으로 **버리는** 것 (negative invariants)
- CSV 전용 강제 (`csv_path`만 받음, header row 강제) → quanta는 **inline array
  OR file path** 둘 다 받는 일반 list로 일반화. CSV는 한 가지 입력 형식일 뿐.
- `report_agent_job_result` 라는 **워커-side 도구** → quanta 워커는 자기 final
  assistant text를 그냥 반환하면 됨(이미 `SubagentResult.finalText`). 별도 보고
  도구를 모델에게 강요하는 건 우리 subagent-runner 계약과 어긋남. `output_schema`
  검증은 워커 결과를 **부모 측에서** 파싱하는 것으로 대체(워커는 모름 → 더 단순).
- `output_csv_path` 자동 export → quanta는 결과를 구조화된 tool_result로 반환만
  하고, 파일 export는 모델이 원하면 `write` 도구로 하면 됨 (도구가 디스크에 쓰는
  side-effect를 묵시적으로 갖지 않음 = slice-clean).
- "remote environment" 제약 → quanta엔 remote env 개념이 없으므로 무관.

---

## 3. Quanta current — 재사용할 자산 (NO batch tool today)

### 3.1 Batch spawn 도구는 **없다** (확인)
```
grep -rn "spawn_batch|subagent_batch|spawn_agents_on_csv|csv|batch" \
  src/subagent/ src/tool/subagent-bg/ src/agent/subagent-background.ts
  → (no match)
```
오늘은 모델이 `agent`(`src/subagent/agent-tool.ts`) 또는 `subagent_fork`
(`src/tool/subagent-bg/fork.ts:41`)를 N번 호출해야 한다.

### 3.2 재사용 #1 — concurrency-capped background scheduler
`src/agent/subagent-background.ts`:
- `defaultBackgroundSubagentScheduler(opts)` (line 363) — in-memory 워커 스토어.
- `maxConcurrent` cap (line 367, default 3); `fork()`이 cap 초과 시
  `SubagentBackgroundError("cap-exceeded")` throw (line 474–479).
- 주입된 `runner: SubagentRunner` (line 366) 이 유일한 agent-loop 브리지.
- per-handle `AbortController` + `cancel()` (line 552), `await(id,{signal})`
  (line 515) — "지루해서 기다리기 그만"과 "죽여라"를 분리(line 526).
- 주입된 clock `now` (line 369) + `idGen` (line 370) — 결정성.
- `applyRunnerSuccess` / `applyRunnerFailure` (line 414/430) — 워커 실패를
  throw가 아니라 `status:"failed"`로 surface (NO-THROW 계약, 모듈 contract #2).

> ⚠️ scheduler의 `maxConcurrent`은 "동시에 `running`인 핸들 수"에 대한 **hard
> throw cap** 이지, "들어오는 작업을 큐잉해서 천천히 흘려보내는" 워커풀이 아니다.
> batch 도구는 이 cap을 **재사용하되, throw 대신 자체 admission gate**(아래 §6)로
> 동시 in-flight를 cap 이하로 유지하며 큐잉한다. scheduler를 변형하지 않는다.

### 3.3 재사용 #2 — TaskRegistry (per-task abort + 이벤트 기반 settle)
`src/subagent/registry.ts`:
- `register()` (line 86) → `{abort: AbortController, ownerToken}`; per-task 취소.
- `waitForSettle(id)` (line 197) — 이벤트 기반(busy-poll 없음) settle Promise.
- `pendingIds()` (line 113) — 미완료 작업 열거(세션 cleanup용).
- `complete`/`fail`/`stop`/`forceStop` (line 121/135/157/179) — 상태 전이.
- settled-record LRU (line 206, default 256).

### 3.4 재사용 #3 — wait-timeout race 패턴
`src/subagent/task-tools.ts:99` `waitForSettle()` — registry settle Promise vs
timeout vs `ctx.signal` 3-way `Promise.race`, timer/listener 무조건 cleanup
(line 118–123). batch 도구의 per-item hang timeout이 이 패턴을 그대로 재사용.
clamp 정책 `clampTaskOutputTimeout` (line 53) + `TaskOutputTimeoutPolicy`도 재사용.

### 3.5 재사용 #4 — 도구 등록 / port-mirror 패턴
`src/tool/subagent-bg/index.ts:41` `subagentBgTools(scheduler)` + `port.ts`의
duck-typed `BackgroundSubagentSchedulerPort` — `@/tool` 슬라이스가 `@/agent`를
import하지 않도록 producer를 좁게 미러(line 1–18). batch 도구도 **동일하게**
`@/tool/subagent-batch/port.ts`에 좁은 port를 둔다.

### 3.6 SubagentRunner 계약
`src/subagent/types.ts:25` `SubagentRequest` (prompt/depth/signal/budget/
toolFilter/isolation/resultShape/…). `src/agent/subagent-runner.ts:356`
`createSubagentRunner` 가 host-side 브리지(depth guard line 380, child config
line 256, signal chaining line 207). batch 워커는 이 runner를 통해서만 자식을 돈다.

---

## 4. Goals / Non-goals

### Goals
- 단일 구조화 도구 `spawn_batch`: `items[]`(또는 `items_path`) + `prompt_template`
  + `max_concurrency` → N개의 templated 자식 작업을 워커풀로 fan-out.
- 부분 실패 격리: 한 항목 실패 ⇒ 나머지 계속; per-item `{index, status, ...}` 반환.
- 동시성은 기존 scheduler의 `maxConcurrent`로 bound; 총 항목 수 cap.
- 결정적 templating(순수 치환, eval 없음) + 주입 clock + slice-fence + default-OFF.
- 진행 상황 streaming via `ToolEvent` `progress`.

### Non-goals
- **CSV 라이브러리 도입 금지.** quanta는 항목을 inline array 또는 file path로 받는
  일반 list로 처리한다. file path가 `.csv`인 경우만 최소 header-row CSV 파싱을
  인라인(의존성 없이, ADR-0205 frontmatter parser 인라인 선례). `.jsonl`/`.json`
  배열도 동일하게 인라인 파싱. → "literally CSV-only"가 아님.
- 워커-side `report_agent_job_result` 도구 도입 안 함 (워커는 finalText 반환).
- 자동 `output_csv_path` export 안 함 (디스크 side-effect 미보유).
- 새 워커풀/스케줄러 구현 안 함 (§3.2 재사용).
- depth>1 재귀 batch(batch 안에서 batch) 특수 처리 안 함 — 기존 maxDepth guard에
  자연 위임 (워커가 또 batch를 부르면 그냥 depth+1 자식).
- remote / 분산 실행 안 함.

---

## 5. Design

### 5.1 입력 스키마 (zod, `src/tool/subagent-batch/batch.ts`)
```ts
const itemSchema = z.union([z.string(), z.record(z.string(), z.unknown())])

export const spawnBatchInputSchema = z.object({
  // 항목 소스: inline 배열 XOR 파일 경로 (정확히 하나).
  items: z.array(itemSchema).optional()
    .describe("Inline list of items. Each item is a string OR an object of {{placeholder}} values. Mutually exclusive with items_path."),
  items_path: z.string().optional()
    .describe("Path to a .csv (header row required), .jsonl, or .json (array) file of items. Mutually exclusive with items."),

  prompt_template: z.string().min(1)
    .describe("Per-item child prompt. Use {{key}} placeholders; for string items use {{item}}. Literal braces: {{{{ }}}}."),

  max_concurrency: z.number().int().positive().optional()
    .describe("Max workers running at once. Defaults to scheduler cap; capped by it. Set 1 for sequential."),

  // 선택: 각 워커 결과를 구조화 파싱(부모-side). 위반 시 그 항목만 status:"error".
  output_schema: z.record(z.string(), z.unknown()).optional()
    .describe("Optional JSON schema each item's result must satisfy (parsed parent-side). Violations mark that item error, others continue."),

  per_item_timeout_ms: z.number().int().positive().optional()
    .describe("Max ms a single worker may run before it is marked timed-out (others continue). Clamped to policy band."),

  id_field: z.string().optional()
    .describe("For object items: field to use as the stable item id in results. Default = item index."),

  max_turns: z.number().int().positive().optional()
    .describe("Per-worker model-turn ceiling (passed to child budget)."),
})
```
`items` XOR `items_path` 는 `.superRefine`로 "정확히 하나" 강제 (둘 다/둘 없음 ⇒
`ok:false` 결과, throw 아님). Codex의 `max_workers` alias는 도입 안 함(혼란 방지);
`max_concurrency=1`이 sequential.

### 5.2 항목 로딩 (`src/tool/subagent-batch/load-items.ts`, 순수)
- `items` inline ⇒ 그대로.
- `items_path`:
  - `.json` ⇒ `JSON.parse` 후 배열 확인.
  - `.jsonl` ⇒ 라인별 `JSON.parse`.
  - `.csv` ⇒ 인라인 최소 파서: 첫 줄 = header (없으면 `ok:false` "csv requires
    header row"); 각 후속 줄 → `Record<header, cell>`. 따옴표/콤마-escape는
    RFC4180 최소 구현(인라인, 의존성 없음). 파일 read는 주입된 `readFile` port
    (테스트 fake 주입; slice는 `node:fs` 직접 import 안 함 — port).
- 결과: `ReadonlyArray<string | Record<string, unknown>>`. 빈 배열 허용(→ §8).

### 5.3 Templating (`src/tool/subagent-batch/template.ts`, 순수·결정적)
```
renderTemplate(template: string, item: string | Record<string,unknown>): 
  { ok: true; prompt: string } | { ok: false; missing: string[] }
```
- 치환 규칙(순수 문자열 치환, **eval/Function 없음**):
  - `{{item}}` ⇒ string 항목의 값 (object 항목엔 `item` 키가 없으면 missing).
  - `{{key}}` ⇒ object 항목의 `key` 값(문자열화: string/number/boolean은
    `String(v)`, 그 외 `JSON.stringify`). 키 부재 ⇒ `missing`에 수집.
  - 리터럴 중괄호: `{{{{` → `{{`, `}}}}` → `}}` (Codex sentinel과 동등 의미,
    sentinel 문자열 대신 doubling 사용 — 더 표준적).
- placeholder 정규식: `/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g` (escape doubling을 먼저
  치환한 뒤 적용). `.`은 허용하되 nested 접근은 **안 함**(flat key만; `a.b`는 리터럴
  키 이름). → 단순·결정적.
- `missing` 비어있지 않으면 그 항목은 spawn 없이 `status:"error", error:"template
  missing placeholder(s): k1, k2"` 로 즉시 기록(다른 항목 계속).

### 5.4 실행 — 워커풀 (admission gate over scheduler)
`src/tool/subagent-batch/run-batch.ts`:
- port: `BackgroundSubagentSchedulerPort` (fork/poll/await) — §3.5 미러를 재사용
  하되 **batch는 `fork`의 cap-throw에 의존하지 않는다.** 대신 자체 admission
  semaphore(주입된 `maxConcurrent` = `min(input.max_concurrency, schedulerCap)`)로
  동시 in-flight를 N개 이하 유지:
  ```
  for each item (index order):
    await admit()            // semaphore: 현재 in-flight < cap 까지 대기
    handle = scheduler.fork({ task: renderedPrompt, maxTurns })
    track(index, handle)
    scheduler.await(handle, {signal: ctx.signal})  // per-item, raced w/ timeout
      .then(record(index, ...)).finally(release())
  await allSettled
  ```
- 또는(권장) **scheduler를 거치지 않고 TaskRegistry + injected `SubagentRunner`만
  사용하는 self-contained 워커풀** — batch는 일회성 blocking job이라 background
  핸들 LRU/persistence가 불필요. 이 경우 port = `{ runner: SubagentRunner }` +
  `TaskRegistry`. semaphore로 cap, `registry.register()`로 per-item abort,
  `waitForSettle`+timeout race(§3.4)로 hang 처리. **이쪽이 더 slice-clean**
  (scheduler의 LRU/serialize 군더더기 불필요). → §11 채택안.
- admission semaphore는 작은 순수 유틸(`p-limit` 도입 대신 인라인 — 의존성 0,
  주입 clock 무관). cancellation은 `ctx.signal`을 모든 미시작 항목의 admit 단계
  + 모든 in-flight `register().abort`에 전파.

### 5.5 부분 실패 semantics
- 항목별로 try-collect; 한 항목의 워커 throw/timeout/non-ok는 그 항목의
  `status:"error"`로만 기록되고 **루프를 멈추지 않음**.
- `output_schema` 위반도 그 항목만 error.
- 전체 job은 항상 `ok:true`로 완료(= "batch 실행 자체는 성공")하되 aggregate에
  `failed` count를 담는다. **단, 모든 항목 실패 시** tool_result `ok:false`로
  surface(모델이 "전부 실패"를 명확히 인지하도록) — Codex "has failed items but
  no error details" 함정 회피.

### 5.6 Closed-port / default-OFF
- `src/tool/subagent-batch/port.ts` — `@/agent` import 금지(slice fence, biome
  enforce). runner/registry/readFile/clock 전부 주입.
- composition-root 어댑터 `src/agent/tier1/subagent-batch.ts`가 `config.subagent`
  (runner)를 duck-read; 부재 ⇒ `[]` 반환 → ToolRegistry byte-identical(§3.5의
  `subagent-bg` tier1 선례 그대로). wiring 전까지 도구 부재 = default-OFF.

---

## 6. Concurrency / ownership / cleanup
- 동시 in-flight = `min(max_concurrency ?? cap, cap)`, cap은 주입(`SCHEDULER_CAP`
  또는 host 설정). `max_concurrency=1` ⇒ sequential.
- **총 항목 수 cap** `MAX_BATCH_ITEMS`(주입, 권장 default 256 — TaskRegistry LRU와
  동일 크기) 초과 ⇒ `ok:false` "batch size N exceeds cap C". (DoS / 토큰 폭발 방지.)
- per-item ownership: `TaskRegistry.register()` 의 abort + ownerToken. batch가
  소유자이므로 ownerToken은 batch 내부 보관(모델에 노출 안 함 — batch는 자기
  자식들을 직접 관리).
- cleanup: `ctx.signal` abort 시 (a) 미시작 항목은 admit 단계에서 즉시 error
  ("cancelled before start"), (b) in-flight는 `register().abort()` 일괄 발화 →
  자식 `runAgent`가 chained signal(`subagent-runner.ts:207`)로 unwind. 모든
  핸들 settle 대기 후 반환(좀비 자식 없음).

---

## 7. Result shape + progress streaming
```ts
interface BatchItemResult {
  index: number
  id: string                       // id_field 값 또는 String(index)
  status: "ok" | "error"
  output?: string                  // status:"ok" — 워커 finalText (또는 파싱된 객체 직렬화)
  parsed?: Record<string, unknown> // output_schema 제공 시 파싱 결과
  error?: string                   // status:"error" — 사유 (template-missing / timeout / worker-failed / schema-violation / cancelled)
  turns: number
}
interface BatchSummary {
  total: number; ok: number; failed: number
  cancelled: number; durationMs: number
}
```
- tool_result `output`: human-readable 요약 + per-item 라인 (render 패턴은
  `task-tools.ts:69` `render` 참고) + JSON tail(`structuredContent`로 모델이
  파싱 가능). 항목 순서는 입력 index 순으로 결정적 정렬(완료 순서 아님).
- progress: `yield {type:"progress", message:"batch 12/50 done (2 failed)…"}` —
  각 항목 settle 시 또는 N개마다 emit. `ToolEvent` union은 `src/tool/types.ts:760`.

---

## 8. Edge cases
| 케이스 | 처리 |
|---|---|
| empty list (`items:[]` 또는 빈 파일) | `ok:true`, summary `total:0`, per-item `[]`. throw 아님. (Codex "instruction must be non-empty"는 template에만 적용 — template은 `min(1)`.) |
| 항목 수 > cap | `ok:false` "batch size N exceeds cap C" — spawn 0회. |
| template missing placeholder | 그 항목만 `status:"error", error:"template missing: k"`; 나머지 spawn. |
| `items` + `items_path` 둘 다 / 둘 다 없음 | `ok:false` "provide exactly one of items / items_path". |
| `.csv` header 없음 / 빈 파일 | `ok:false` "csv requires a header row". |
| 워커 hang | `per_item_timeout_ms`(clamp, §3.4 race) 초과 ⇒ 그 항목 `status:"error", error:"timed out after Nms"`, abort 발화, 나머지 계속. |
| cancellation mid-batch (`ctx.signal`) | 미시작 ⇒ error "cancelled before start"; in-flight ⇒ abort+unwind, status "error"/"cancelled"; 완료된 항목 결과는 보존; summary.cancelled 집계. |
| 모든 항목 실패 | tool_result `ok:false` (전부 실패 명시), summary 그대로. |
| object 항목인데 `{{item}}` 사용 | `item` 키 부재 ⇒ template-missing error (그 항목만). |
| 워커 non-ok (`SubagentResult.ok===false`) | `status:"error", error:finalText`. |

---

## 9. Test plan (hellgate-first, `tests/unit/subagent-batch-hellgate.test.ts`)
fake `SubagentRunner`(주입) + fake `readFile` + 주입 clock으로 LLM/디스크 없이.
1. **N→N**: 5개 항목 → 5개 per-item 결과, 전부 `ok`, summary `ok:5/failed:0`,
   index 순 정렬 결정적.
2. **부분 실패 격리**: runner가 index 2에서 throw → item 2 `status:"error"`,
   나머지 4개 `ok`, 루프 안 멈춤, summary `failed:1`.
3. **concurrency cap 준수**: runner가 in-flight count를 기록 → 관측된 최대 동시
   실행이 `max_concurrency`를 절대 초과하지 않음 (semaphore 증명). `=1`이면 항상
   sequential(겹침 0).
4. **empty list**: `items:[]` ⇒ `ok:true`, total 0, spawn 0회 (runner 미호출).
5. **항목 cap 초과**: cap=3, 4개 항목 ⇒ `ok:false`, runner 0회 호출.
6. **template 정확 치환**: object `{a:"x",n:2}` + `"do {{a}} {{n}} times {{{{lit}}}}"`
   ⇒ `"do x 2 times {{lit}}"` byte-exact. missing key ⇒ item-error.
7. **cancel mid-batch**: 10개, cap=2, 4개 settle 후 `ctx.signal.abort()` ⇒ 미시작
   항목 "cancelled before start", in-flight abort 호출 검증, 완료분 보존.
8. **worker hang → per-item timeout**: runner가 영원히 pending, `per_item_timeout_ms`
   경과(주입 clock advance) ⇒ 그 항목 timeout error, abort 발화, 나머지 정상.
9. **output_schema 위반 격리**: 한 항목 결과가 schema 위반 ⇒ 그 항목만 error.
10. **default-OFF byte-identical**: `config.subagent` 부재 ⇒ tier1 어댑터가 `[]`
    반환, ToolRegistry snapshot이 wiring 전과 동일(스냅샷 비교).
11. **items XOR items_path**: 둘 다/둘 없음 ⇒ `ok:false`.
12. **csv 파싱**: header + 2 rows, 따옴표·콤마-escape 케이스 → 올바른 object 항목.

---

## 10. File-by-file change list
신규 슬라이스 `src/tool/subagent-batch/`:
- `port.ts` — `SubagentBatchRunnerPort`(`{ runner: SubagentRunner }`), `ReadFilePort`,
  `BatchClock`, 결과/summary 타입. **`@/agent` import 금지.**
- `template.ts` — `renderTemplate` (순수, eval 없음).
- `load-items.ts` — inline / .json / .jsonl / .csv 인라인 파서 (주입 readFile).
- `run-batch.ts` — 워커풀(semaphore + TaskRegistry + per-item timeout race +
  부분실패 격리 + cancel 전파).
- `batch.ts` — `spawnBatchTool(deps)` Tool: zod 스키마, validate→load→render→run,
  progress/result `ToolEvent` emit.
- `index.ts` — barrel + `subagentBatchTools(deps): Tool[]` (등록 헬퍼,
  `subagent-bg/index.ts:41` 패턴).

composition-root:
- `src/agent/tier1/subagent-batch.ts` (신규) — `config.subagent`(runner) duck-read,
  부재 ⇒ `[]`; 존재 ⇒ `subagentBatchTools({ runner, registry: new TaskRegistry(),
  readFile, clock, schedulerCap, maxItems })`. tier1 빌더에 등록(`subagent-bg`와
  동일한 위치).
- `src/agent/features.ts` — tier1 배열에 batch 빌더 호출 추가 (subagent-bg 옆,
  `index.ts:174-179` 인근 wiring 패턴).

테스트:
- `tests/unit/subagent-batch-hellgate.test.ts` (§9, 12 케이스).
- `tests/unit/subagent-batch-template.test.ts` (renderTemplate 단위 + escape/fuzz).

문서:
- `docs/decisions/0435-batch-subagent-spawn.md` (이 RFC 요약 + 결정 + negative
  invariants).
- fc 카탈로그 1행 추가.

### Effort
- 슬라이스 6파일: ~M (template/loader/semaphore는 순수·작음; run-batch가 핵심).
- tier1 + features wiring: ~S.
- 테스트 12+케이스: ~M.
- **총 ~1.5일** (worktree-isolated 단일 에이전트). 의존성 추가 0(인라인 CSV/JSONL).

---

## 11. SOTA++ 결정 사항
- **워커풀 = TaskRegistry + injected SubagentRunner + 인라인 semaphore** (§5.4 채택).
  background scheduler의 LRU/serialize/persist는 batch(일회성 blocking job)에
  불필요하므로 거기까지 끌어들이지 않는다. 단, scheduler의 cap 철학·NO-THROW·주입
  clock 패턴은 그대로 차용. (재사용 ≠ 무조건 같은 객체.)
- per-item hang은 `task-tools.ts:99`의 검증된 race + `clampTaskOutputTimeout`
  (`task-tools.ts:53`) 재사용 — 새 timeout 휴리스틱 도입 안 함.
- 모든 비결정 소스(clock/id/readFile) 주입 → hellgate가 LLM/디스크 없이 결정적.
- semaphore cap·총항목 cap은 **임의 휴리스틱이 아니라** 명시적 주입 상수(TaskRegistry
  LRU=256과 정렬). 측정 없는 임계값 제안 금지 원칙 준수.
- slice-fence: `port.ts` duck-mirror로 `@/tool`→`@/agent` 단방향 유지(biome enforce).
- default-OFF 3중: (1) tier1 어댑터가 runner 부재 시 `[]`, (2) 도구 자체가 항목
  cap·XOR 검증으로 throw 아닌 `ok:false`, (3) wiring 전 ToolRegistry byte-identical.
- templating은 순수 doubling-escape + flat-key 치환 — `eval`/`Function`/nested
  access 없음(injection 표면 0).
