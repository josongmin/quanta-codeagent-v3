# RFC-03 — Bidirectional Realtime Voice (live spoken dialog)

> SOTA++ implementation RFC. Wire quanta's existing realtime WebSocket/SDP transport
> foundation into a *live* voice conversation: audio in (mic → up) + transcript/audio
> out (down → render/play). Absorbs Codex `ThreadRealtime*` model. Mirrors the OpenAI
> Realtime API server-VAD shape.
>
> Status: PROPOSED · Default-OFF · Closed-port / DI · Slice-fenced
> ADR suggestion: **ADR-0435** (latest landed = 0434; 0435 is free as of 2026-06-02)
> Author lens: expert architect, read-only research → implementation-ready

---

## 0. TL;DR

quanta already ships the *entire transport half* of realtime voice — an 8-method
`RealtimePort` over a Bun WebSocket adapter, an SDP negotiator, a deterministic
headless stub, and a codec-marker handshake (`src/realtime/`, ADR-0230). It is
**default-OFF dead scaffolding**: *nothing in the tree imports `@/realtime`*
(`src/realtime/index.ts:11-15`). Separately, `src/voice/` ships a mic recorder
(`AudioRecorderPort`, ADR-0208) and a one-shot STT pipeline (`TranscriberPort`).

The gap: voice is **one-shot push-to-talk STT** today — record → stop → POST to
Whisper → enqueue transcript (`src/apps/cli/voice-cmd.ts:315-340`). There is **no
live spoken dialog**: no streaming mic-up, no streaming transcript/audio-down, no
turn detection, no barge-in.

This RFC defines a new closed-port `RealtimeVoiceSession` that *composes the two
existing slices* (transport + recorder) into a live session driven by the **OpenAI
Realtime API** (`wss://api.openai.com/v1/realtime`), which handles VAD + codec +
TTS server-side. We do **not** build a custom audio codec/DSP — quanta's
`audio-codec.ts` is honestly a marker (no real opus encode/decode), and the
Realtime API removes the need for one (it accepts base64 PCM16 frames and emits
base64 PCM16/transcript deltas over the same WS).

---

## 1. Problem

### 1.1 Voice is one-shot only

`src/apps/cli/voice-cmd.ts` is the only voice surface:

- `runRecord` (`voice-cmd.ts:145-187`): `recorder.start({format:"wav",rate:16000,channels:1})`
  → wait for Enter/Esc or a fixed duration → `recorder.stop(handle)` → wav `Buffer`.
- `runTranscribe` (`voice-cmd.ts:196-243`): one `POST /v1/audio/transcriptions` round-trip
  (`createOpenAIWhisperTranscriber`, `src/voice/transcriber/openai-whisper-transcriber.ts:215-247`).
- `emitTranscript` (`voice-cmd.ts:248-273`): enqueue as a `voice_transcript` plan-queue
  follow-up — **never auto-submitted** (confirm-always, `voice-cmd.ts:31-34`).

There is no streaming, no model *speaking back*, no interrupt. It is dictation, not
conversation.

### 1.2 The transport already exists — and is unused

`src/realtime/` is a complete bidirectional WS surface:

- `RealtimePort` 8-method contract (`src/realtime/port.ts:57-93`):
  `connect / send / onMessage / negotiate / audioStart / audioStop / close / status`.
- Bun-native adapter (`src/realtime/default-adapter.ts:91-337`) with a 4-state
  lifecycle (`connecting → open → closing → closed`), `WebSocketCtor` injection seam
  for tests (`default-adapter.ts:55-63`), AbortSignal cleanup (`:188-199`), idempotent
  close (`:291-331`), FIFO send + subscriber fan-out isolation (`:268-277`).
- SDP negotiator (`src/realtime/sdp-negotiator.ts:61-96`) — text-level offer/answer.
- Headless stub (`src/realtime/headless-stub.ts:74-198`) — fully deterministic;
  `inject()` pushes inbound frames, `outbound()` records what was sent, `forceClose()`
  simulates a remote disconnect. **This is the test substrate for this RFC.**

But (`src/realtime/index.ts:11-15`):

> *Default-OFF: nothing in the existing tree imports `@/realtime`.*

So the load-bearing transport is shipped, hardened by a HELL-RT-* battery, and
**wired to nothing**. This RFC is the wiring.

### 1.3 Honest boundary: codec is a marker, not a transcoder

