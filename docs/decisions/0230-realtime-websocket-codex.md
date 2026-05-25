# ADR-0230: Realtime WebSocket slice — 8 method surface (Codex absorption)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0202 (voice input one-shot leaf STT — sibling input-channel),
  ADR-0208 (voice `/voice` handle-based recorder + transcriber slice — this slice's
  sibling for continuous capture), ADR-0024 (slice-isolation rule the new
  `@/realtime` path obeys), ADR-0183 (streaming-cancellation AbortSignal cleanup
  semantics this slice mirrors), ADR-0192 (lib-swap default — Bun native
  `globalThis.WebSocket` rather than `ws` install)
- **References**: `src/realtime/**`,
  `tests/unit/realtime/realtime-hellgate.test.ts`

## Research grounding — Codex 8 realtime WS methods

Codex Desktop (build 2867, codex-rs 0.131.0-alpha.9) ships **8 realtime
WebSocket methods** that implement bidirectional voice + text streaming on top
of an SDP exchange + audio handoff path. Our voice slice today is one-shot
(ADR-0202/0208 `captureOnce` and handle-based `start/stop` + REST STT) — there
is **no bidirectional streaming surface** for either voice or text in quanta.

| Codex WS method | quanta gap | This slice |
|---|---|---|
| `realtime.connect(endpoint, auth)` | none | `RealtimePort.connect()` |
| `realtime.send(data)` | none | `RealtimePort.send()` |
| `realtime.onMessage(handler)` | none | `RealtimePort.onMessage()` |
| `realtime.negotiate(sdpOffer)` | none | `RealtimePort.negotiate()` (text-level SDP only) |
| `realtime.audio.start(format)` | none | `RealtimePort.audioStart()` (signal only) |
| `realtime.audio.stop()` | none | `RealtimePort.audioStop()` |
| `realtime.close(code, reason)` | none | `RealtimePort.close()` |
| `realtime.status()` | none | `RealtimePort.status()` |

The 8-method surface is **strong-signal** — Codex ships exactly this set with
the same names. quanta absorbs the surface; the on-the-wire actual WebRTC
media handoff and per-codec PCM/Opus encode/decode are deferred (see Scope
below) — this slice ships the port + a Bun-native adapter + a headless-stub
for deterministic tests.

## Context

Three things drift apart if collapsed:

1. **WS lifecycle** — `connect / close / status` is a 4-state machine
   (`connecting → open → closing → closed`). The state-machine MUST be
   queryable (HELL-RT-12) so surfaces can render "connecting…" without
   polling private fields. AbortSignal MUST cleanup mid-connect (HELL-RT-10)
   so cancelled connects don't leak zombie WS handles.
2. **Bidirectional data plane** — `send / onMessage` is symmetric with FIFO
   guarantees (HELL-RT-14). Binary frames (audio chunks) MUST round-trip
   unchanged (HELL-RT-15). `send` before `connect` MUST be a typed `Err`
   (HELL-RT-03), not a thrown — the surface branches on `kind`.
3. **SDP + audio control plane** — `negotiate(sdpOffer)` is a one-shot
   exchange returning `sdpAnswer`; `audioStart(format)` / `audioStop()` are
   outbound signals on the existing WS. The actual WebRTC `RTCPeerConnection`
   handoff and Opus/PCM encode/decode are out-of-scope for this MVP (the SDP
   exchange is text-level — the surface uses the answer to build its own
   peer connection if it wants media; this slice does not own media).

## Decision

Add one leaf-level port + adapters in `src/realtime/`:

