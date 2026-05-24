# ADR-0142: Wire finalization — web-search env factory + document-tools default registration

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0127 (`web_search` closed-port + `AgentConfig.webSearch.provider` slot), ADR-0133 (Brave / DuckDuckGo provider impls + 5 document/structured-data tools), ADR-0137 (yaml/pdf/xlsx extensions of ADR-0133), ADR-0119 (default-OFF + atomic-table-update pattern — voice/structure mirror)
- **참조**:
  - `src/tool/web/providers/from-env.ts` — 신규 env-var → `WebSearchProvider` 팩토리
  - `src/tool/web/providers/index.ts` — barrel 한 줄 추가
  - `src/agent/mode.ts` — `MUTATING_TOOL_TABLE` 5 entry 추가 (csv/ndjson/yaml/pdf/xlsx ⇒ null)
  - `src/tool/index.ts` — `buildDefaultTools()` 에 5 tool 추가 + import
  - `tests/unit/tool/web-search-from-env-hellgate.test.ts` — 5 case
  - `tests/unit/document-tools-defaults-registration-hellgate.test.ts` — 6 case

## Context

ADR-0127 / 0133 / 0137 은 각자 surface 를 박았지만 caller-wire 한 단을 의식적으로 미장치로 남겼다:

1. **web-search provider 의 env-driven 팩토리 부재**. `braveSearchProvider` / `duckduckgoSearchProvider` 둘 다 shipped, `AgentConfig.webSearch.provider` slot 존재 — 그런데 "BRAVE_SEARCH_API_KEY 있으면 Brave, 없으면 DDG 폴백 (또는 미주입)" 의 한 줄 wire 가 caller 마다 중복 작성됐다.
2. **5 document/structured-data tool 의 `buildDefaultTools` 미등록**. `csv_read` / `ndjson_read` / `yaml_read` / `pdf_read` / `xlsx_read` 는 barrel-export 되었지만 default fence 밖이라 모델이 tool catalog 에서 보지 못함. 블로커: `MUTATING_TOOL_TABLE` 미분류 시 `mode-mutating-table.test.ts` 가 `UnknownToolError` 로 깨짐 — atomic 한 단으로 closer 가 필요.

본 ADR 은 두 wire 를 surgical 하게 마감한다.

## Decision

### Part A — `providerFromEnv` 신규 (`src/tool/web/providers/from-env.ts`)

```ts
export const providerFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): WebSearchProvider | undefined => {
  const braveKey = env.BRAVE_SEARCH_API_KEY
  if (braveKey !== undefined && braveKey.length > 0) {
    return braveSearchProvider({ apiKey: braveKey })
  }
  if (env.QUANTA_WEB_SEARCH_DUCKDUCKGO === "1") {
    return duckduckgoSearchProvider()
  }
  return undefined
}
```

- **Imports**: `./brave`, `./duckduckgo`, `../search` 의 port type 만. RFC §3.1 slice fence 유지 (providers 자체와 동일 fence).
- **DI seam**: `env` 인자 — 테스트가 `process.env` 오염 없이 hermetic snapshot 주입.
- **Precedence** (의식적):
  1. `BRAVE_SEARCH_API_KEY` non-empty ⇒ Brave (primary, higher quality)
  2. `QUANTA_WEB_SEARCH_DUCKDUCKGO === "1"` ⇒ DDG (LIMITED — Instant Answer 만)
  3. else ⇒ `undefined` (`webSearchTool` 가 ok:false 로 graceful degrade)
- **Explicit wiring wins**: composition root 가 `AgentConfig.webSearch.provider` 에 hand-built provider 박으면 본 헬퍼는 호출 안 함. 본 헬퍼는 "just works" 디폴트일 뿐.

### Part B — Document tools 5종 default 등록 (atomic)

두 leg 한 commit:

1. **`src/agent/mode.ts` `MUTATING_TOOL_TABLE`** — `read_image` / `web_fetch` 다음 줄 그룹에 5 entry 추가:
   ```ts
   csv_read: null,
   ndjson_read: null,
   yaml_read: null,
   pdf_read: null,
   xlsx_read: null,
   ```
2. **`src/tool/index.ts` `buildDefaultTools()`** — 5 tool factory append (`readImageTool` / `webFetchTool()` 패턴 미러). Import 5 줄을 `./document` barrel 에서. 알파벳 정렬 대신 ADR-0133/0137 그룹으로 묶음 — 주석으로 의도 표시.