`src/realtime/audio-codec.ts:1-19` is explicit:

> *MARKER ONLY — this slice does NOT encode or decode audio … Real opus/pcm
> encode/decode needs native bindings (`libopus`/`node-opus`) which the install gate
> blocks.*

`port.ts:78-81` repeats it for `audioStart`: *"Codec marker only; actual audio
encode/decode is OUT-OF-SCOPE for this MVP."* This RFC **respects that boundary** —
see §3.4 and the non-goals.

---

## 2. Competitor reference — Codex `ThreadRealtime*` (codex-rs 0.135)

Source: `.extracted_source/codex/_codex-rs-0.135-symbols.txt`.

### 2.1 Method set (request/response pairs)

Codex exposes the realtime conversation as a JSON-RPC method family on its
app-server (`realtime.rs`, `realtime_websocket/protocol_v1.rs` + `protocol_v2.rs`):

| Method (params → response)         | Purpose                                       | symbols.txt line |
|------------------------------------|-----------------------------------------------|------------------|
| `ThreadRealtimeStart`              | open a realtime session over the thread       | 4105/4109, 4172/4173 |
| `ThreadRealtimeStop`               | close the session                             | 4059/4060, 4133/4134 |
| `ThreadRealtimeAppendAudio`        | push a mic audio chunk up                     | 4303/4304, 4353/4354 |
| `ThreadRealtimeAppendText`         | push typed text up (mixed-modality)           | 4262/4263, 4326/4327 |
| `ThreadRealtimeListVoices`         | enumerate available output voices             | 4264/4265, 4330/4331 |
| `ThreadRealtimeStartTransport`     | `auto` transport selector (webrtc/ws)         | 4204/4205 |

`ThreadRealtimeAudioChunk` (4054/4058) is the up-frame envelope.

### 2.2 Notifications (server → client, the event stream)

| Notification                              | Meaning                                  | line     |
|-------------------------------------------|------------------------------------------|----------|
| `ThreadRealtimeStarted`                   | session live, ack of Start               | 4355/4356 |
| `ThreadRealtimeItemAdded`                 | a new conversation item materialized     | 4389/4390 |
| `ThreadRealtimeTranscriptDelta`           | incremental transcript text (down)       | 4440/4441 |
| `ThreadRealtimeTranscriptDone`            | transcript final for an item             | 4432/4433 |
| `ThreadRealtimeOutputAudioDelta`          | incremental output audio (TTS, down)     | 4442/4443 |
| `ThreadRealtimeSdp`                       | SDP exchange for the WebRTC transport    | 4235/4236 |
| `ThreadRealtimeError`                     | typed error                              | 4305/4306 |
| `ThreadRealtimeClosed`                    | session closed (remote or local)         | 4328/4329 |

This is a near-1:1 mirror of the **OpenAI Realtime API** event vocabulary
(`input_audio_buffer.append`, `response.audio_transcript.delta`,
`response.audio.delta`, `response.done`, `error`, `session.updated`).

### 2.3 Session config — the `session.update` shape

The `SessionUpdate`/`Session` config (inline in the symbols blob around the
`SessionAudioInput` region) is verbatim the OpenAI Realtime `session` object:

```
Session {
  output_modalities: ["audio", "text"]          // both → speak + show transcript
  audio: {
    input:  SessionAudioInput {
      format: SessionAudioFormat,                // pcm16 (NearField default)
      noise_reduction: SessionNoiseReduction { type: NearField },
      transcription: SessionInputAudioTranscription,   // input STT (whisper/gpt-4o-transcribe)
      turn_detection: ServerVad {
        threshold,
        prefix_padding (prefix_padding_ms),
        silence_duration_ms,                     // how long silence = end-of-turn
        interrupt_response,                      // barge-in: user speech kills active response
        create_response,                         // auto-create a response on turn end
      }
    },
    output: SessionAudioOutput {
      format: SessionAudioOutputFormat,          // pcm16
      voice,                                     // selected output voice (ListVoices)
    }
  }
  instructions, tools, tool_choice, model, model_provider, service_tier
}
```

Key extracted tokens (verbatim, from the minified blob):
`SessionAudioInput format noise_reduction transcription turn_detection ServerVad`,
`interrupt_response create_response silence_duration_ms output_modalities audio tools tool_choice`,
`SessionNoiseReduction SessionAudioOutputFormat SessionInputAudioTranscription`,
`SessionAudioOutput voice`, `NearField SessionAudioFormat`.

