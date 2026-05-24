# ADR-0200: Stream idle timeout watchdog + snooze

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0183 (streaming-cancellation — typed cause), ADR-0178 (mid-turn interruption), ADR-0186 (distributed tracing — `quanta.stream.*` attrs)
- 슬롯: 0196~0199 모두 사용자 in-flight, 0200이 다음 free

## Context

LLM stream이 hung 되면 quanta는 영원히 `for await (const ev of src)`에 머무름. 모던 agent 2개 강신호:

- **Cursor 60s idle pause**: provider stream이 60초 silent이면 자동 abort + retry
- **Claude Code `withStreamTimeout`**: idle + total wall-clock 2-axis 감시

quanta는 adapter-side `streamTimeoutMs`(`src/llm/adapters/*`)는 있지만 LLM port → loop 경계에서 idle 감지 0. 사용자 입력(snooze) 시 일시 멈춤도 없음. hung LLM = hung turn.

3-vendor 중 2개 (Cursor + Claude)가 같은 신호 → 봉인 ROI 확정. install-blocked로 외부 lib (p-timeout) 도입 불가, 자체 10-라인 wrapper로 진행.

## Decision

신규 plane-clean 슬라이스 `src/agent/stream-timeout/`:

### Port (`port.ts`)

```ts
export interface StreamWatchdog {
  wrap<T>(
    src: AsyncIterable<T>,
    policy?: TimeoutPolicy,
    signal?: AbortSignal,
  ): AsyncIterable<T>
}
```

`policy` 없거나 `{idleMs, totalMs}` 둘 다 undefined ⇒ pass-through (byte-identical).

### Policy + errors (`types.ts`)

```ts
export interface TimeoutPolicy {
  readonly idleMs?: number
  readonly totalMs?: number
  readonly action: "abort" | "degrade" | "prompt-user"
  readonly snooze?: SnoozeController
}

export class StreamIdleError extends Error { readonly idleMs: number }
export class StreamTotalError extends Error { readonly totalMs: number }
export class StreamAbortError extends Error {}
```

3-action enum:
- `abort` (default): typed throw → 기존 recovery FSM이 same-turn retry
- `degrade`: return done (graceful — partial 결과 보존)
- `prompt-user`: 현재는 abort와 동일 + telemetry 라벨 분기 (Phase 2 surface 후 HITL hook)

### Default impl (`default-watchdog.ts`)

`Promise.race(it.next(), timeout)` 패턴. 매 step 새로운 setTimeout/clearTimeout. snooze 중에는 50ms sleep loop (idle counter 멈춤). external signal `aborted` 우선 검사.

### Snooze (`snooze.ts`)

```ts
export interface SnoozeController {
  pause(durationMs: number): void
  resume(): void
  isPaused(): boolean
}
```

CLI에서 `/snooze 5m` 슬래시로 활성. 사용자 입력 받는 동안 idle counting 멈춤 (long-running stream 도중 자료 검색 / 화장실 등).

### No-op fallback (`no-op-watchdog.ts`)

```ts
export const noOpWatchdog = (): StreamWatchdog => ({
  wrap: (src) => src,
})
```

assembly default. `config.streamWatchdog` 미설정 ⇒ 이걸 wire → loop는 그냥 source iterator 사용 (byte-identical).

## Algorithm

```ts
async function* wrap<T>(src, policy, signal): AsyncIterable<T> {
  if (!policy?.idleMs && !policy?.totalMs) {
    yield* src
    return
  }
  const it = src[Symbol.asyncIterator]()
  const startedAt = now()
  while (true) {
    if (signal?.aborted) throw new StreamAbortError(...)
    if (policy.snooze?.isPaused()) { await sleep(50); continue }
    if (policy.idleMs !== undefined) {
      const res = await Promise.race([it.next(), idleTimeout(policy.idleMs)])
      if (res.done) return
      yield res.value
    } else {
      const res = await it.next()
      if (res.done) return
      yield res.value
    }
    if (policy.totalMs && now() - startedAt > policy.totalMs) throw new StreamTotalError(...)
  }
}
```

매 iteration마다 setTimeout/clearTimeout 쌍 — 누수 0 (`finally` 블록).

## Wire

- `src/agent/loop.ts:300` `teeUsage`가 `config.streamWatchdog?.wrap(src, policy, config.signal) ?? src`를 forwarding. `streamWatchdog` 미주입 ⇒ `src` 그대로 (byte-identical).
- `AgentConfig.streamWatchdog?: StreamWatchdog` + `AgentConfig.streamTimeoutPolicy?: TimeoutPolicy` 옵션 슬롯 (둘 다 default-OFF)
- Assembly: `noOpWatchdog()` default. `QUANTA_STREAM_IDLE_MS`가 set이면 `defaultWatchdog()` swap (TBD — Phase 2 caller-wire)

