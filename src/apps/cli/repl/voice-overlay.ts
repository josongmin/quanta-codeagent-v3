/**
 * Voice capture/transcribe overlay (ADR-0202).
 *
 * Stateless status-line writers — all output goes to stderr so the prompt
 * composer (stdout) stays clean. The HELL-VC-02 case pins this invariant.
 *
 * The four functions match the four phases of a voice round-trip:
 *   1. capturing    — sox is recording the mic
 *   2. transcribing — STT round-trip in flight
 *   3. confirm      — transcript prefilled, awaiting user Enter
 *   4. failed       — capture or STT errored; user falls back to keyboard
 */

export interface VoiceOverlay {
  capturing(secs: number): void
  transcribing(): void
  confirm(text: string, confidence: number): void
  failed(kindMessage: string): void
}

export interface VoiceOverlayOpts {
  /** Inject in tests; defaults to `process.stderr.write`. */
  readonly write?: (s: string) => void
}

const fmtConfidence = (c: number): string => {
  if (!Number.isFinite(c)) return "?"
  return `${Math.round(c * 100)}%`
}

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`

export const createVoiceOverlay = (opts: VoiceOverlayOpts = {}): VoiceOverlay => {
  const write =
    opts.write ??
    ((s: string) => {
      process.stderr.write(s)
    })
  return {
    capturing(secs) {
      write(`[voice] capturing for ${secs}s... (Ctrl+C to abort)\n`)
    },
    transcribing() {
      write("[voice] transcribing...\n")
    },
    confirm(text, confidence) {
      write(
        `[voice] transcript (${fmtConfidence(confidence)}): "${truncate(text, 120)}"\n` +
          "[voice] review the prompt, then press Enter to submit (or edit/clear).\n",
      )
    },
    failed(kindMessage) {
      write(`[voice] ${kindMessage}\n`)
    },
  }
}