`UnsandboxedTurn`/`DefaultPermissions` appear adjacent — Codex gates realtime turns
through its permission engine; quanta's equivalent is §3.6 (realtime is an I/O
primitive, not a tool — no permission plane crossing in the MVP).

### 2.4 Webview composer labels (the UX surface to mirror)

From the same dump (`composer.realtime.*`):

```
composer.realtime.start.{aria,tooltip}      composer.realtime.startError
composer.realtime.end.{aria,label,tooltip}  composer.realtime.ending.{aria,label,tooltip}
composer.realtime.cancel.{aria,label,tooltip}
composer.realtime.mute.{aria,tooltip}       composer.realtime.unmute.{aria,tooltip}
composer.realtime.muteMicrophone.{aria,tooltip}  composer.realtime.unmuteMicrophone.{aria,tooltip}
composer.realtime.muteToggleError
composer.realtime.connectionError           composer.realtime.microphonePermissionError
composer.realtime.createThreadError         composer.realtime.{error,closed}
composer.realtime.{startError,stopError}
```

This gives us the canonical UX states to surface: **start / listening / responding /
ending / closed / muted / cancel(interrupt) / errors (connection, mic-permission)**.
The CLI mirrors these as REPL strings (§5).

---

## 3. Design

### 3.1 The new port: `RealtimeVoiceSession`

A single closed-port that *composes* the two existing slices. It owns the session
state machine; it does **not** re-implement transport (delegates to `RealtimePort`)
or mic capture (delegates to `AudioRecorderPort`).

Location decision: **`src/realtime/voice-session/`** (new sub-slice under realtime).
Rationale: this slice's reason-to-exist is *driving the realtime transport*; it
imports `@/realtime` (transport) + `@/voice` (recorder) + `@/shared`. Putting it
under `src/realtime` keeps the realtime plane self-contained; putting it under
`src/voice` would invert the dependency (voice → realtime) which is the heavier
direction. (Either is defensible; the slice-fence rule below is what matters.)

```ts
// src/realtime/voice-session/port.ts
export type VoiceSessionState =
  | "idle" | "connecting" | "listening" | "responding" | "closed"

export interface RealtimeVoiceSessionPort {
  /** idle → connecting → listening. Opens transport, sends session.update,
   *  starts mic capture. Returns Err on auth/connect/mic-permission failure. */
  start(opts: VoiceSessionStartOpts): Promise<Result<void, VoiceSessionError>>

  /** Push-to-talk fallback only: when turn_detection=disabled, the surface
   *  calls this to mark end-of-utterance (commit input buffer + create response).
   *  No-op under server-VAD (server detects turn end). */
  commitTurn(): Result<void, VoiceSessionError>

  /** Append typed text mid-session (mixed modality; mirrors AppendText). */
  sendText(text: string): Result<void, VoiceSessionError>

  /** Mute/unmute the mic without tearing down the session. Muted ⇒ mic chunks
   *  are dropped before AppendAudio (mirrors composer.realtime.mute). */
  setMuted(muted: boolean): Result<void, VoiceSessionError>

  /** Barge-in / cancel the active response (mirrors composer.realtime.cancel).
   *  Sends response.cancel; transitions responding → listening. */
  interrupt(): Result<void, VoiceSessionError>

  /** Subscribe to session events (transcript/audio deltas, state changes). */
  onEvent(handler: (e: VoiceSessionEvent) => void): () => void

  /** Current state. Pure. */
  state(): VoiceSessionState

  /** Graceful close. listening|responding → closed. Idempotent. */
  close(): Promise<Result<void, VoiceSessionError>>
}
```

### 3.2 State machine

```
                start() ok
   idle ───────────────────────► connecting
    ▲                                 │ transport open + session.update acked
    │ close()                         ▼
    │                            listening ◄──────────────┐
    │                                 │                    │ interrupt() / response done
    │                  server-VAD     │ user speech ends   │
    │                  end-of-turn    ▼                    │
    │                            responding ───────────────┘
    │                                 │
    └───────────────── close() ───────┴──► closed
```

- `idle → connecting`: `transport.connect()` (`port.ts:62`) with the Realtime
  endpoint + bearer. On fail (`auth-failed`/`connect-failed`) → stays `idle`, returns Err.