- **`RealtimePort`** (`src/realtime/port.ts`)
  - `connect(opts): Promise<Result<void, RealtimeError>>` — open WS to
    `opts.endpoint` with optional `opts.auth` (Bearer header) and
    `opts.signal` (AbortSignal). Transitions `closed → connecting → open`.
    Idempotent guard: second concurrent `connect` returns
    `Err({kind:"already-connected"})` (HELL-RT-16).
  - `send(data): Result<void, RealtimeError>` — send a text or binary
    frame. Pre-connect returns `Err({kind:"not-connected"})` (HELL-RT-03,
    HELL-RT-11). Binary frames pass through unchanged (HELL-RT-15).
  - `onMessage(handler): () => void` — subscribe to inbound frames; returns
    unsubscribe. Multiple handlers allowed; ordering is registration order.
  - `negotiate(sdpOffer): Promise<Result<SdpAnswer, RealtimeError>>` — SDP
    text-level exchange via the negotiator pure function (HELL-RT-05/06/18).
  - `audioStart(format): Result<void, RealtimeError>` — emit
    `{type:"audio.start", format}` outbound (HELL-RT-07). Codec marker only;
    actual encode/decode is follow-up.
  - `audioStop(): Result<void, RealtimeError>` — emit `{type:"audio.stop"}`
    outbound (HELL-RT-08).
  - `close(code?, reason?): Promise<Result<void, RealtimeError>>` — graceful
    close; transitions `open → closing → closed`. Post-close `send` returns
    `Err({kind:"not-connected"})` (HELL-RT-11).
  - `status(): RealtimeStatus` — current state from the 4-enum (HELL-RT-12).

- **`createBunWebSocketAdapter()`** (`src/realtime/default-adapter.ts`) —
  Bun's native `globalThis.WebSocket` (no `ws` install). Handles
  open/message/close/error events; routes inbound frames to subscribers;
  AbortSignal aborts the open + closes if already-open.

- **`createHeadlessStub()`** (`src/realtime/headless-stub.ts`) — fully
  deterministic in-memory port for tests. Supports `inject({type,data})`
  for mock inbound frames + `outbound()` for assertion of what the surface
  sent. No real WebSocket. Pinned by HELL-RT-13.

- **`negotiateSdp(offer)`** (`src/realtime/sdp-negotiator.ts`) — pure
  function that parses an SDP offer's `v=`, `o=`, `m=audio` lines and
  produces an answer mirroring the proposed codec. Empty string →
  `Err("empty-sdp")`. Missing `v=0` line → `Err("invalid-sdp")`. PCM/Opus
  codec marker is preserved in the answer (HELL-RT-17).

- **`AudioCodec`** (`src/realtime/audio-codec.ts`) — `"pcm" | "opus"` enum
  + `negotiateCodec(offered, supported)` pure function. **Marker only.**
  Actual encode/decode is deferred to a follow-up slice.

All methods return `Result<…>` (the shared `@/shared` discriminant). No
thrown errors on operational failure. Programmer-bug input (empty SDP, send
before connect) is encoded as a typed `Err` variant.

### Architectural invariants (HARD)

- `exactOptionalPropertyTypes: true` (tsconfig) — every optional field uses
  the `?` shape; spread-only-when-defined helper or `omitUndef` pattern
  applies.
- Closed-port: `RealtimePort` is the single surface; adapters are private
  to the slice and exposed only via factory functions.
- AbortSignal correctness: `connect({signal})` aborted mid-connect closes
  the in-flight WS and transitions to `closed` (HELL-RT-10). No zombie WS.
- Default-OFF: nothing in the existing tree imports `@/realtime`. The
  barrel exports the port + adapters + stubs; surfaces opt in by
  constructing one of the adapters and threading the port into their own
  wire. Existing CLI / agent / runner / tool paths are byte-identical.
- Plane-clean leaf: `src/realtime/**` imports only `@/shared`. Zero
  `@/agent` / `@/tool` / `@/llm` / `@/permission` / `@/mcp` / `@/media` /
  `@/voice` / `@/scheduler` / `@/runtime` / `@/observability`.

## Hellgate (18 cases — `tests/unit/realtime/realtime-hellgate.test.ts`)

