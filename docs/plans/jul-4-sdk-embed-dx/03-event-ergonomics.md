# Phase 3 — 이벤트 인체공학 (체감 DX 본체)

어딧 D 해소. **"오지게"의 절반.**

## 기능 / 왜

- (기능) push-only `StreamPort.emit`을 async-iterable + 축약 콜백 + narrowing으로 승격.
- (왜) [40+ variant AgentEvent](../../../src/stream/types.ts) raw switch는 소비자 지옥. 파이프라인 ingest가 주 유스케이스.

## Tasks

3.1 **async-iterable 어댑터** — 내부 bounded 큐. `stream.emit(e)`가 큐 push, `run()`이 `AsyncIterable<AgentEvent>` 노출. `done`/`error`에서 종료.
3.2 **`AgentRun`** = `AsyncIterable<AgentEvent> & PromiseLike<AgentOutcome>`. `for await` = 스트리밍, `await` = 결과만. 둘 다 지원(thenable).
3.3 **축약 콜백 `RunHooks`** — 40개 중 상용 6종 승격: `onText, onThinking, onToolCall, onToolResult, onUsage, onDone, onError`. 내부에서 이벤트→콜백 dispatch. `opts.onEvent` raw sink와 병행 가능.
3.4 **narrowing 헬퍼** `src/sdk/events.ts` — `isToolCall/isText/isToolResult/isUsage/isDone(e)` 타입가드 + `AgentEvent` 타입 공개 re-export.
3.5 **버퍼 정책** — bounded 버퍼(`eventBufferSize`, 기본 1024). **정정(구현 확정):** `StreamPort.emit`이 sync/void + `runAgent`가 소비와 무관하게 완주 → 단일스레드에서 producer 블로킹 물리적 불가. 따라서 "유실 0 블록"이 아니라 **drop-oldest + `droppedEvents` 카운트**. sync `hooks`/`onEvent`는 무손실(모든 이벤트 즉시 dispatch). 무손실 스트리밍 원하면 버퍼를 런 크기로 잡거나 hooks 소비. abort 시 iterator clean 종료.

## Hellgate

- RED: `events.test.ts` — 스크립트된 fake로 `for await` 이벤트 시퀀스 assert + `await run()` outcome 동시 검증.
- 적대 어딧 R1-3: (a) 느린 소비자 이벤트 유실/순서, (b) `await`와 `for await` 동시 사용 시 이중소비, (c) error 이벤트가 `onError`+iterator throw 양쪽 일관, (d) abort 중 iterator leak.

## Acceptance

- [ ] `for await`로 tool_call→tool_result→done 순서 관측.
- [ ] `await run()`이 동일 실행에서 outcome 반환(이벤트 미소비해도).
- [ ] 버퍼 상한 초과 시 유실 0(emit 블록 or 백프레셔).

## Files

- `src/sdk/run.ts` (AgentRun/큐), `src/sdk/events.ts` (신설)
- `tests/unit/sdk/events.test.ts` (신설)
