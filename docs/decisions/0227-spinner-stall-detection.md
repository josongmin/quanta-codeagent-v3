# ADR-0227: Spinner stall detection (B6 — Claude Code `tengu_spinner_stalled_ui` 흡수)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0200 (stream-idle-timeout — 같은 신호 다른 액션), ADR-0093 (effect-channel — sink seam 패턴), ADR-0221 (auto-background-stuck-detector — 인접 idle 검출 슬라이스)
- 슬롯: 0221~0226 중 0221 더블, 나머지 비어있어 0227이 다음 안전 free

## Context

Claude Code CLI에 `tengu_spinner_stalled_ui` + `tengu_spinner_stall_cleared` 텔레메트리 쌍이 있다. N초간 LLM token/event가 도착하지 않으면 surface가 "still working… [r]etry / [a]bort" 패널을 띄워 사용자에게 *부드러운* 신호를 보낸다. 30s가 기본값.

quanta에는 이 신호가 없다:

- `src/apps/cli/idle-monitor.ts` — **user input** idle만 정의 (사용자가 키보드를 안 두드리는 시간), model stream 무관
- ADR-0200 (`src/llm/stream-timeout.ts` + `src/agent/stream-timeout/`) — 60s/120s 후 **hard abort** 만. 사용자에게 "조금 더 기다릴래요?" 묻는 단계가 없다

= "abort가 유일한 반응" 갭. Claude는 *abort 전에* soft signal로 사용자에게 선택권을 준다 (실제 stream은 살아있음). 우리도 같은 UX 가능성을 봉인할 필요.

## Decision

신규 plane-clean 슬라이스 `src/llm/spinner-stall/`:

### Port (`port.ts`)

```ts
export interface SpinnerStallDetectorPort {
  start({ correlationId, stallThresholdMs, now }): void
  tickEvent({ correlationId, now }): void
  stop({ correlationId }): void
  checkAll({ now }): readonly StallEvent[]  // { correlationId, stalledForMs }
}
```

순수 book-keeping. detector 자체는 IO/event emit 0 — pull-based polling만 답한다. 시계는 모든 메서드 인자로 주입 (no global `Date.now`).

### Default impl (`default-detector.ts`)

`Map<correlationId, { lastEventMs, thresholdMs }>` 기반. `checkAll`은 `lastEventMs + threshold < now`인 entry만 픽. 멱등 — `start` 두 번 호출하면 reset, `stop` 미존재 id는 no-op.

### Edge-triggered emitter (`event-emitter.ts`)

```ts
export interface SpinnerStallSink {
  emit(event: SpinnerStallEvent): void
}

export type SpinnerStallEvent =
  | { kind: "spinner-stalled", correlationId, stalledForMs }
  | { kind: "spinner-stall-cleared", correlationId }
```

`poll(now)`마다 detector.checkAll 결과를 내부 "이미 stall로 신고한 set"과 diff → edge transition만 emit. 매 poll spam 방지 (Claude Code도 동일하게 edge-triggered).

`forceClear(id)` — `stop` 직후 surface에 즉시 cleared 알림 (다음 poll까지 latency 0).

### Stream-timeout hook (`src/llm/stream-timeout.ts`)

`StreamTimeoutOptions`에 optional `onChunk?: () => void` 추가. 매 yield 직전 1줄 호출:

```ts
notifyChunkArrival(opts.onChunk)  // best-effort, exception swallowed
```

`onChunk` 미주입 ⇒ 빈 함수 호출조차 안 함, byte-identical. 호출 site (provider adapter)가 `() => detector.tickEvent({ correlationId, now: Date.now() })`를 주입하면 자동 wire.

### 지식 (3 file + 1 hook)

| File | Role |
|---|---|
| `src/llm/spinner-stall/port.ts` | Closed port + types |
| `src/llm/spinner-stall/default-detector.ts` | Map-backed impl (pure) |
| `src/llm/spinner-stall/event-emitter.ts` | Edge-triggered reactor + sink port |
| `src/llm/spinner-stall/index.ts` | Barrel + `DEFAULT_SPINNER_STALL_THRESHOLD_MS = 30_000` |
| `src/llm/stream-timeout.ts` (mutation 최소) | +1 optional knob `onChunk` + 1 hook line via top-level helper |

## Knobs

- `spinnerStall.thresholdMs` — `start`에 인자로 전달. Default 30_000ms (Claude parity)
- `DEFAULT_SPINNER_STALL_THRESHOLD_MS` 상수 export

## Default-OFF

- detector 미구축 ⇒ `onChunk` 미주입 ⇒ stream-timeout이 빈 분기로 통과
- detector 구축했지만 `start` 안 함 ⇒ `tickEvent`는 unknown id ⇒ 즉시 return
- emitter 미구축 ⇒ poll 호출 자체가 없음, 어떤 sink emit도 없음

byte-identical 보장 3중 레이어. assembly default를 건드리지 않는다.

## Consequences

- **Surface 분리**: 이 슬라이스는 detector + event emit까지. CLI 패널 "still working… [r]etry / [a]bort"는 별도 트랙 (sink을 어떻게 paint하느냐). Tier 2/3 후속
- **ADR-0200와 직교**: stream-timeout은 hard abort (recovery FSM 트리거), spinner-stall은 soft signal (UX). 동일 stream에 둘 다 wire 가능 — 30s에 panel + 120s에 abort
- **Multi-correlation**: 단일 detector instance가 N 개 parallel sub-agent stream을 추적. 격리 보장 (per-id Map entry, 한 stall이 다른 sibling에 영향 X)
- **Memory hygiene**: `stop`이 Map.delete 해서 entry 제거 — turn 끝나면 GC. 외부에서 stop을 부르지 않으면 entry persist (의도 — UI가 stalled set을 보고 액션 결정해야 하므로)

