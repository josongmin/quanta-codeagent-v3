# ADR-0074 — OTel span tree (Codex 10-step) — core 4-stage wrap

- **상태**: Accepted (default-OFF seam; behavior-preserving)
- **날짜**: 2026-05-21
- **관련**: [[codex-desktop-build-2867-round-4]] §1 (10-step span tree),
  [[codex-otel-attribute-vocabulary]] (span hierarchy 10-11단계),
  ADR-0032 (OTel canonical vocabulary), RFC §1.2 (default-OFF byte-identical),
  ADR-0010 (observability trajectory)

## 맥락

Codex의 hot-path는 턴마다 10–11 deep OTel span tree로 감싸여 있다 —
dispatch된 submission, 턴 자체, provider로의 sampling request, 그리고 모든
tool call이 각자 span 안에 중첩된다. 이 nested shape이 6,386-session corpus를
검색 가능하게 만든다 ("`session_loop{thread_id=…}` 아래에서
`handle_tool_call{name=bash}`이 5s를 넘긴 턴을 보여줘").

v3는 역사적으로 OTel span을 방출한 적이 없다 — flat AgentEvent (RFC-0002) +
in-process counter (`AgentRecorder`)만 있었다. OTel SDK를 전면 채택하면 모든
loop start에 dependency + runtime exporter를 강제하게 되어 RFC §1.2
(default-OFF byte-identical 계약)를 위반한다.

ADR-0032가 이미 canonical attribute vocabulary (`quanta.*` / `gen_ai.*`)를
제공하므로, span 방출 seam은 SDK 없이 그 vocabulary 위에 얹을 수 있다.

## 결정

1. **SDK-free span seam** (`src/observability/spans.ts`, 신규):
   - `SpanSink` interface — `onStart` / `onEnd` 2개 메서드. OTel / Honeycomb /
     JSONL 파일로의 실제 매핑은 consumer에 산다.
   - module-level mutable sink, 기본값 `null`. `null`이면 모든 span 호출이
     공유 frozen `NOOP_SPAN` sentinel을 반환 — 0 allocation, 0 branch.
   - `startSpan(name, attrs)` / `endSpan(span, status, attrs)` helper —
     canonical `try/finally` 패턴을 감싼다. `durationMs`는 monotonic
     `performance.now()`로 `endSpan`이 계산한다.
   - sink에서 throw된 예외는 catch + swallow — observability 버그가 agent
     loop를 abort하면 안 된다.
2. **Codex literal-parity span 이름** (`SPAN_NAMES`, frozen `as const`):
   `session_loop` / `session_task.turn` / `run_sampling_request` /
   `handle_tool_call` — downstream exporter / trace UI가 보는 이름이므로
   byte-stable.
3. **4-step wrap**:
   - `session_loop` — `runAgent`가 `runAgentInner`를 try/finally로 감싸는
     outermost ring. `quanta.conversation.id` + `quanta.thread.id` (둘 다
     sessionId) + `quanta.thread.kind = "main"`.
   - `session_task.turn` — turn loop 안에서 `runTurn` 호출을 감싼다.
     SAME-TURN retry는 새 span을 열지 않는다 (같은 turn id 유지). turn id는
     `activeTurnRef.current.currentTurn?.turnId` 재사용, 부재 시 fresh UUID.
   - `run_sampling_request` — `streamConsume`에서 provider stream call 1회당
     1 span. SAME-TURN retry는 새 HTTP/SSE call이므로 새 span을 연다.
   - `handle_tool_call` — `dispatch.ts`에서 dispatch 1회당 1 span (unknown-tool
     / dedup / gate-deny 이전에 open → admissible/rejected 모두 tree에 등장).
     `quanta.tool.name` + `quanta.tool.call_id`, close에 `quanta.tool.call.status`.
4. **Attribute discipline**: 모든 span attr은 ADR-0032 `QUANTA_ATTRS` /
   `attrs()` 빌더 경유 — `spans.ts` / `loop.ts` / `dispatch.ts`에 raw
   `quanta.*` 문자열 리터럴 0. vocabulary-orphan scan
   (`tests/unit/observability/vocabulary-migration.test.ts`)이 CI에서 enforce.

## Negative invariants (이 ADR이 채택하지 않는 것)

- **OTel SDK / OTLP exporter 번들**: seam은 `SpanSink` interface만 정의한다.
  실제 OTLP / Honeycomb / JSONL 매핑은 host (CLI / Tauri / Web surface)가
  별도로 구현 + `setSpanSink`로 wire. SDK dependency는 도입하지 않는다.
- **full 10-11 deep tree**: Codex의 전체 깊이 (mcp / sub-submission /
  per-event span 등)는 채택하지 않는다 — core 4 stage만. 더 깊은 span은
  follow-up ADR에서, 같은 seam 위에서.
- **first-class "blocked" tool status 채널**: gate-deny는 현재 non-ok
  DispatchResult를 반환하므로 `quanta.tool.call.status = "error"`로 surface.
  enum union에 `"blocked"`는 있으나 dispatch seam에 전용 signal이 아직 없다.
- **span sink stack / fan-out**: 한 번에 sink 1개만 active. multi-fanout은
  registration 시점에 composite sink로 합쳐서 등록.

## 영향

- `src/observability/spans.ts` 신규 + `observability/index.ts` re-export.
- `loop.ts`: `runAgent` → `runAgentInner` 분리 (body 무변경, 외곽 try/finally만
  추가) + `streamConsume` / turn loop에 span open/close. 모든 close는 단일
  finally / 단일 site → 예외/abort에도 span이 항상 닫힌다.
- `dispatch.ts`: `dispatchTool` → `dispatchToolInner` 분리 + 외곽 span wrap.
- **default-OFF**: sink 미등록 시 모든 helper가 NOOP_SPAN sentinel 반환 →
  loop hot-path는 stack-allocated 함수 호출 몇 개로 byte-identical.
- `runAgentInner`의 biome cognitive-complexity warning (36 → 44)은 기존
  `runAgent`가 이미 가지고 있던 warning의 연장 — error 아님, gate 통과.

## 테스트

- `tests/unit/observability/spans.test.ts` — no-op default (0 alloc, sentinel
  identity), sink wiring (onStart/onEnd 순서 + attrs + duration + status),
  defense-in-depth (throwing sink가 caller로 전파 안 됨), Codex literal parity.
- `tests/integration/spans-e2e.test.ts` — 실제 `runAgent` 1턴 drive로 4 span이
  올바른 nesting (session_loop first/last) + attribute schema로 open/close됨을
  검증; default-OFF tripwire (sink 미등록 ⇒ 0 event); tool-error ⇒
  `handle_tool_call` status `"error"`.
- vocabulary-orphan scan (`vocabulary-migration.test.ts`) green — 신규 파일에
  raw `quanta.*` 리터럴 0.
