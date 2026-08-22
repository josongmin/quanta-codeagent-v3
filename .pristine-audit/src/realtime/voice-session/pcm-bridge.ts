/**
 * Realtime voice-session — the SINGLE isolated DSP seam (ADR-0442, RFC §3.4).
 *
 * HONEST BOUNDARY: this is NOT a codec. We do NOT encode/decode opus and we
 * never will here (`src/realtime/audio-codec.ts:1-19` documents that opus
 * needs install-gate-blocked native bindings). The Realtime API does VAD +
 * codec + TTS server-side; it accepts raw PCM16 frames and emits PCM16. The
 * only local processing needed is:
 *
 *   1. strip the 44-byte canonical WAV (RIFF) header so we send RAW pcm16
 *      samples (trivial + pure), and
 *   2. (optional) linear-interpolate resample when the recorder's capture
 *      rate differs from the API's 24 kHz (the ONE piece of real DSP — a
 *      pure leaf function, NOT a transcoder).
 *
 * Both are pure: same input bytes ⇒ same output bytes. No time, no I/O, no
 * randomness. Plane-clean: zero imports.
 */

/** Canonical PCM WAV header size in bytes (RIFF + fmt + data chunk headers
 *  with no extra chunks). The recorders we drive (sox/arecord/parec) emit
 *  this canonical layout. */
const CANONICAL_WAV_HEADER_BYTES = 44

/** ASCII for "RIFF" — the WAV magic. */
const RIFF = 0x46464952 // little-endian "RIFF" read as uint32

/**
 * Strip a canonical 44-byte WAV header, returning the raw PCM sample bytes.
 * If the buffer does NOT start with the RIFF magic (already raw PCM, or too
 * short), it is returned unchanged — we never corrupt non-WAV input.
 */
export const stripWavHeader = (wav: Uint8Array): Uint8Array => {
  if (wav.byteLength <= CANONICAL_WAV_HEADER_BYTES) return wav
  // Read the first 4 bytes as a LE uint32 and compare to "RIFF". Avoids a
  // DataView allocation; pure arithmetic. The length guard above ensures
  // indices 0-3 exist.
  const b0 = wav[0] as number
  const b1 = wav[1] as number
  const b2 = wav[2] as number
  const b3 = wav[3] as number
  const magic = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
  if (magic >>> 0 !== RIFF) return wav
  return wav.subarray(CANONICAL_WAV_HEADER_BYTES)
}

/**
 * Linear-interpolation resample of mono PCM16 (little-endian) from `fromRate`
 * to `toRate`. Pure. When the rates match this is a defensive copy passthrough.
 *
 * This is sample-rate conversion, NOT a codec. We keep it deliberately simple
 * (linear interp) — high-quality resampling (sinc/polyphase) is out of scope;
 * the Realtime API tolerates linear-resampled PCM16 for voice.
 */
export const resamplePcm16 = (pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array => {
  if (fromRate <= 0 || toRate <= 0) return pcm
  if (fromRate === toRate) return new Uint8Array(pcm)
  // Number of 16-bit samples in the input (drop a trailing odd byte).
  const inSamples = Math.floor(pcm.byteLength / 2)
  if (inSamples === 0) return new Uint8Array(0)
  const view = new DataView(pcm.buffer, pcm.byteOffset, inSamples * 2)
  const ratio = toRate / fromRate
  const outSamples = Math.max(1, Math.floor(inSamples * ratio))
  const out = new Uint8Array(outSamples * 2)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < outSamples; i++) {
    // Map output sample i back to a fractional input position.
    const srcPos = i / ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, inSamples - 1)
    const frac = srcPos - i0
    const s0 = view.getInt16(i0 * 2, true)
    const s1 = view.getInt16(i1 * 2, true)
    const interp = Math.round(s0 + (s1 - s0) * frac)
    outView.setInt16(i * 2, interp, true)
  }
  return out
}

/**
 * Compose: strip a WAV header (if present) then resample to the API rate.
 * The up-pump calls this on each mic chunk before base64-encoding.
 */
export const bridgeToRealtime = (
  chunk: Uint8Array,
  captureRate: number,
  targetRate: number,
): Uint8Array => resamplePcm16(stripWavHeader(chunk), captureRate, targetRate)
