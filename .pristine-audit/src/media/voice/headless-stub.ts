import { err, ok, type Result } from "@/shared"
import type { CaptureOpts, VoiceInputPort } from "./port"
import type { AudioBlob, CaptureError } from "./types"

/** Deterministic 44-byte wav RIFF header for an empty PCM payload. The
 *  header is byte-stable so tests can assert exact `.bytes` content. The
 *  payload is intentionally empty (0 samples) — the stub exists for
 *  prompt-flow tests, NOT for downstream STT realism. */
const HEADLESS_WAV_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
])

/** No-network, no-spawn VoiceInputPort for CI + headless tests. Always
 *  returns the same 44-byte wav header regardless of `secs`. */
export const headlessVoiceInput = (): VoiceInputPort => ({
  async captureOnce(opts?: CaptureOpts): Promise<Result<AudioBlob, CaptureError>> {
    const secs = opts?.secs ?? 1
    if (!Number.isFinite(secs) || secs <= 0) {
      return err({ kind: "invalid-duration", secs })
    }
    if (opts?.signal?.aborted === true) {
      return err({ kind: "aborted" })
    }
    return ok({
      mime: "audio/wav",
      bytes: HEADLESS_WAV_HEADER.slice(),
      durationMs: Math.round(secs * 1000),
    })
  },
  stop(): void {},
})

export { HEADLESS_WAV_HEADER }
