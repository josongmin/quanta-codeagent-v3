# ADR-0202: Voice input (microphone capture + STT)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0083 (multi-modal image input — sibling input-channel
  pattern this slice mirrors), ADR-0145 (subagent + plan queue — confirm-required
  HITL discipline for non-text inputs), ADR-0146 (read_image / web_fetch
  external-fetch sibling-adapter pattern), ADR-0192 (shell-execa swap; here we
  shell-out to `sox` instead of installing a node audio lib)
- **References**: `src/media/voice/**`, `src/media/stt/**`,
  `src/apps/cli/repl/voice-overlay.ts`,
  `tests/unit/media/voice-input-hellgate.test.ts`,
  `tests/unit/media/stt-hellgate.test.ts`,
  `tests/unit/cli/voice-confirm-hellgate.test.ts`

## Research grounding

Per `docs/analysis/경쟁사리뷰/code-agent-loop/`: Claude desktop's `/voice`
(Deepgram-backed) is the only one of the three reference agents that ships
a microphone-capture-to-prompt path. Codex and Cursor do not. The
multi-modal trend (image + audio + transcript) is still emerging — the
conservative posture is to ship the **input-channel primitive** behind a
default-OFF wire and let surfaces opt in later. The exact transcription
provider (Deepgram, Whisper, future on-device) varies; the slice must NOT
hard-pin either.

## Context

Voice input has two distinct concerns that drift together if collapsed:

1. **Audio capture** — get raw wav bytes off the mic. Cross-platform; OS
   dependent; needs cancellation (don't leave a recorder running after the
   turn aborts).
2. **Speech-to-text** — transcribe the wav into prompt text. Network call;
   provider-specific; needs an auth key; can fail (rate limit / auth /
   empty result).

A single `record_and_transcribe` would compose them inline and force the
caller to pick a provider on every call. A 2-port split lets us:
- mock the capture port in tests without mocking the network,
- swap STT providers by env without touching capture,
- ship a `headless-stub` capture so test rigs that DON'T have `sox` installed
  still exercise the downstream prompt-fill flow.

External SDK install is blocked in this environment, so STT adapters
hand-roll the REST call (Deepgram `POST /v1/listen` and OpenAI
`POST /v1/audio/transcriptions`). Swapping to `@deepgram/sdk` later is a
1-line adapter-body change behind the same port.

Audio capture shells out to `sox -d -t wav - rate 16000 channels 1 trim 0 N`,
which is the smallest common-denominator cross-platform recorder
(`brew install sox` / `apt install sox`). If `sox` is missing the slice
returns `Err({kind: "sox-missing", degradeReason})` — never throws — so the
host renders a clear "please install sox" message and falls back to keyboard.

## Decision

Add two leaf-level ports in `src/media/`:

- **`VoiceInputPort`** (`src/media/voice/port.ts`)
  - `captureOnce(opts?): Promise<Result<AudioBlob, CaptureError>>` — single
    fixed-duration capture; idempotent.
  - `stop(): void` — surface a cancellation lever even though `captureOnce`
    accepts `AbortSignal` (some surfaces want to call `stop()` from a
    UI button without holding a signal).
- **`SpeechToTextPort`** (`src/media/stt/port.ts`)
  - `transcribe(blob: AudioBlob): Promise<Result<Transcript, SttError>>`.

Both ports return `Result<…>` (the shared @/shared discriminant) — no thrown
errors on operational failure (auth, rate-limit, sox-missing, empty audio).
Programmer-bug input (e.g. unsupported mime, 0-byte blob) is encoded as a
typed `Err` variant the host renders.

### Adapters

- `src/media/voice/sox-capture.ts` — spawns sox via `Bun.spawn`; reads stdout
  into a `Uint8Array`; on `AbortSignal` or `stop()` sends SIGTERM. Checks
  `which sox` first; returns `Err("sox-missing")` synchronously if absent.
- `src/media/voice/headless-stub.ts` — deterministic 44-byte wav header +
  silence (zero samples); for tests + CI.
- `src/media/stt/deepgram-adapter.ts` — direct fetch POST with
  `Authorization: Token ${DEEPGRAM_API_KEY}`; parses
  `results.channels[0].alternatives[0]`.
- `src/media/stt/openai-whisper-adapter.ts` — direct fetch multipart POST;
  parses `{text, language}`; confidence forced to 1.0 (provider does not
  return per-utterance confidence).
- `src/media/stt/headless-stub.ts` — returns
  `{text:"test transcription", confidence:1.0}`.

### Registry

`src/media/stt/registry.ts` selects an STT adapter from env:

| `DEEPGRAM_API_KEY` | `OPENAI_API_KEY` | Selected |
|---|---|---|
| set | any | deepgram |
| unset | set | whisper |
| unset | unset | headless-stub |

