# ADR-0208: Voice `/voice` slice — handle-based recorder + transcriber ports + CLI

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0202 (voice input leaf one-shot port — this slice is the
  sibling handle-based shape + the CLI surface the leaf slice deferred), ADR-0083
  (multi-modal image input — sibling input-channel pattern this slice mirrors),
  ADR-0128/0145 (plan-queue + `voice_transcript` source enum this slice writes
  to), ADR-0192 (shell-execa swap — we shell out to `sox`/`arecord`/`parec` rather
  than installing a node audio lib), ADR-0024 (slice-isolation rule the new
  `@/voice` path obeys)
- **References**: `src/voice/**`, `src/apps/cli/voice-cmd.ts`,
  `tests/unit/voice-recorder-hellgate.test.ts`,
  `tests/unit/voice-transcriber-hellgate.test.ts`,
  `tests/unit/cli/voice-cmd-hellgate.test.ts`

## Research grounding (4-vendor convergence)

| Vendor | Slash | Recorder | STT |
|---|---|---|---|
| Claude desktop | `/voice` | Web Audio API | Deepgram |
| Aider | `/voice` | sox shell-out | OpenAI Whisper REST |
| Windsurf | mic icon | Native (Electron getUserMedia) | proprietary |
| Codex realtime | hold-to-talk | WebRTC PeerConnection | OpenAI Realtime |

The pattern is **strong-signal across 4 vendors** — voice → STT → prompt-prefill
→ confirm. The vendor pick varies; the port shape doesn't. This slice ships the
port shape + 3 adapters + the CLI slash. ADR-0202 already shipped a leaf
one-shot capture port with Deepgram + Whisper REST adapters — that primitive is
correct for non-interactive surfaces (CI smoke, scripted tests) but its
`captureOnce(secs)` shape is wrong for the interactive `/voice` flow where the
user holds the line until pressing Enter. This slice ships the sibling
handle-based shape AND the CLI surface that ADR-0202 explicitly deferred.

## Context

`/voice` has three concerns that drift apart if collapsed:

