# ADR-0133: `csv_read` + `ndjson_read` document tool slice (text-format structured-data gap closure)

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0126 (`read_image` — magic-byte SSOT mirror, leaf-symlink reject, caller-deferred registration), ADR-0125 (helper-only deferred wire), ADR-0127 (web tool slice — 동일 deferred-registration posture)
- **참조**: `src/tool/document/` (csv-parse.ts / ndjson-parse.ts / csv-read.ts / ndjson-read.ts / index.ts), `tests/unit/tool/csv-read-hellgate.test.ts` (16 cases), `tests/unit/tool/ndjson-read-hellgate.test.ts` (12 cases)
- **SOTA 참조**: Cursor / Claude Code / Codex 모두 **built-in 구조 데이터 도구 없음** — `bash` + `cat`/`awk`/`jq` 셸링이 표준. quanta가 modern coding agent 중 **첫 번째**로 text-format structured-data 도구를 박는다.

## 맥락

agent는 빈번하게 CSV 덤프(고객 데이터, 메트릭 export, sklearn `to_csv`)와 NDJSON 로그(structured logs, JSONL 데이터셋)를 읽어야 한다. 오늘은 `bash`로 `cat`/`head`/`awk`/`jq` 파이프를 짜는 수밖에 없다 — quote handling 없음, ragged-row 진단 없음, malformed line 격리 없음, output cap 없음. 그 결과:
1. 양식이 살짝 깨진 CSV(unterminated quote, embedded newline)에서 모델이 잘못된 column count를 인식 → silent corruption.
2. NDJSON의 한 줄이 깨져 있으면 `jq -s` 통째로 fail → 나머지 멀쩡한 줄도 못 본다.
3. 100MB 덤프를 `cat`해서 컨텍스트 폭파.

ADR-0126(`read_image`) 패턴을 그대로 적용 — pure 파서 + thin tool wrapper + caller-deferred registration.

## 결정

본 ADR은 **2 tools + 2 pure parsers**다 (각 part는 default-OFF / caller-deferred-registration 보존).

### Part 1 — `parseCsv` (pure, `src/tool/document/csv-parse.ts`)

RFC-4180 aware state-machine splitter. 동일한 no-throw 패턴 (`@/git/conflict-parser` 미러):

```ts
export interface CsvCell { readonly raw: string; readonly column: number }
export interface CsvRow  { readonly cells: ReadonlyArray<CsvCell>; readonly lineNumber: number }
export interface CsvParseDiagnostic {
  readonly kind: "unterminated-quote" | "ragged-row" | "empty-input"
  readonly line: number
  readonly message: string
  readonly column?: number  // OMITTED (not undefined) under exactOptional when absent
}
export interface CsvParseResult {
  readonly headers: ReadonlyArray<string> | null
  readonly rows: ReadonlyArray<CsvRow>
  readonly diagnostics: ReadonlyArray<CsvParseDiagnostic>
}
export const parseCsv: (source: string, opts?: CsvParseOpts) => CsvParseResult
```

State-machine 처리:
- `Field` / `Quoted` 두 상태. `Field` + `"`(셀 시작) → `Quoted`. `Quoted` + `""` → 리터럴 `"` emit, `Quoted` 유지(RFC-4180 escape). `Quoted` + `"` 단독 → `Field`.
- CRLF / LF 혼용 + quoted-cell 내부의 embedded `\n` verbatim 보존.
- **Unterminated quote** at EOF → `unterminated-quote` diagnostic + best-effort row (데이터 손실 없음).
- **Ragged row** → `ragged-row` diagnostic + 그 row STILL emitted (caller가 drop 여부 결정).
- **Empty input** → `empty-input` diagnostic + headers:null + rows:[].
- Non-string input → `CsvParserInputError` throw (programmer bug — 도메인 fail 아님).

### Part 2 — `parseNdjson` (pure, `src/tool/document/ndjson-parse.ts`)

```ts
export interface NdjsonLine<T = unknown> {
  readonly lineNumber: number
  readonly value: T | null
  readonly raw: string
  readonly error?: string  // OMITTED under exactOptional when successful
}
export interface NdjsonParseResult {
  readonly lines: ReadonlyArray<NdjsonLine>
  readonly errorCount: number
}
```

