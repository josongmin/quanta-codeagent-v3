/**
 * macOS `sips`-backed {@link ImageDownsamplePort} (gap GAP 1, ADR-0507).
 *
 * quanta vendors NO image codec, so the `read_image` downsample port is host-
 * provided. macOS ships `sips` (Scriptable Image Processing System) at
 * `/usr/bin/sips` — a built-in, dependency-free decoder/resizer. This adapter
 * shells out to it (argv-array, NO shell) over a private temp dir: write the
 * oversized bytes, `sips -Z <maxDim>` (resampleHeightWidthMax = cap the LONGEST
 * edge, aspect-preserving), read the result back.
 *
 * PLATFORM-BOUND: macOS only — the composition root wires this ONLY when
 * `process.platform === "darwin"` AND `QUANTA_IMAGE_DOWNSAMPLE` is on. On other
 * platforms the port is absent ⇒ `read_image` rejects oversized images exactly as
 * before (byte-identical). NO-THROW: any failure (spawn error, non-zero exit,
 * unreadable output) collapses to `{ kind:"unable" }`, and `read_image` falls back
 * to the over-cap rejection.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage, logger } from "@/shared"
import type { ImageDownsampleOutcome, ImageDownsamplePort, SupportedMediaType } from "@/tool/image"

/** sips does NOT infer output format from the `.ext` alone (it can keep the
 *  source-detected format) — the format is FORCED via `-s format <token>`. Map the
 *  media type to BOTH the temp-file extension and the sips format token. */
const formatOf = (mediaType: SupportedMediaType): { ext: string; fmt: string } => {
  switch (mediaType) {
    case "image/jpeg":
      return { ext: "jpg", fmt: "jpeg" }
    case "image/webp":
      return { ext: "webp", fmt: "webp" }
    case "image/gif":
      return { ext: "gif", fmt: "gif" }
    default:
      return { ext: "png", fmt: "png" }
  }
}

/** Build the sips downsample port. Pure construction (no I/O until a call). */
export const sipsImageDownsamplePort = (): ImageDownsamplePort => ({
  downsample: async (
    bytes: Uint8Array,
    mediaType: SupportedMediaType,
    _maxBytes: number,
    maxDim: number,
    signal?: AbortSignal,
  ): Promise<ImageDownsampleOutcome> => {
    if (signal?.aborted === true) return { kind: "unable", reason: "aborted before start" }
    const { ext, fmt } = formatOf(mediaType)
    let dir: string
    try {
      dir = await mkdtemp(join(tmpdir(), "quanta-sips-"))
    } catch (e) {
      return { kind: "unable", reason: `tmp dir: ${errMessage(e)}` }
    }
    const inPath = join(dir, `in.${ext}`)
    const outPath = join(dir, `out.${ext}`)
    try {
      await writeFile(inPath, bytes)
      // argv-array (NO shell): `-s format <fmt>` FORCES the output codec (sips
      // otherwise keeps the source-detected format); `-Z` =
      // --resampleHeightWidthMax scales the longest edge ≤ maxDim (aspect kept).
      const args = [
        "sips",
        "-s",
        "format",
        fmt,
        "-Z",
        String(Math.max(1, Math.floor(maxDim))),
        inPath,
        "-o",
        outPath,
      ]
      const proc = Bun.spawn(args, {
        stdout: "ignore",
        stderr: "ignore",
        ...(signal !== undefined ? { signal } : {}),
      })
      await proc.exited
      if (proc.exitCode !== 0) return { kind: "unable", reason: `sips exit ${proc.exitCode}` }
      const out = await readFile(outPath)
      return { kind: "ok", bytes: new Uint8Array(out), mediaType }
    } catch (e) {
      return { kind: "unable", reason: errMessage(e) }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((e) =>
        logger.warn(`sips temp cleanup failed: ${errMessage(e)}`),
      )
    }
  },
})