- `connecting → listening`: on transport `open`, send `session.update` (the §2.3
  config) via `transport.send(JSON.stringify(...))`, `transport.audioStart("pcm")`
  (`port.ts:81`), start mic capture (`recorder.start`). The `ThreadRealtimeStarted` /
  `session.updated` inbound confirms the transition.
- `listening → responding`: inbound `response.created` / first
  `OutputAudioDelta|TranscriptDelta`.
- `responding → listening`: inbound `response.done`, or local `interrupt()`.
- `* → closed`: `close()`, transport `Closed` notification, or unrecoverable error.

The machine is a pure reducer `(state, event) → state` (injectable, unit-testable in
isolation) so the hellgate can drive it without any I/O (§7).

### 3.3 Turn detection — server-VAD primary, push-to-talk fallback

Two modes, selected at `start()`:

1. **`server_vad` (default).** Send `turn_detection: { type: "server_vad",
   threshold, prefix_padding_ms, silence_duration_ms, interrupt_response: true,
   create_response: true }` in `session.update`. The server detects end-of-turn from
   silence and auto-creates a response. `commitTurn()` is a no-op. This is the
   conversational default and matches Codex's `ServerVad`.
2. **`push_to_talk` (fallback).** Send `turn_detection: null`. The mic streams only
   while a key is held; on release the surface calls `commitTurn()` →
   `input_audio_buffer.commit` + `response.create`. Used in noisy environments or when
   the surface wants explicit control. Reuses the existing `VoiceKeyReader` ergonomics
   (`voice-cmd.ts:61-63`).

No magic thresholds invented by us — the VAD knobs are passed through from config
with the OpenAI Realtime API documented defaults (do not hardcode tuned numbers;
expose them, default to the API defaults). (Per `no-heuristics-only-validated`.)

### 3.4 Event flow — mapping to the existing `RealtimePort`

**Up (mic → server):**
```
recorder.start() → audio chunks
   → [if muted: drop]
   → base64(PCM16 chunk)
   → transport.send(JSON.stringify({ type:"input_audio_buffer.append", audio }))
```
We send JSON text frames over the existing `transport.send` (`port.ts:66`) — the
Realtime API is a *text-WS-of-base64*, NOT a binary media WS, so **no opus/PCM
transcoding is needed on our side** (the install-gated `libopus` problem disappears).
`audioStart`/`audioStop` (`port.ts:81-85`) emit our lifecycle markers; the actual
audio rides as base64 in `send`.

> ⚠️ Capture-format note: the mic recorder produces **wav** (`voice-cmd.ts:146`,
> backends sox/arecord/parec). The Realtime API wants **raw PCM16 mono @ 24 kHz**.
> Bridging = strip the 44-byte WAV header + resample 16k→24k. Stripping the header is
> trivial+pure; resampling is the one piece of real DSP. **Decision:** for the MVP
> request the recorder at the rate the API accepts and pass `pcm16` frames; if a
> resample is unavoidable, isolate it behind a tiny `PcmBridgePort` (linear
> interpolation, pure, injected) — this is NOT a codec, it is sample-rate
> conversion, and stays a leaf pure function. Document this as the single DSP seam;
> do not build opus.

**Down (server → render/play):**
```
transport.onMessage((m) => {            // m: {kind:"text",data} | {kind:"binary",data}
   parse JSON →
     "response.audio_transcript.delta"  → emit VoiceSessionEvent {kind:"transcript-delta"}  → REPL render
     "response.audio.delta"             → emit {kind:"audio-delta", pcm}                     → AudioPlaybackPort.play
     "response.done"                    → state → listening
     "error"                            → emit {kind:"error"} → degrade per §6
})
```
`onMessage` already isolates throwing subscribers (`default-adapter.ts:117-138`,
`notifyAllNoThrow`), so a render bug can't starve audio playback.

### 3.5 Default-OFF (byte-identical when absent)

- The slice imports nothing on the hot path; **no existing file imports
  `@/realtime/voice-session`**. (Same posture as `@/realtime`'s current
  zero-import state, `index.ts:11-15`.)
- The surface (a new `/voice-live` slash, §5) is registered only when the surface
  *constructs* a `RealtimeVoiceSession` and threads it into ctx — exactly the pattern
  `voice-cmd.ts` already uses (`recorder?`/`transcriber?` optional ctx fields,
  `voice-cmd.ts:65-98`). When the session/recorder/key are not wired, `/voice-live`
  prints "realtime voice not wired" and exits 1.