각 non-blank line을 `JSON.parse` (try/catch) — 실패는 `value:null, error:<msg>`로 surface하고 errorCount++. blank/whitespace-only line은 skip(errorCount에 포함 안 함). CRLF 끝 `\r` 자동 strip.

### Part 3 — `csv_read` 도구 (`src/tool/document/csv-read.ts`)

- `name: "csv_read"` / `isReadOnly: () => true` / `isConcurrencySafe: () => true` / no `hitlTier`
- `inputSchema`:
  - `path: z.string().min(1)` — repo-relative or absolute
  - `delimiter?: z.string().optional()` — default `","`, e.g. `"\t"` for TSV
  - `noHeader?: z.boolean().optional()` — default false
  - `maxRows?: z.number().int().positive().max(1000).optional()` — default 100
- **Path safety** (`read_image` 동일 posture):
  - relative → `path.resolve(ctx.cwd, input.path)` 후 cwd 안 verify (`..` traversal 차단)
  - absolute → explicit user consent로 통과
  - leaf-symlink reject (`lstat().isSymbolicLink()`)
- **No-throw**: 모든 실패가 typed `ok:false` `ToolResult` (zod / abort / outside cwd / ENOENT / symlink / not-file / read failure)
- **Output cap**: 50_000 chars (`CSV_READ_MAX_OUTPUT`)

OK 출력:
```
CSV: <path> (N rows total, K diagnostics)
Headers (4): name, age, city, country
Rows (showing 100):
  1. ["Alice", "30", "NYC", "US"]
  ...

Diagnostics:
  line 42: ragged-row — 3 cells (expected 4)
```

### Part 4 — `ndjson_read` 도구 (`src/tool/document/ndjson-read.ts`)

`csv_read`와 동일한 path-safety / no-throw posture. 출력:
```
NDJSON: <path> (N lines, K parse errors)
Lines (showing 100):
  L1: {"a":1}
  L2: <ERROR: Expected ',' or '}' after property value>
  ...
```

### Part 5 — Barrel export (registration deferred)

`src/tool/document/index.ts`가 `parseCsv` / `parseNdjson` / `csvReadTool` / `ndjsonReadTool` + 각 schema/상수/error class를 export.

**Registration은 `buildDefaultTools()`에 박지 않음** — `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`(이 ADR이 수정하지 않음, 사용자 in-flight)에 새 tool entry를 추가해야 `mode-mutating-table.test.ts`의 ADR-0036 cross-check가 통과. ADR-0126/0127의 caller-deferred 패턴을 재사용.

미래 wire 1줄 (별도 PR, atomic with mode table):
1. `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`에 `csv_read: null`, `ndjson_read: null` 추가.
2. `buildDefaultTools()` 또는 `tier1/document.ts` 빌더에 두 tool을 등록.

## Default-OFF

본 ADR은 dispatch / loop / mode-table 어디도 건드리지 않는다. 가치:
1. **tool surface가 박혔다** — 미래 caller가 import해서 wire하면 즉시 작동.
2. **pure parsers가 typed contract로 자리잡았다** — `@/git/conflict-parser`와 동일한 no-throw 패턴, 다른 caller가 재사용 가능 (eg. workingState dump, JSONL 세션 inspector).
3. **`csv-read-hellgate` / `ndjson-read-hellgate`가 28-case 봉인** — RFC-4180 corner case + ragged row + unterminated quote + malformed JSON line이 typed diagnostic으로 surface된다는 invariant이 회귀하지 않게.

## Hellgate (28 tests / 97 expects, all green)

`tests/unit/tool/csv-read-hellgate.test.ts` (16):
- **A. parseCsv pure (8)**: simple 3-row / TSV / quoted comma / escaped `""` / CRLF / unterminated quote / ragged row / empty input
- **B. csv_read tool (8)**: metadata / happy / missing / maxRows cap / noHeader / TSV delimiter / path traversal / empty path string

`tests/unit/tool/ndjson-read-hellgate.test.ts` (12):
- **A. parseNdjson pure (5)**: 3 valid / malformed mid-stream / blank lines skipped / mixed CRLF/LF / empty
- **B. ndjson_read tool (7)**: metadata / happy / missing / maxLines cap / `<ERROR: ...>` rendering / path traversal / empty file