1. **Audio capture** — handle-based start/stop so the surface decides when to
   stop. Cross-platform (sox / arecord / parec cascade); needs cancellation
   (AbortSignal mid-record), oversize cap (don't accumulate gigabytes), and
   idempotent stop (slash retries / surface races).
2. **Speech-to-text** — multi-vendor with richer response (segments + language)
   than ADR-0202's leaf STT shape; needs per-request timeout + AbortSignal
   honoring + multi-language.
3. **Slash surface** — dispatch / record / transcribe / enqueue. Honors
   confirm-always (ADR-0202's HELL-VC-01 invariant carries over — the
   transcript is enqueued / printed, NEVER auto-submitted).

ADR-0202 collapsed (1) and (2) into a fixed-duration one-shot port. That's the
right primitive for non-interactive callers, but the `/voice` slash needs
start-then-wait-for-user-keystroke-then-stop, which the one-shot shape can't
express without leaking child-process state out to the surface. This slice
adds the handle-based sibling.

## Decision

Add THREE leaf-level ports in `src/voice/`:

- **`AudioRecorderPort`** (`src/voice/port.ts`)
  - `availability(): string | null` — synchronous probe; returns the resolved
    backend name (`"sox"` / `"arecord"` / `"parec"`) or `null` when none of the
    cascade entries are on PATH.
  - `start(opts?): Promise<Result<RecorderHandle, RecorderError>>` — spawn
    the recorder; returns an opaque handle the surface passes back to `stop()`.
  - `stop(handle): Promise<Result<AudioBytes, RecorderError>>` — SIGTERM the
    child, drain stdout into a wav buffer, return idempotently.

- **`TranscriberPort`** (`src/voice/transcriber/port.ts`)
  - `transcribe({audio, format, language?, signal?}): Promise<Result<VoiceTranscript, TranscriberError>>`
    — single request/response with segments + language in the response.
    Streaming STT (Deepgram WebSocket) is a follow-up slice.

- **`VoiceQueueSink`** (subset of `PlanQueueStore.enqueue` for `voice_transcript`
  source) (`src/apps/cli/voice-cmd.ts`) — the surface owns the plan-queue
  instance; the slash command receives a typed enqueue port and writes the
  transcript as a `voice_transcript` follow-up.

All ports return `Result<…>` (the shared @/shared discriminant) — no thrown
errors on operational failure. Programmer-bug input (bad rate / channels /
format / maxBytes) is encoded as a typed `Err` variant.

### Recorder backends (cascade)

`createPlatformRecorder()` resolves the first backend on PATH from
`[sox, arecord, parec]`. `createMacMicRecorder()` pins to sox only (Linux
backends silently filtered — no surprise fallback on macOS).

| Backend | Bin | Platform | argv shape |
|---|---|---|---|
| sox | `sox` | macOS + Linux | `sox -d -t wav - rate N channels K` |
| arecord | `arecord` | Linux ALSA | `arecord -q -f S16_LE -r N -c K -t wav` |
| parec | `parec` | Linux PulseAudio | `parec --format=s16le --rate=N --channels=K` |

### Transcriber adapters

| Adapter | Vendor | Auth | Streaming | Segments | Language |
|---|---|---|---|---|---|
| `openai-whisper-transcriber` | OpenAI `/v1/audio/transcriptions` | `OPENAI_API_KEY` | no | yes (`verbose_json`) | yes |
| `deepgram-transcriber` | Deepgram `/v1/listen` | `DEEPGRAM_API_KEY` | no (follow-up: WS) | yes (utterances + words fallback) | yes |
| `local-whisper-transcriber` | whisper.cpp binary | none | no | no | yes (`-l` flag) |

External SDK installs (`@deepgram/sdk`, `openai`) are blocked in this
environment (verify-workflow memory). Direct REST calls are the path; the
SDK swap is documented as a one-line adapter-body change in each adapter's
header comment.

### CLI `/voice` subcommands

| Subcommand | Behavior |
|---|---|
| `/voice` | start → wait for Enter (reader) or fixed-duration → stop → transcribe → enqueue |
| `/voice status` | print backend + transcriber + plan-queue wire status |
| `/voice cancel` | no-op (cancel needs surface-held in-flight handle; documented as follow-up) |

### Safe invariant — confirm always (carried from ADR-0202)

The transcribed text is **only ever enqueued or printed**. It NEVER
auto-submits. The plan-queue replays the `voice_transcript` follow-up at the
next turn boundary, where the surface MUST show it to the user before any
send. Locked by HELL-VCMD-03 (enqueued, not submitted) + HELL-VCMD-05
(printed, not submitted).

### Default-OFF wire

- `src/apps/cli/voice-cmd.ts` accepts an optional `recorder` in its ctx;
  none of the existing call sites pass one.
- `src/apps/cli/repl.ts` is NOT touched. The slash is built; surfaces opt
  in by extending their existing slash dispatcher to call
  `runVoiceCmd("/voice", ctx)` with `{recorder, transcriber?, planQueue?}`.
- The `@/voice` barrel exports the ports + adapters + helpers; no
  side-effect imports.
- `src/agent/plan-queue.ts` is NOT mutated. The slash calls its existing
  public `enqueue()` method through the `VoiceQueueSink` port.

## Hellgate (31 cases)

- `tests/unit/voice-recorder-hellgate.test.ts` (10 cases) —
  `HELL-VR-01..10` pin: backend-missing default-OFF parity, cascade order,
  start→stop bytes, oversize cap + SIGTERM, idempotent stop, abort
  pre-start, abort mid-record, spawn-throws, invalid-opts (rate / channels
  / format / maxBytes), mac-mic sox-only pin.
- `tests/unit/voice-transcriber-hellgate.test.ts` (13 cases) —
  `HELL-VT-01..13` pin: deepgram 200 / 401 / 429 / 500, whisper 200 / 4xx
  / timeout, empty-audio both, unsupported-format both, abort pre-call
  both, language passthrough both, local-whisper binary-missing,
  local-whisper happy-path argv assertion.
- `tests/unit/cli/voice-cmd-hellgate.test.ts` (8 cases) —
  `HELL-VCMD-01..08` pin: recorder-undefined → backend-missing exit 1,
  resolved-null status, happy-path enqueue with metadata, transcriber-
  unwired byte-count, plan-queue-unwired stdout, Esc cancel, transcriber
  auth-failed, unknown subcommand.

All adapters are fully driven by injected ports (fetch, spawner,
filesystem) — zero real network calls, zero real sox processes.

## Default-OFF

Nobody wires this today. The `recorder` / `transcriber` / `planQueue`
deps in `VoiceCmdCtx` are all optional; existing call sites (none) omit
them ⇒ the slash prints "voice backend missing" and exits 1. Zero token
cost, zero behavior change until a surface opts in by:

1. constructing `createDefaultRecorder()` (or `createMacMicRecorder()`)
2. constructing one of the three transcriber adapters with the
   appropriate API key
3. passing both + the existing `PlanQueueStore` instance into
   `VoiceCmdCtx`
4. dispatching to `runVoiceCmd("/voice", ctx)` from its slash router

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Reuse ADR-0202's one-shot port** | `captureOnce(secs)` can't express "record until user presses Enter" — the surface would have to poll-then-cancel, which races. Handle-based start/stop is the right primitive for interactive flow. Both ports coexist. |
| **Inline plan-queue mutation** | The user explicitly forbade mutating `plan-queue.ts`. The `VoiceQueueSink` port is a structural subset of `PlanQueueStore.enqueue` — the surface owns the store, the slash calls the public method. |
| **`@deepgram/sdk` npm install** | Install BLOCKED in this environment. Direct REST fetch is 100 LOC and the SDK swap is a one-line adapter-body change documented in the file header. |
| **Auto-submit after transcription** | Voice misrecognition into destructive commands is the obvious footgun. The confirm-always invariant (carried from ADR-0202's HELL-VC-01) is non-negotiable. |
| **Single recorder backend** | macOS users install sox; Linux users may have only arecord (default Ubuntu install). Cascading the three resolves both without per-platform branches at every call site. |
| **Hard-fail when backend missing** | Graceful `Err({kind:"backend-missing"})` lets the slash render "install sox" once and exits clean. Hard-throw forces every caller to wrap in try/catch and risks swallow-and-paint mismatches. |
| **Webm in addition to wav for whisper.cpp** | whisper.cpp doesn't accept webm without an ffmpeg conversion step we don't bundle. The local-whisper adapter rejects webm with `unsupported-format`; the surface re-records with `format:"wav"` instead. |
| **Wire into repl.ts directly** | The user explicitly scoped this slice to `src/voice/* + src/apps/cli/voice-cmd.ts 신규만`. Wiring is a follow-up that the surface owner decides. |

## Consequences

- **Default-OFF byte-identical**: existing CLI / agent / runner paths are
  unaffected. No imports from this slice exist elsewhere in the tree.
- **Plane-clean leaf**: `src/voice/**` imports only `@/shared` +
  `node:fs/promises` (for the local-whisper temp-file dance) +
  `node:os` / `node:path`. It does NOT touch `@/agent` / `@/tool` /
  `@/llm` / `@/mcp` / `@/permission` — voice is an input channel.
- **Slash command** imports `@/voice` + a TYPE-only ref to
  `@/agent/plan-queue.PlanQueueStore` — no value-level import of the
  agent slice.
- **Confirm-always**: transcripts enqueue or print; never auto-submit.
  Locked by HELL-VCMD-03 / HELL-VCMD-05.
- **Stderr separation**: capture/transcribing progress goes to stderr;
  the transcript itself goes to stdout (or the plan-queue). Locked by
  HELL-VCMD-04.
- **Follow-up slices**:
  - Wire `runVoiceCmd` into `tryRunReplSlash` (surface decision).
  - VAD (voice-activity-detection) auto-stop (`sox silence`).
  - Streaming STT (Deepgram WebSocket; Whisper does not stream).
  - Tauri surface using browser `getUserMedia()` for the recorder
    (different recorder adapter behind the same `AudioRecorderPort`).
  - `@deepgram/sdk` / `openai` SDK adapter-body swap when install gating
    relaxes.