| Case | Pin |
|---|---|
| HELL-RT-01 | `connect` (mock WS) → `status()=open` |
| HELL-RT-02 | `connect` fail (auth invalid) → `Err({kind:"auth-failed"})` |
| HELL-RT-03 | `send` before `connect` → `Err({kind:"not-connected"})` |
| HELL-RT-04 | `onMessage` handler fires on inbound (mock) |
| HELL-RT-05 | `negotiate(offer)` → `sdpAnswer` (mock) |
| HELL-RT-06 | `negotiate` broken SDP → `Err({kind:"invalid-sdp"})` |
| HELL-RT-07 | `audioStart(format)` → outbound `{type:"audio.start",...}` |
| HELL-RT-08 | `audioStop()` → outbound `{type:"audio.stop"}` |
| HELL-RT-09 | `close` graceful → `status()=closed`, no message after |
| HELL-RT-10 | `AbortSignal` aborted mid-connect → cleanup + `closed` |
| HELL-RT-11 | WS closed → `send` → `Err({kind:"not-connected"})` |
| HELL-RT-12 | 4-state round-trip (`connecting → open → closing → closed`) |
| HELL-RT-13 | headless-stub determinism (same input → same outbound) |
| HELL-RT-14 | 1000 message FIFO order |
| HELL-RT-15 | binary frame (audio chunk) round-trip unchanged |
| HELL-RT-16 | concurrent `connect` → second `Err({kind:"already-connected"})` |
| HELL-RT-17 | `negotiateSdp` preserves PCM codec marker |
| HELL-RT-18 | `negotiateSdp("")` → `Err({kind:"empty-sdp"})` |

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Install `ws` npm package** | install BLOCKED in this environment. Bun ships native WebSocket on `globalThis` (web-standard). Adapter swap is a one-line factory if `ws` is ever needed for Node-only contexts. |
| **Reuse `@/stream` slice** | `@/stream` is HTTP/SSE streaming for LLM responses. WebSocket has a 4-state lifecycle and bidirectional semantics that don't fit the stream-is-async-iterable shape. Different primitive. |
| **Implement WebRTC media handoff in this slice** | WebRTC `RTCPeerConnection` is a 1000+ LOC subsurface with codec negotiation, jitter buffers, NAT traversal. Out-of-scope for an absorb-the-surface MVP. The SDP exchange is text-level so the surface can drive its own peer connection. |
| **Implement Opus encode/decode** | requires `libopus` native binding. Marker-only is sufficient for the negotiate handshake; actual codec is a follow-up. |
| **Throw on `send` pre-connect** | every other quanta port returns `Result`; throwing would force surfaces to wrap in try/catch and risk swallow-and-paint mismatches. Hellgate pins the `Err` shape. |
| **Single-handler `onMessage` (overwrite)** | multiple consumers (UI render + transcript log + metric tap) is a real pattern — return unsubscribe instead. |

## Consequences

- **Default-OFF byte-identical**: existing tree is unaffected; nothing
  imports `@/realtime`. Surfaces opt in by constructing an adapter +
  threading the port.
- **Plane-clean leaf**: `src/realtime/**` imports only `@/shared`. Slice
  isolation is preserved.
- **Bun-native WebSocket**: zero new npm dependency. The adapter is a
  ~80-line wrapper. `ws` swap is one-line if Node-only support is ever
  needed.
- **SDP text-level only**: this slice does NOT own media. The surface that
  wants actual audio handoff builds its own `RTCPeerConnection` from the
  negotiated answer. This is the deliberate MVP boundary.
- **Follow-ups** (not in this slice):
  - Actual WebRTC media handoff (`RTCPeerConnection` wrap behind a sibling
    port — voice channel).
  - Opus / PCM real encode/decode (native bindings or wasm).
  - Streaming STT integration (Deepgram WS adapter — currently REST one-shot).
  - Backpressure-aware send queue (single in-flight + queued; today's
    implementation lets the underlying WS buffer manage it).
  - Reconnection / retry-on-disconnect policy.
