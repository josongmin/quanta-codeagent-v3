# ADR-0060: defineTool — output-schema + toModelOutput + deferred + streaming-input (v0.dev `createProviderToolFactoryWithOutputSchema` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0016(도구 1급화), RFC §6.2(Tool 계약), `v0-dev-feature-review.md` §S급-6(Tool Factory). v0.dev anon 크롤(`bench-out/v0/snapshot-2026-05-21T05-09-54-966Z`).

## 맥락

v0.dev 클라이언트 번들 역분석에서 도구 등록 팩토리 `createProviderToolFactoryWithOutputSchema({ id, inputSchema, outputSchema, supportsDeferredResults }) → ({ execute, needsApproval, toModelOutput, onInputStart, onInputDelta, onInputAvailable })`가 노출됐다. v3의 `Tool<I>`는 `inputSchema`만 Zod로 강제하고 결과는 자유 텍스트(`ToolResult.output`)였다. 노출된 4개 능력:

- **outputSchema**: 결과도 Zod 강제 → 어기면 모델에 retry 지시.
- **toModelOutput**: 도구 결과를 모델용(compact)과 UI용으로 분리 변환 → 토큰 절약.
- **supportsDeferredResults**: 오래 걸리는 도구를 비동기 deferred handle로.
- **onInputStart/Delta/Available**: tool input 스트리밍 중 점진 UI 렌더.

## 결정

`@/tool` 슬라이스에 4개 능력을 **전부 OPTIONAL**로 추가. 미사용 도구는 byte-identical.

- `Tool<I, O = unknown>`로 일반화 + OPTIONAL 멤버: `outputSchema?`, `toModelOutput?(result)`, `supportsDeferredResults?`, `onInputStart?/onInputDelta?/onInputAvailable?`.
- 신규 `src/tool/factory.ts`: `defineTool(spec)` + 순수 헬퍼 `validateToolOutput`(결과 `{ok:true,value}|{ok:false,error}`), `enforceOutputSchema`(불일치 → `ok:false` retry-지시 ToolResult, **throw 안 함**), `renderModelOutput`(toModelOutput 있으면 그것, 없으면 `result.output`), `driveStreamingInput`(delta 시퀀스로 콜백 구동).
- 신규 `src/tool/deferred.ts`: `DeferredResultRegistry`(순수 in-memory register/resolve/poll/evict) + `UnknownDeferredHandleError extends QuantaError`. deferred는 `ToolResult.deferred?: DeferredHandle` 필드로 표현.

## 근거

- **`ToolEvent` union 불변**: deferred를 별도 event variant로 추가하면 `event.type === "result"` 내로잉에 의존하는 기존 호출부(registry.ts, 다수 테스트)가 전부 깨진다(byte-identical 위반). deferred는 terminal `result`의 OPTIONAL 필드로만 실어 union을 `progress | result` 2-variant로 유지.
- **검증 실패는 throw 아닌 retry-지시**: outputSchema 불일치를 예외로 던지면 loop가 죽는다. v0처럼 `ok:false` + 재시도 안내 메시지로 모델에 되돌려 self-heal.
- **슬라이스 격리**: factory/deferred/types는 `@/shared` + `zod`만 import — `@/permission`/`@/agent`/`@/llm` 미import(biome noRestrictedImports 준수).
- **순수 seam, default-OFF**: streaming-dispatch 배선은 follow-up. 현재는 순수 헬퍼 + 타입 계약만 — 즉시 채택 가능하되 기존 동작 0 변경.

## 대안

- **deferred를 ToolEvent variant로**: 기각 — 위 byte-identical 위반(실제로 시도했다가 registry.ts + 5개 테스트 회귀 발생, 되돌림).
- **outputSchema 위반 시 throw**: 기각 — loop 사망. self-heal 불가.
- **즉시 streaming-dispatch 배선**: 보류 — 범위 비대 + 라이브 dispatch 충돌 위험. seam만 먼저.

## 결과·트레이드오프

- **얻은 것**: 도구 결과 계약 강화(out Zod), 토큰 절약(toModelOutput), 장기 도구 seam(deferred), 점진 입력 콜백. 18 unit / 45 expects green. tsc/biome clean.
- **비용**: `Tool` 제네릭이 `<I, O>`로 1개 늘어남(기본값 `unknown`이라 기존 `Tool<I>` 호출부 무영향).

## 한계 (LIMITATIONS)

- (a) `driveStreamingInput`은 순수 헬퍼 — live streaming-dispatch 매핑(`tool_use_start/delta/end`)은 `// TODO(absorb #1)` follow-up.
- (b) `DeferredResultRegistry`는 타입 seam + 순수 poller. 실제 비동기 스케줄러는 loop 미배선.
- (c) outputSchema 검증의 dispatch-seam 배선도 follow-up — 현재 `enforceOutputSchema`는 호출자가 직접 부른다.

## 불변식 영향

- **byte-identical default**: 4개 능력 미사용 도구는 등록·실행 경로 무변경.
- **`ToolEvent` 2-variant 유지**: 모든 기존 `switch(event.type)` 내로잉 보존.
- **슬라이스 격리 유지**: `@/tool`은 상향 import 0.
- **신규 npm dep 0**.
