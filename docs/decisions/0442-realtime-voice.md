# ADR-0442 — Realtime bidirectional voice session (`RealtimeVoiceSession`)

- Status: Accepted
- Date: 2026-06-02
- RFC: `docs/plans/jun-2-misc/03-realtime-voice.md`
- Slice: `src/realtime/voice-session/` (new sub-slice — port, state-machine,
  default-session, session-config, pcm-bridge, playback-port, default-playback,
  openai-realtime-adapter, index), `src/apps/cli/voice-live-cmd.ts` (`/voice-live`
  slash surface)
- Absorbs: Codex `ThreadRealtime*` method/notification family + `Session*` config
  (`SessionAudioInput`/`ServerVad`/`SessionAudioOutput`/`output_modalities`) +
  `composer.realtime.*` UX labels (`.extracted_source/codex/_codex-rs-0.135-symbols.txt`),
  mirrored 1:1 onto the OpenAI Realtime API event vocabulary.

## Context

quanta already shipped the entire **transport half** of realtime voice: the
8-method `RealtimePort` over a Bun WebSocket adapter, an SDP negotiator, a
deterministic headless stub, and a codec marker (`src/realtime/`, ADR-0230). It
was default-OFF dead scaffolding — *nothing in the tree imported `@/realtime`*.
Separately, `src/voice/` shipped a handle-based mic recorder (`AudioRecorderPort`,
ADR-0208) and a one-shot Whisper STT pipeline.

The gap: voice was **one-shot push-to-talk dictation** (record → stop → POST →
enqueue transcript). There was no *live spoken dialog*: no streaming mic-up, no
streaming transcript/audio-down, no turn detection, no barge-in, no model
speaking back.

## Decision

Add a new closed-port `RealtimeVoiceSessionPort` that **composes the two
existing slices** (transport + recorder) plus a new sibling `AudioPlaybackPort`
into a live session driven by the **OpenAI Realtime API**
(`wss://api.openai.com/v1/realtime`), which handles VAD + codec + TTS
server-side.

- **`port.ts`** — `RealtimeVoiceSessionPort` (start / commitTurn / sendText /
  setMuted / interrupt / onEvent / state / muted / close), a closed-union
  `VoiceSessionError`, `VoiceSessionEvent`, `VoiceSessionStartOpts`. No-throw.
- **`state-machine.ts`** — pure `(state, action) → ReduceResult` reducer over the
  5 states `idle → connecting → listening → responding → closed`. Illegal
  actions return `ok:false` (state unchanged). No I/O, no time.
- **`default-session.ts`** — composes `RealtimePort` + `AudioRecorderPort` +
  `AudioPlaybackPort` + an injected `MicPump` + an injected clock (`now`). Owns
  the up-stream pump (mic chunk → pcm-bridge → base64 →
  `input_audio_buffer.append`), the down-stream parser/router
  (`response.audio.delta` → playback; `response.audio_transcript.delta` →
  transcript event; `response.done` → turn-done), mute (drop before append),
  interrupt (`response.cancel`), and connection-drop detection.
- **`session-config.ts`** — pure `buildSessionUpdate` mirroring Codex's `Session`
  1:1. Server-VAD vs push-to-talk diverges only on `turn_detection`. **VAD knobs
  are passed THROUGH from config; omitted knobs are NOT emitted** so the API's
  documented default applies (no invented thresholds).
- **`pcm-bridge.ts`** — the SINGLE isolated DSP seam: pure WAV-header-strip +
  linear-interp resample. NOT a codec.
- **`playback-port.ts` / `default-playback.ts`** — `AudioPlaybackPort` + a
  spawn-cascade adapter (ffplay → paplay) with `availability()===null` ⇒
  transcript-only fallback. Injected spawner (zero real I/O in tests).
- **`openai-realtime-adapter.ts`** — a header-capable `RealtimePort` variant
  (sets `Authorization: Bearer` + `OpenAI-Beta`) — a 1-line ctor swap from the
  default adapter. Satisfies the SAME port, so every test still drives the stub.
- **`/voice-live` slash** (`src/apps/cli/voice-live-cmd.ts`) — REPL surface
  mirroring `composer.realtime.*` labels (listening / responding / muted /
  interrupted / ending / closed / connectionError / microphonePermissionError).
  Default-OFF gate when the session is unwired; headless decline when no key
  reader is present.
