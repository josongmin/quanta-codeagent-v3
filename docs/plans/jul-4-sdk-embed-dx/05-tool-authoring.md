# Phase 5 — 툴 authoring 재수출

## 기능 / 왜

- (기능) `defineTool`/`defineToolAsync` + `Tool`/`ToolContext`/`ToolEvent` 타입을 공개 문에서 re-export.
- (왜) 이미 존재([factory.ts:57](../../../src/tool/factory.ts), [async-helper.ts:86](../../../src/tool/async-helper.ts)). 공개만 하면 소비자가 zod 스키마로 repo-분석 툴 작성.

## Tasks

5.1 **재수출** `src/sdk/tools.ts` — `defineTool, defineToolAsync` 값 + `Tool, ToolContext, ToolEvent, ToolRegistry` 타입. `execute(input, ctx): AsyncIterable<ToolEvent>` 계약 그대로.
5.2 **레퍼런스 툴** — repo grep/dep-graph 예제 1개(`examples/` or 문서 인라인). copy-paste 시작점. quanta 내부 툴 import 아니라 순수 `defineTool` 사용 예시.
5.3 **주입 경로 문서화** — `createAnalysisAgent({ tools: [myTool], includeDefaultTools })` 흐름.

## Hellgate

- RED: `tools.test.ts` — `defineTool`로 만든 툴이 `createAnalysisAgent`에 주입되어 fake-driven 세션에서 호출·결과 관측.
- 적대 어딧 R1-3: (a) 중복 name 등록 시 명확한 에러(`ToolRegistrationError`, Phase 7), (b) zod 파싱 실패 전파, (c) `ctx` 계약(cwd/signal) 노출 여부.

## Acceptance

- [ ] 소비자 정의 툴이 세션에서 호출되고 `tool_result` 이벤트 관측.
- [ ] 공개 문에서만 import해서 툴 정의 가능(내부 `@/tool` 불필요).

## Files

- `src/sdk/tools.ts` (신설)
- `tests/unit/sdk/tools.test.ts` (신설)
- `docs/plans/jul-4-sdk-embed-dx/examples/dep-graph-tool.ts` (예제)