## Algorithm

```ts
// detector
checkAll({ now }) {
  for ([id, entry] of entries) {
    if (now - entry.lastEventMs > entry.thresholdMs) {
      stalls.push({ correlationId: id, stalledForMs: now - entry.lastEventMs })
    }
  }
}

// emitter
poll(now) {
  fresh = detector.checkAll({ now })
  for f of fresh:
    if !stalled.has(f.id):
      stalled.add(f.id); sink.emit({ kind: "spinner-stalled", ...f })
  for prev of [...stalled]:
    if !fresh.find(p => p.id === prev):
      stalled.delete(prev); sink.emit({ kind: "spinner-stall-cleared", correlationId: prev })
}
```

엄격한 `>` 경계 — `now == lastEvent + threshold`는 stall 아님 (HELL-SPS-02). UI가 정확히 30s에서 oscillate 하지 않도록 한 frame 보수적.

## Alternatives rejected

1. **상시 `setInterval(checkAll, 1000)` 내장** — detector가 plane을 침범 + 테스트 시 무조건 fake timer 필요. pull 기반이 정답
2. **level-triggered emit** — 매 poll마다 "현재 stall중" 신고 ⇒ surface UI 도배. Claude Code도 edge로 가는 이유
3. **stream-timeout에 panel 코드 inline** — orchestration/effect 경계 침범 + UI 정책이 LLM transport에 박힘. sink port로 위임
4. **`firstChunk` timeout과 통합** — 의미 다름. firstChunk는 connection-level, spinner-stall은 mid-stream silence. 별 slice 유지
5. **`Set` 대신 `Map<id, stalledSinceMs>`** — emitter가 첫 stall 시점을 추적할 필요 없음 (detector가 매 poll 계산). `Set`이 더 가볍다

## Hellgate (15 cases / 14 HELL ids)

`tests/unit/spinner-stall-detector-hellgate.test.ts`:

- HELL-SPS-01: tickEvent 후 stall 0
- HELL-SPS-02: 경계 (now == lastEvent + threshold) ⇒ stall 0
- HELL-SPS-02b: threshold+1 ⇒ stall 1, `stalledForMs` 정확
- HELL-SPS-03: stop 후 stall 0 (10M ms 뒤에도 resurrection 0)
- HELL-SPS-04: 3-correlation 독립 (per-id 산수 검증, cross-talk 0)
- HELL-SPS-05: tickEvent로 stall-cleared (live recovery)
- HELL-SPS-06: emitter 3-poll-while-stalled ⇒ stalled event 1번만
- HELL-SPS-07: live recovery ⇒ emitter가 stalled + cleared 2개 emit
- HELL-SPS-08: stop + forceClear ⇒ cleared 1번 (2번째 forceClear는 no-op)
- HELL-SPS-09: default-OFF parity — detector 빈 채로 100 poll 후 events 0
- HELL-SPS-10: 시계 주입 — 32_503_680_000_000 (year 3000) 값으로 산수 검증
- HELL-SPS-11: start/stop 멱등 — 두 번 start 시 threshold/lastEvent 모두 reset
- HELL-SPS-12: empty Map checkAll ⇒ `[]` (Array.isArray true)
- HELL-SPS-13: 메모리 leak guard — stop 후 fresh start가 새 entry임을 행동으로 증명
- HELL-SPS-14: `DEFAULT_SPINNER_STALL_THRESHOLD_MS === 30_000` (Claude parity 봉인)

15 pass / 0 fail / 25 expects. 기존 `stream-timeout` 16+15 = 31 test 무회귀.

## SOTA++ 자리매김

| Agent | soft signal | hard abort | retry HITL | multi-correlation | typed event |
|---|---|---|---|---|---|
| Claude Code | ✅ `tengu_spinner_stalled_ui` (30s) | ✅ | ✅ panel "[r]/[a]" | ❌ (단일 turn) | telemetry str |
| Cursor | ❌ | ✅ 60s idle pause | ❌ (자동 retry) | ❌ | — |
| Codex | ❌ | ❌ | ❌ | ❌ | — |
| **quanta** | ✅ closed-port (30s default) | ✅ ADR-0200 (60s/120s) | (Tier 2 surface 트랙) | ✅ per-id Map | typed `SpinnerStallEvent` 2-arm |

= "Claude soft + Cursor hard 동시 봉인 + multi-correlation은 우리 고유 (parallel sub-agent 흡수 트랙과 동기) + 시계 + sink DI."

## Follow-up (이 slice 밖)

- **CLI surface (Tier 2)**: `SpinnerStallSink` impl로 `src/apps/cli/`에서 `still working… [r]etry / [a]bort` 패널 paint. ink-react 호환
- **Provider adapter wire (Tier 2)**: `src/llm/adapters/anthropic.ts` / `openai.ts`에서 `withStreamTimeout` 호출 시 `onChunk: () => detector.tickEvent({ correlationId: turnId, now: Date.now() })` 주입 + 턴 시작/끝에 `start`/`stop`
- **Telemetry counter (Tier 2)**: `spinner_stall_count` / `spinner_stall_recovered_count` (ADR-0144 MetricSink 후속)
- **HITL Retry prompt 액션**: ADR-0200의 `action: "prompt-user"`과 통합 — 30s panel에서 "wait" 선택 시 detector를 `stop`하여 abort 카운터 reset