- **`/voice-live` composition wire** (`src/apps/cli/repl/voice-live-wire.ts`,
  follow-up) — the dep-assembly that makes typing `/voice-live` actually
  CONSTRUCT a live session at the REPL composition root: transport = OpenAI
  Realtime adapter, recorder = platform mic cascade, playback = ffplay/paplay
  cascade, plus a streaming `MicPump` over the recorder stdout, an injected
  clock, and a raw-mode keypress reader (TTY only). The OpenAI bearer is
  resolved HERE (composition root) — `OPENAI_API_KEY` first, then the
  ChatGPT-OAuth access token — and threaded into the session as a value. The
  slash is registered in the surface registry (`registry-surface.ts`) and the
  builder is wired in `surface-compose.ts` behind the `QUANTA_VOICE_LIVE`
  opt-in gate.

## Honest codec boundary

We do **not** build an opus DSP. `src/realtime/audio-codec.ts:1-19` documents
that real opus encode/decode needs install-gate-blocked native bindings. The
OpenAI Realtime API removes the need: it is a **text-WS-of-base64** — it accepts
base64 PCM16 frames and emits base64 PCM16/transcript deltas over the same WS.
So our up/down audio rides as base64 in the existing `transport.send` /
`onMessage` — **no transcoding on our side**. The only local processing is
`pcm-bridge.ts` (WAV-strip + linear resample), which is sample-rate conversion,
not a codec, isolated behind a pure leaf function.

## Auth reuse

`start()` takes `auth: string` — a RESOLVED bearer — as an injected value. The
slice never reaches into `@/llm` (fence). The surface resolves it via the
existing factory (`OPENAI_API_KEY`) or ChatGPT-OAuth path and passes it down.

## No-heuristics

Server-VAD `threshold` / `prefix_padding_ms` / `silence_duration_ms` are config
pass-throughs; when omitted they are not emitted and the API applies its own
default. `interrupt_response` / `create_response` are boolean behavior switches
the RFC pins (barge-in + auto-response), not tuned numbers.
(`no-heuristics-only-validated`.)

## Default-OFF / byte-identical

The `@/realtime/voice-session` slice is imported ONLY by the opt-in `/voice-live`
surface (the slash handler `voice-live-cmd.ts` + its composition-root wire
`repl/voice-live-wire.ts`). NO agent / loop / tool / runner path imports it —
that boundary is the invariant HELL-RTV-11 anchors (now an allow-list of exactly
those two surface files instead of "zero importers").

The `/voice-live` slash IS registered in the REPL surface registry, but the
session it drives is built only when `QUANTA_VOICE_LIVE` is set AND stdin is a
TTY: `buildVoiceLiveSlot` returns `undefined` when the knob is unset, so the
`voiceLive` ctx slot is omitted and the slash prints "not wired" / declines
(exit 0). Feature off ⇒ no transport / recorder / WS is ever constructed and the
REPL is byte-identical. Pinned by HELL-RTV-11 + the new
`tests/unit/cli/voice-live-wire-hellgate.test.ts` battery (11 cases).

### Known-limitation closure (follow-up)

The original ADR shipped the slice + slash as default-OFF with NO importer ("the
`/voice-live` slash is not registered in any dispatcher"). This follow-up CLOSES
that limitation: `/voice-live` is now registered + the live session deps are
assembled at the composition root, so typing `/voice-live` (with the opt-in knob,
in a terminal) constructs a real `RealtimeVoiceSessionPort`. The network launch
itself is exercised against a mocked WS in CI — no live API call in tests.

## Plane discipline

`src/realtime/voice-session/` imports only `@/realtime` + `@/voice` + `@/shared`.
Zero `@/agent` / `@/tool` / `@/llm` / `@/permission` / `@/mcp` / `@/media`
(verified by a hellgate that scans the slice source). The `slice-graph`
`SLICE_RULES` declare no forbidden `realtime → voice` edge, so the composition
is fence-legal. The surface (`apps/cli`) is the only plane-crossing point.

## Consequences

- New configurable surface: `/voice-live` slash + a `realtime voice` config knob
  (endpoint / model / mode / voice / VAD). Opt-in only.
- 13 HELL-RTV cases + a default-OFF byte-identical anchor + pure-unit coverage of
  the pcm-bridge and session-config (`tests/unit/realtime/voice-session-hellgate.test.ts`,
  `tests/unit/cli/voice-live-cmd-hellgate.test.ts`).

### Non-goals (explicit)

- ❌ Custom audio codec / opus encode-decode (server-side; install-gate blocked).
- ❌ Tool-calling over realtime (MVP is conversation only).
- ❌ WebRTC peer-connection media path (we use WS+base64; the SDP negotiator stays
  available for a future WebRTC adapter but is unused here).
- ❌ Reconnect/backoff (the transport already classifies close codes; reconnect is
  a follow-up).
- ❌ Multi-party / multi-voice mixing.