두 leg 가 atomic 하게 land 되어 `mode-mutating-table.test.ts` cross-check 가 한 번도 깨지지 않음.

## Default-OFF posture (재확인)

- **Part A**: `providerFromEnv()` 는 env 미설정 ⇒ `undefined` 반환. `AgentConfig.webSearch.provider` 도 optional. 미주입 ⇒ `webSearchTool` 이 ok:false (no provider wired) — 기존 ADR-0127 graceful degrade 와 byte-identical.
- **Part B**: 5 document tool 은 **read-only + concurrency-safe** (순수 disk-read + parse — FS write 0, shell 0, network 0). always-on safe by construction. plan-mode 에서도 통과.

## Hellgate count — 11

| 파일 | 케이스 | 내용 |
|---|---:|---|
| `tests/unit/tool/web-search-from-env-hellgate.test.ts` | 5 | env 매트릭스 (no env / brave / empty brave / ddg / 양쪽 ⇒ brave wins) |
| `tests/unit/document-tools-defaults-registration-hellgate.test.ts` | 6 | 5 tool default-registered + table=null cross-check |

## Alternatives rejected

1. **5 document tool 을 per-tool tier1 builder (`src/agent/tier1/document.ts`) 로 default-OFF gate**
   - shadow / branch-search 패턴 미러처럼 보이지만, 그 두 ADR 의 default-OFF 는 **destructive primitives (shadow rewind / speculative branch)** 라서 의식적 opt-in 가치가 컸다. read-only document parser 는 그 비용/이득 비율이 정반대 — 모델이 catalog 에서 안 보이면 그냥 시스템이 "이 파일은 못 읽는다" 처럼 거짓말함.
   - 거부 — 항상-on (`buildDefaultTools` 직접 등록).

2. **provider 자동 인스턴스화를 `src/agent/features.ts` 안에서 (`if (env.BRAVE_SEARCH_API_KEY) config.webSearch = …`)**
   - LLM/agent config 컴포지션이 env var 와 직접 결합 — surface 가 늘어남 (test 마다 env 격리 필요).
   - 거부 — env 읽기는 composition root (apps/*) 의 책임. `providerFromEnv` 는 **함수** 일 뿐, 호출은 caller 가.

3. **`mode-mutating-table.test.ts` 에 5 새 tool 의 plan-mode 거동 직접 assert 추가**
   - 본 ADR 의 hellgate 가 이미 `table[name] === null` + `isMutatingTool(name) === false` 양쪽 박음. mode 테스트는 cross-check (drift 검출) 가 단일 책임 — 거기에 ADR 별 hellgate 를 섞으면 grep-by-ADR 가 어려워짐.
   - 거부 — 별도 hellgate 파일 유지.

4. **`providerFromEnv` 가 polymorphic env 키 검사 (예: `OPENAI_WEB_KEY` / `BING_KEY` 도 readiness check)**
   - YAGNI. 현재 ship 된 provider 는 2 종 (Brave + DDG). 새 provider 추가 시 본 헬퍼에 한 줄 더하면 됨.
   - 거부 — 2-provider only, 명시 precedence.

5. **`QUANTA_WEB_SEARCH_DUCKDUCKGO` 가 아닌 `WEB_SEARCH_PROVIDER=duckduckgo` 같은 enum 키**
   - 우아하지만 enum 값 typo 의 silent failure 위험. 1/0 boolean 으로 좁히면 "정확히 1 일 때만 활성" 의 명시적 의도.
   - 거부 — boolean 키 (`"1"` strict equality).

## Follow-up (이 ADR 이 닫지 않음)

- **per-tool tier1 builder for `csv_read` / `ndjson_read`** — caller 가 특정 data file 만 노출하고 싶을 때 selective gating. 현재 use-case 부재, 요청 시.
- **provider chain (try brave → fallback DDG)** — 한 turn 안에서 Brave 가 timeout 시 DDG 로 fallback. 본 헬퍼는 *static selection* 만, dynamic chain 은 별도 ADR.
- **env-driven provider 외 `~/.config/quanta/web-search.toml` 같은 file-driven config** — host preference 가 환경 변수보다 안정적인 surface 일 수 있음. ADR-0094 (oauth credentials store) 패턴 미러로 가능.
- **`xlsx_read` real impl** — 현재 `xlsxReadTool` 은 의도적 stub (ADR-0137 의 deferral). xlsx parser dep 박을 때 default fence 안에 이미 있어서 surgical.