## Consequences

- **Default-OFF byte-identical**: policy 미주입 / watchdog 미주입 ⇒ `teeUsage` 1줄 변경이 type-safe pass-through. 슬라이스 자체는 자동 wire 0.
- **OTel emit**: `quanta.stream.idle_ms` / `quanta.stream.total_ms` / `quanta.stream.timeout_action` attrs (ADR-0186 propagator) — 현재는 helper-only (Phase 2 metrics wire).
- **`p-timeout` swap 1줄**: install unblock 시 `defaultWatchdog` 내부 `Promise.race`를 `pTimeout`로 교체. port + 시그니처 불변.
- **Snooze 격리**: SnoozeController는 watchdog 외부 (CLI repl `/snooze`가 owner). policy.snooze 미주입 ⇒ pause 검사 skip (byte-identical).

## Alternatives rejected

1. **adapter-side만 사용 (현재 `streamTimeoutMs`)** — provider HTTP-level만 보호. loop-level hung은 못 잡음 (예: 모든 chunk가 빠르게 오지만 `tool_result` dispatch가 hung).
2. **`AbortSignal.timeout(ms)` 단일 fire** — 1번 fire 후 재시작 불가. per-event idle 재설정 안 됨.
3. **`p-timeout` 즉시 도입** — install-blocked. 10-라인 self-impl이 동일 시맨틱.
4. **action 단일 throw** — partial 결과 강제 폐기. `degrade` 옵션이 caller에게 결정 권한.
5. **snooze를 watchdog 내부 상태로** — 단일 watchdog이 여러 stream 보는 케이스(future)에서 leak. controller-as-port가 정답.

## Hellgate (15 cases)

`tests/unit/stream-timeout-hellgate.test.ts`:

- HELL-ST-01: policy 미주입 → byte-identical (event sequence equal)
- HELL-ST-02: idleMs=100, source 500ms silent → throws StreamIdleError (typed)
- HELL-ST-03: idleMs=100, source 50ms 간격 emit → 무사 통과
- HELL-ST-04: AbortSignal aborted → StreamAbortError, no leaked timer
- HELL-ST-05: snooze.pause(500ms) → 500ms 동안 idle 안 침. resume 후 재개
- HELL-ST-06: totalMs=200, source idleMs 안 침범해도 total 초과 → StreamTotalError
- HELL-ST-07: action="degrade" → idle 시 throw 대신 return done
- HELL-ST-08: source throw → watchdog propagates (no wrap)
- HELL-ST-09: source done 후 추가 next() 호출 안 함
- HELL-ST-10: 동시에 여러 watchdog 인스턴스 → 격리 (timer cross-talk 없음)
- HELL-ST-11: idleMs=0 → 첫 next()에서 즉시 timeout (edge)
- HELL-ST-12: idleMs undefined + totalMs only → idle 무시, total만 enforce
- HELL-ST-13: 외부 signal과 idle race → 첫 발생 reason 보존
- HELL-ST-14: source iterator 정확히 한 번씩 next() (no double-pull)
- HELL-ST-15: snooze 중 abort → StreamAbortError가 snooze보다 우선

15 pass / 0 fail.

## SOTA++ 자리매김

| Agent | idle detect | total cap | snooze | typed error | action policy |
|---|---|---|---|---|---|
| Claude Code | ✅ (`withStreamTimeout`) | ✅ | ❌ | string | abort only |
| Cursor | ✅ (60s) | ❌ | ❌ | string | abort + retry |
| Codex | ❌ | ❌ | ❌ | — | — |
| **quanta** | ✅ closed-port | ✅ | ✅ closed-port | typed (`StreamIdleError`/`StreamTotalError`/`StreamAbortError`) | 3-arm enum (`abort`/`degrade`/`prompt-user`) |

= "2-vendor 강신호 채택 + snooze는 우리 고유 (user-presence-aware) + 3-arm action으로 partial 결과 정책 결정권을 caller에 위임."

## Follow-up

- **CLI `/snooze 5m`**: REPL dispatch에 `SnoozeController` 주입 + 슬래시 추가 (Track D 스코프)
- **Metrics**: `stream_timeout_count{action}` counter (ADR-0144 MetricSink)
- **`prompt-user` action**: HITL surface에 idle 발생 → "still working?" prompt (Phase 2)