## Alternatives rejected

1. **PDF reader** — `pdf-parse`/`pdfjs-dist` 등 lib install이 차단된 환경(verify-workflow.md). Phase 2.
2. **XLSX reader** — `xlsx`/`exceljs` install 차단. Phase 2.
3. **YAML reader** — `js-yaml` 또는 자체 구현. dep 추가 vs. ~200 LOC 자체 구현 tradeoff. Phase 2 — 본 ADR scope에 묶으면 deps 결정과 RFC가 늘어남.
4. **3rd-party CSV lib (`papaparse` / `csv-parse`)** — 둘 다 풍부한 옵션을 제공하지만 zero-dep RFC-4180 state-machine이 ~150 LOC로 충분 (state는 2개, transition은 6개). conflict-parser와 동일한 plane-clean posture를 위해 inline 선택. 미래에 fixed-width / pipe-sep 등 추가가 필요해지면 그때 lib 평가.
5. **Streaming parser (`createReadStream` + 청크 단위)** — large file에서 메모리 이점이 있지만 today의 `csv_read`는 `maxRows` × cell 길이로 출력 cap이 걸려 있고 어차피 전체를 메모리에 올린 뒤 cap한다. streaming은 GB-scale 파일이 흔해지면 도입.
6. **dispatch / mode-table wire** — 사용자 in-flight (loop.ts / recovery.ts / dispatch.ts 다른 트랙). ADR-0126/0127과 같은 caller-deferred 패턴.
7. **자동 type inference (`age: 30` → number, `active: true` → boolean)** — RFC 4180은 모든 셀이 string. inference는 lossy(`"007"`이 `7`로 변환되면 zip code 깨짐). Phase 2에서 per-column opt-in으로 추가.

## SOTA++ 자리매김

| Agent | CSV reader | NDJSON reader | RFC-4180 quote | ragged-row diag | per-line error |
|---|---|---|---|---|---|
| Cursor | bash + cat/awk | bash + jq | n/a | n/a | n/a |
| Codex | bash + cat/awk | bash + jq | n/a | n/a | n/a |
| Claude Code | bash + cat/awk | bash + jq | n/a | n/a | n/a |
| **quanta (이전)** | bash | bash | n/a | n/a | n/a |
| **quanta (본 ADR)** | `csv_read` | `ndjson_read` | ✅ (state-machine) | ✅ (typed) | ✅ (line-level isolation) |

= "text-format structured-data gap의 closed-port + RFC-4180 quote 정합 + per-line error isolation 흡수, dispatch wire는 caller-deferred". modern coding agent 중 **shell 없이 typed structured-data 도구를 가진 첫 구현**.

## Security posture

- **Path traversal**: relative `../../etc/passwd` → `path.resolve` 후 cwd 안인지 startsWith check. absolute는 user consent로 통과 (`git_diff` / `read_image` 동일 posture).
- **Leaf-symlink reject**: 모델이 `data.csv` → `/etc/secrets`로 우회하는 것 차단. `lstat`이 symlink 자체의 메타를 본다.
- **Output cap**: 50_000 chars로 truncate (`MAX_OUTPUT`).
- **maxRows / maxLines ceiling**: 1000 — model이 거대 덤프를 한 번에 끌어와 컨텍스트를 점령하는 것 방지.
- **No write**: `isReadOnly: () => true` — permission gate가 자동으로 read-only tier로 분류.

## Follow-up

- **defaults registration**: `MUTATING_TOOL_TABLE` 및 `buildDefaultTools()` wire 1줄 (별도 PR, mode-table과 atomic).
- **YAML reader**: `js-yaml` dep 결정 또는 자체 구현. 별도 ADR.
- **XLSX reader (Phase 2)**: install 가능 시점에 별도 ADR.
- **PDF reader (Phase 2)**: install 가능 시점에 별도 ADR.
- **Per-column type inference**: opt-in coercion (`infer:true` 옵션 또는 `coerce:{age:"int"}` 명시) — 별도 ADR, 본 ADR은 무손실 string 유지.
- **Streaming parser**: GB-scale CSV가 흔해지면 line-stream 변형. 현재는 전체 read.
- **CSV writer (`csv_write`)**: mutation tool, 별도 권한 surface.