Deepgram is preferred when both keys are present (per the AGENTS.md grounding —
Deepgram is the path Claude desktop already ships). Both-set callers can
override by constructing the adapter directly.

### Safe invariant — confirm always

The transcribed text is **only ever prefilled** into the prompt composer.
It NEVER auto-submits. The user reviews + presses Enter. This protects
against silent transcription drift ("delete files" misheard from "list
files") and is locked by `HELL-VC-01`. The prompt-pipeline plumbing is a
new optional `voice` dep block whose default-undefined value is
byte-identical to the existing text-only path.

### Default-OFF wire

- `src/apps/cli/repl/session-loop.ts` accepts an optional `voice` block
  (none of the existing call sites pass one).
- `src/apps/agent/index.ts` does NOT wire it. (Per the user instruction
  block.)
- The barrel `src/media/index.ts` re-exports the ports + adapters + registry.
- `prompt-pipeline.ts` gains an optional `voiceQueue` dep — when undefined
  the inner loop is byte-identical (verified by HELL-V-01).

The slash command + keyboard-trigger surface is a follow-up slice; this
ADR ships only the ports, adapters, registry, overlay, and prompt-pipeline
optional drain.

## Hellgate (23 cases)

- `tests/unit/media/voice-input-hellgate.test.ts` (6 cases) —
  `HELL-V-01..06` pin: default-OFF byte-identical, sox spawn ⇒ AudioBlob,
  sox-missing degrade, AbortSignal ⇒ SIGTERM, invalid duration rejection,
  headless-stub deterministic bytes.
- `tests/unit/media/stt-hellgate.test.ts` (13 cases) — `HELL-S-01..13`
  pin: deepgram parse, deepgram 401/429/empty, whisper parse, whisper 4xx,
  registry 3 env modes + dual-key fallback, low-confidence forces confirm,
  unsupported mime, 0-byte blob.
- `tests/unit/cli/voice-confirm-hellgate.test.ts` (4 cases) —
  `HELL-VC-01..04` pin: never auto-submits, overlay to stderr, full
  capture → transcribe → confirm flow with 3 mock ports, empty-text on
  STT failure.

## Default-OFF

Nobody wires this today. The `voice` dep is optional on every consumer;
existing call sites omit it ⇒ the loop, prompt-pipeline, and CLI surface
are byte-identical. Zero token cost, zero behavior change until a follow-up
slice adds the slash command + keyboard trigger.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Single `record_and_transcribe` port** | Composes capture and STT inline; forces test mocks to bridge both; locks the caller into one provider per call. Two ports keep capture testable without network. |
| **`@deepgram/sdk` npm install** | Install BLOCKED in this environment (verify-workflow memory). Direct REST fetch is 30 LOC and the swap to the SDK later is a 1-line adapter-body change. |
| **Node `mic` package** | Same install-block. `sox` shell-out is cross-platform AND graceful-degrade when missing. |
| **Auto-submit after transcription** | Voice misrecognition into destructive commands is the obvious footgun (cf. `ls→delete`). The confirm-always invariant is non-negotiable. |
| **Hard-fail when sox missing** | Forces a system install before any voice surface works. Graceful Err lets the host render "install sox" once and fall back to keyboard, matching the multi-surface posture (verify-workflow memory). |
| **Throw on operational errors** | Result-typed Err lets the overlay render a single status line; throws force every caller to wrap in try/catch and risk swallow-and-paint mismatches. |

## Consequences

- **Default-OFF byte-identical**: existing CLI / agent / runner paths are
  unaffected. Verified by `HELL-V-01`.
- **Plane-clean leaf**: `src/media/` imports only `node:child_process`-style
  primitives (via Bun.spawn), `node:crypto` (for the headless-stub seed if
  needed), and `@/shared` (`Result`, `ok`/`err`). It does NOT touch
  `@/agent`, `@/tool`, `@/llm`, `@/mcp`, `@/permission` — voice is an
  input channel, not a tool.
- **Stderr overlay**: the capture/transcribing status lines go to stderr so
  the prompt composer (stdout) stays clean. Locked by `HELL-VC-02`.
- **Confirm-always**: transcripts prefill only; never auto-submit. Locked
  by `HELL-VC-01`.
- **Follow-up slices**:
  - Slash command `/voice [secs]` + keyboard trigger (Ctrl+V hold-to-talk).
  - VAD (voice-activity-detection) auto-stop (sox `silence 1 0.1 1% -1 1.0 1%`).
  - Streaming STT (Deepgram websocket; Whisper does not stream).
  - On-device transcription (whisper.cpp) when install gating relaxes.