- ⇒ Feature absent ⇒ existing CLI/agent/runner paths are byte-identical. Pinned by a
  default-OFF hellgate (§7).

### 3.6 Plane discipline (slice-fence)

`src/realtime/voice-session/` imports **only** `@/realtime`, `@/voice`, `@/shared`.
Zero `@/agent` / `@/tool` / `@/llm` (except the *auth value* passed in by the surface,
§4) / `@/permission` / `@/mcp`. Realtime voice is an I/O channel, not a tool, not a
permission, not an LLM call — same fence the two parent slices already declare
(`realtime/port.ts:20-22`, `voice/port.ts:23-25`). The surface (apps/cli) is the only
place that crosses planes (it owns the recorder, the auth resolution, and the
plan-queue).

---

## 4. Provider — OpenAI Realtime API (auth reuse)

Endpoint: `wss://api.openai.com/v1/realtime?model=gpt-realtime` (the GA realtime
model; model id passed via config, not hardcoded).

### 4.1 Auth — reuse the existing LLM seam, do not invent a new one

quanta already resolves the OpenAI bearer in two places the surface can reuse:

1. **BYOK key:** `resolveApiKey` reads `OPENAI_API_KEY`
   (`src/llm/factory.ts:34, 238, 244-248`). The Whisper transcriber already reuses
   this exact key (`openai-whisper-transcriber.ts:5-8, 152-156`).
2. **ChatGPT OAuth bearer:** `src/llm/adapters/chatgpt-oauth.ts:184, 282` already
   attaches `Authorization: Bearer ${token.access_token}` for the responses API.

