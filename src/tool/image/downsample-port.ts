/** Closed-port for image downsampling (gap-other-agent GAP 1).
 *
 *  quanta is pure-TS with NO vendored image codec, so the actual decode → resize
 *  → re-encode rides a host-injected port (a WASM/native codec). The pure DECISION
 *  + geometry live in {@link ./downsample-plan} (`planImageRead`, `scaleToMaxDim`);
 *  this port is the EXECUTION half. Absent ⇒ `read_image` rejects oversized images
 *  exactly as before (byte-identical). NO-THROW: failures are a closed result arm.
 */
import type { SupportedMediaType } from "./read"

export type ImageDownsampleOutcome =
  | { readonly kind: "ok"; readonly bytes: Uint8Array; readonly mediaType: SupportedMediaType }
  /** The codec could not handle this input (unknown format, decode error) — the
   *  caller falls back to the over-cap rejection. */
  | { readonly kind: "unable"; readonly reason: string }

export interface ImageDownsamplePort {
  /**
   * Downsample oversized image bytes to fit a byte + longest-edge-pixel budget.
   * The port owns decode + dimension extraction (it may use {@link scaleToMaxDim}
   * internally) + re-encode. NO-THROW: any failure ⇒ `{ kind:"unable" }`.
   */
  downsample(
    bytes: Uint8Array,
    mediaType: SupportedMediaType,
    maxBytes: number,
    maxDim: number,
    signal?: AbortSignal,
  ): Promise<ImageDownsampleOutcome>
}
