/**
 * Image downsample planning (gap-other-agent GAP 1) — essential PURE functions.
 *
 * quanta hard-rejects images over {@link MAX_IMAGE_BYTES}. Codex downsamples
 * (PIL LANCZOS → a max longest-edge). quanta is pure-TS with NO image codec
 * vendored, so the actual decode→resize→encode rides a `DownsamplePort` injected
 * by the host (a WASM/native codec). Absent port ⇒ the plan is `reject` —
 * byte-identical to today. These two pure helpers are the decision + the geometry;
 * they pull in no codec and never throw.
 */

/** What to do with an image at the read boundary. */
export type ImageReadPlan = "ok" | "downsample" | "reject"

/**
 * Decide the plan: within the byte cap ⇒ `ok`; over cap ⇒ `downsample` iff a
 * codec is available, else `reject` (the current behavior — so an unwired host is
 * byte-identical). `==` cap counts as within (the existing boundary is inclusive).
 */
export const planImageRead = (
  byteLen: number,
  capBytes: number,
  canDownsample: boolean,
): ImageReadPlan => {
  if (byteLen <= capBytes) return "ok"
  return canDownsample ? "downsample" : "reject"
}

/** Target pixel dimensions after capping the LONGEST edge to `maxDim`, preserving
 *  aspect ratio. For an INTEGER `maxDim` (the real pixel budget) the longest edge
 *  is exactly `maxDim`; a fractional `maxDim` may round within <1px of it.
 *  Never upscales (already-small ⇒ unchanged). Rounds to ≥1px.
 *  Guards non-finite / non-positive input by returning it unchanged (the caller
 *  treats an unchanged result as "cannot plan" and falls back to reject). Pure. */
export const scaleToMaxDim = (
  width: number,
  height: number,
  maxDim: number,
): { readonly width: number; readonly height: number } => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxDim) ||
    width <= 0 ||
    height <= 0 ||
    maxDim <= 0
  ) {
    return { width, height }
  }
  const longest = Math.max(width, height)
  if (longest <= maxDim) return { width, height }
  const scale = maxDim / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