The session `start()` takes `auth: string` (a resolved bearer) as an injected value —
the slice never reaches into `@/llm` itself (fence §3.6). The surface resolves it via
the existing factory path and passes it down. The transport's `connect({endpoint,
auth})` (`realtime/types.ts:23-34`) already threads a bearer (as a subprotocol prefix
in the Bun adapter, `default-adapter.ts:159-163`; for the Realtime API the surface
uses a Bearer-header-capable adapter variant — one-line ctor swap, `default-adapter.ts:5-7`).

> Header caveat: the Bun WebSocket global can't set arbitrary headers. The Realtime
> API accepts the key via the `OpenAI-Beta: realtime=v1` + `Authorization` headers,
> which on Bun is done by passing them through a `fetch`-upgrade adapter or the
> `headers` option of Bun's `WebSocket`. This is a **transport-adapter concern**, not
> a session concern — the session is adapter-agnostic (it only sees `RealtimePort`).
> Provide a `createOpenAIRealtimeAdapter(opts)` that sets the headers; it satisfies the
> same `RealtimePort` so the headless stub still drives every test.

### 4.2 The `session.update` we send on connect

```jsonc
{
  "type": "session.update",
  "session": {
    "model": "<from config>",
    "output_modalities": ["audio", "text"],
    "instructions": "<system prompt slice, optional>",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "noise_reduction": { "type": "near_field" },
        "transcription": { "model": "gpt-4o-transcribe" },
        "turn_detection": {                       // server_vad mode
          "type": "server_vad",
          "threshold": <config or API default>,
          "prefix_padding_ms": <config or API default>,
          "silence_duration_ms": <config or API default>,
          "interrupt_response": true,
          "create_response": true
        }
      },
      "output": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "voice": "<from ListVoices / config, default 'alloy'>"
      }
    }
  }
}
```

This is a 1:1 of Codex's `Session` (§2.3). Tools/tool_choice are **out of scope for
the MVP** (no tool-calling over realtime yet — see non-goals).

---

## 5. CLI / surface

### 5.1 `/voice-live` slash (new, in `apps/cli`)

A new `src/apps/cli/voice-live-cmd.ts` sibling to `voice-cmd.ts`, same ctx-injection
discipline (out/err/optional ports, `voice-cmd.ts:65-98`):

```ts
export interface VoiceLiveCtx {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
  readonly session?: RealtimeVoiceSessionPort   // undefined ⇒ default-OFF gate
  readonly keys?: VoiceLiveKeyReader            // m=mute, space=push-to-talk, Esc=interrupt, q=end
  readonly mode?: "server_vad" | "push_to_talk"
}
```

Subcommands (mirroring Codex composer labels §2.4):

- `/voice-live` → `start()`. Prints `listening...` (`composer.realtime.start`).
- `/voice-live status` → print state + mute + mode.
- key `m` → `setMuted(toggle)` → `🔇 muted` / `🎙 unmuted` (`mute`/`unmute`).
- key `Esc` → `interrupt()` → `⏹ interrupted` (`composer.realtime.cancel`).
- key `q` / `/voice-live end` → `close()` → `ending...` → `closed`
  (`composer.realtime.end`/`ending`/`closed`).

### 5.2 Transcript + audio rendering

- **Transcript:** `transcript-delta` events stream into the REPL incrementally
  (append to the current line; finalize on `transcript-done`). This is the *always-on*
  channel — it works even when audio playback is unavailable.
- **Audio:** an injected `AudioPlaybackPort` (new, §6.4) receives `audio-delta` PCM
  frames and pipes them to a player (`afplay`/`ffplay`/`paplay` via spawn, mirroring
  the recorder backend cascade in `default-recorder.ts`). When no player is on PATH
  ⇒ **transcript-only fallback** (§6.3) — the session stays fully functional.

### 5.3 Headless surface

In headless mode (no TTY / no key reader / `keys` unwired), `/voice-live` is a
**no-op that exits 0 with a one-line notice** ("realtime voice requires an
interactive terminal"). Same posture as `voice-cmd.ts`'s fixed-duration fallback
branch (`voice-cmd.ts:158-168`) but for live voice we decline rather than auto-run.

---

## 6. Edge cases

| Case | Handling | Reuse |
|------|----------|-------|
| **Mic permission denied** | `recorder.start()` → `Err({kind:"spawn-failed"\|"backend-missing"})` → session stays `idle`, surface prints `microphonePermissionError` | `voice/types.ts:69-75`, `voice-cmd.ts:149-154` |
| **Mid-response interrupt (barge-in)** | server-VAD `interrupt_response:true` auto-cancels on user speech; explicit `interrupt()` sends `response.cancel` → `responding → listening` | §3.3, §3.1 |
| **Connection drop** | transport `Closed` / `onclose` → session → `closed`, emit `{kind:"error",reason:"connection"}` (`connectionError`). Reconnect = **out of MVP scope**; if RFC-01 (reconnect) lands, the session re-runs `start()` behind a backoff. The transport already classifies close codes (auth vs other, `default-adapter.ts:227-244`). | `default-adapter.ts:227-244` |
| **Audio playback unavailable** | `AudioPlaybackPort.availability()===null` ⇒ drop `audio-delta`, keep `transcript-delta` ⇒ **transcript-only** session, no error | §5.2, §6.4 |
| **Headless / no TTY** | `/voice-live` no-ops, exits 0 with notice | §5.3 |
| **Auth failure** | `transport.connect` → `Err({kind:"auth-failed"})` → session `idle`, surface prints `connectionError` | `realtime/types.ts:61`, `default-adapter.ts:234-237` |
| **Oversize / runaway capture** | recorder `maxBytes` cap (`voice/types.ts:31-34`) — but for live streaming we drain+forward continuously, so the cap is per-chunk, not cumulative; document that the session has no implicit time cap (surface adds one if desired) | `voice/types.ts:31-34` |
| **Throwing event handler** | isolated by `notifyAllNoThrow` in the transport fan-out | `default-adapter.ts:117-138` |

### 6.4 New `AudioPlaybackPort` (down-channel sink)

```ts
// src/realtime/voice-session/playback-port.ts
export interface AudioPlaybackPort {
  availability(): string | null   // "afplay"/"ffplay"/"paplay" or null
  play(pcm: Uint8Array): Result<void, PlaybackError>   // append to the player stream
  flush(): Promise<void>          // on response.done
  stop(): void                    // on interrupt / close
}
```
Default adapter spawns a platform player (cascade like `default-recorder.ts`); a
headless/no-player environment returns `null` from `availability()` ⇒ transcript-only.
This is a **new sibling port**, injected — no globals, no DSP (it just pipes bytes the
server already encoded).

---

## 7. Test plan (hellgate, mocked WS + injected recorder)

Battery prefix `HELL-RTV-*`. All deterministic — `createHeadlessStub()`
(`headless-stub.ts:74`) drives the transport, a fake recorder + fake playback are
injected, clock is injected. No real sockets, no real audio.

1. **HELL-RTV-01 transport wired to recorder.** `start()` → assert stub `outbound()`
   contains a `session.update` text frame, an `audio-start` signal, then ≥1
   `input_audio_buffer.append` frame after the fake recorder emits a chunk.
2. **HELL-RTV-02 state machine.** Drive the pure reducer through
   `idle→connecting→listening→responding→listening→closed`; assert illegal transitions
   are rejected (e.g. `interrupt()` while `idle` → Err).
3. **HELL-RTV-03 server-VAD turn end.** `inject()` a `response.done` → assert
   `responding → listening`; `commitTurn()` is a no-op under server_vad.
4. **HELL-RTV-04 push-to-talk.** mode=`push_to_talk` ⇒ `session.update` has
   `turn_detection:null`; `commitTurn()` emits `input_audio_buffer.commit` +
   `response.create` in order.
5. **HELL-RTV-05 interrupt / barge-in.** `responding` + `interrupt()` → outbound
   `response.cancel`, state → `listening`.
6. **HELL-RTV-06 mute.** `setMuted(true)` ⇒ subsequent fake mic chunks produce **no**
   `append` frames; `setMuted(false)` resumes. Assert frame count.
7. **HELL-RTV-07 connection drop.** `stub.forceClose()`
   (`headless-stub.ts:193-196`) mid-`responding` → state → `closed`, one `error`
   event with reason `connection`, no zombie subscribers.
8. **HELL-RTV-08 transcript-only fallback.** Playback `availability()===null` ⇒
   `audio-delta` injects are dropped, `transcript-delta` injects still render; session
   stays `listening`/`responding` (no error).
9. **HELL-RTV-09 mic permission denied.** Fake recorder `start()` → `Err` ⇒ session
   stays `idle`, `start()` returns Err, no transport frames sent.
10. **HELL-RTV-10 auth failure.** Stub `forceConnectError:{kind:"auth-failed"}`
    (`headless-stub.ts:43-44`) ⇒ session `idle`, Err surfaced.
11. **HELL-RTV-11 default-OFF byte-identical.** Importing the agent/runner/cli barrels
    does NOT pull `@/realtime/voice-session`; `/voice-live` with `session` unwired
    prints the gate message + exits 1; the existing `/voice` path is untouched.
12. **HELL-RTV-12 close idempotency.** Double `close()` → both `ok`, single teardown
    (mirrors transport's HELL-RT close invariant, `default-adapter.ts:291-300`).
13. **HELL-RTV-13 throwing event handler isolation.** One `onEvent` handler throws ⇒
    sibling handlers + playback still fire.

Plus a `voice-live-cmd` slash test mirroring the `voice-cmd` test style (injected
out/err, asserts exact REPL strings for start/mute/interrupt/end/error).

---

## 8. File-by-file change list

**New slice — `src/realtime/voice-session/`:**

| File | Contents |
|------|----------|
| `port.ts` | `RealtimeVoiceSessionPort` + `VoiceSessionState` + `VoiceSessionEvent` + `VoiceSessionError` + `VoiceSessionStartOpts` (closed-union, no-throw) |
| `state-machine.ts` | pure `(state,event)→state` reducer + legal-transition guard |
| `default-session.ts` | composes `RealtimePort` + `AudioRecorderPort` + `AudioPlaybackPort` + injected clock; owns up-stream pump, down-stream parse/dispatch, mute, interrupt |
| `session-config.ts` | pure builder for the `session.update` payload (server_vad vs push_to_talk); VAD knobs passed-through (no hardcoded tuning) |
| `pcm-bridge.ts` | pure WAV-header strip + (optional) linear resample — the single isolated DSP seam (§3.4); NOT a codec |
| `playback-port.ts` | `AudioPlaybackPort` interface |
| `default-playback.ts` | platform-player spawn adapter (afplay/ffplay/paplay cascade) + null-availability fallback |
| `openai-realtime-adapter.ts` | `RealtimePort` variant that sets `Authorization` + `OpenAI-Beta` headers (1-line ctor swap from `default-adapter`); satisfies the same port so tests use the stub |
| `index.ts` | barrel; documents default-OFF (nothing imports it) |
| `__tests__/*.hellgate.test.ts` | HELL-RTV-01..13 |

**New surface — `src/apps/cli/`:**

| File | Contents |
|------|----------|
| `voice-live-cmd.ts` | `/voice-live` slash, `VoiceLiveCtx` injection, mirrors composer labels |
| `__tests__/voice-live-cmd.test.ts` | slash REPL-string assertions |

**Docs:**

| File | Contents |
|------|----------|
| `docs/decisions/0435-realtime-voice-session.md` | this RFC's ADR (check 0435 still free at impl time) |
| feature-catalog row | new `realtime-voice-session` entry |

**Touched (additive, default-OFF):** the apps/cli composition root *optionally*
constructs the session + registers `/voice-live` — guarded so absence is
byte-identical (§3.5). No existing file's behavior changes.

---

## 9. SOTA++ checklist

- **Reuse, don't rebuild:** transport (`@/realtime`), mic (`@/voice` recorder), auth
  (`@/llm` factory/oauth, passed as a value). The new code is a *composition*, not a
  re-implementation.
- **Closed-port / DI:** every dependency (transport, recorder, playback, clock, auth)
  is an injected port; tests run on the headless stub + fakes. No globals.
- **No-throw / closed-union errors:** mirrors the two parent slices' contracts.
- **Slice-fenced:** `voice-session` imports only `@/realtime`+`@/voice`+`@/shared`;
  plane crossing confined to apps/cli.
- **Default-OFF / byte-identical:** zero imports on the hot path; HELL-RTV-11 pins it.
- **Honest about DSP:** we do **not** build opus (`audio-codec.ts:1-19` boundary
  respected). The Realtime API does VAD+codec+TTS server-side; the only local DSP is
  an isolated, pure, optional sample-rate bridge (`pcm-bridge.ts`).
- **No invented heuristics:** VAD thresholds are config pass-throughs defaulting to
  the API defaults (`no-heuristics-only-validated`).

### Non-goals (explicit)

- ❌ Custom audio codec / opus encode-decode (server-side; install-gate blocked anyway).
- ❌ Tool-calling over realtime (MVP is conversation only; tools = follow-up).
- ❌ WebRTC peer-connection media path (Codex's `ThreadRealtimeSdp` transport) — we use
  the **WS+base64** transport, which is simpler and needs no `libwebrtc`. The SDP
  negotiator stays available for a future WebRTC adapter but is unused by the MVP.
- ❌ Reconnect/backoff (defer to RFC-01 if/when it lands; transport already classifies
  close codes).
- ❌ Multi-party / multi-voice mixing.

---

## 10. Effort

| Slice | Est. |
|-------|------|
| `voice-session` port + state-machine + reducer + config builder | M (1 day) |
| `default-session` (up-pump + down-dispatch + mute + interrupt) | M–L (1–1.5 days) |
| `pcm-bridge` + playback port + default-playback | S–M (0.5–1 day) |
| `openai-realtime-adapter` (header-capable WS) | S (0.5 day) |
| `/voice-live` slash + REPL rendering | S–M (0.5–1 day) |
| HELL-RTV-01..13 + slash test | M (1 day) |
| ADR + catalog | S |

**Total ≈ 4–5 engineer-days.** ROI: highest single UX differentiator in the backlog,
and ~50% of the work (transport) is already shipped, hardened, and tested
(`src/realtime/`). The remaining work is composition + one provider adapter + one
playback adapter + the state machine.

---

## Appendix A — cited sources

- quanta transport: `src/realtime/port.ts:57-93`, `types.ts:13-68`,
  `default-adapter.ts:55-63,91-337`, `sdp-negotiator.ts:61-96`,
  `headless-stub.ts:34-198`, `audio-codec.ts:1-51`, `index.ts:11-15`.
- quanta voice: `src/voice/port.ts:51-66`, `types.ts:24-75`,
  `transcriber/port.ts:31-72`, `transcriber/openai-whisper-transcriber.ts:5-8,152-156,215-247`,
  `mac-mic-recorder.ts:23-29`, `src/apps/cli/voice-cmd.ts:31-34,65-98,145-340`.
- quanta auth: `src/llm/factory.ts:34,238,244-248`,
  `src/llm/adapters/chatgpt-oauth.ts:184,282`.
- Codex: `.extracted_source/codex/_codex-rs-0.135-symbols.txt` lines
  4054-4443 (ThreadRealtime* method/notification family), inline `Session*` config
  blob (SessionAudioInput/ServerVad/SessionAudioOutput/output_modalities), and
  `composer.realtime.*` label set.
