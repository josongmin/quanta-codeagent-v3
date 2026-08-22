/**
 * `image_gen` write-side port (H14a) — the jailed binary-write chokepoint.
 *
 * Binary PNG/JPEG/WebP bytes cannot go through `FileSystemPort.writeFile`
 * (string content). This tiny port mirrors that DI posture for RAW bytes:
 * the tool jails the path via `@/storage#resolveJailed` (the SAME chokepoint
 * `read`/`write`/`edit` use), then hands the BRANDED absolute path + bytes to
 * the port. The default port writes through `Bun.write`; tests inject an
 * in-memory map.
 *
 * Slice posture: imports ONLY `@/storage` (for the jailed write seam). The
 * jail decision lives at the tool's `resolveJailed` call — a port substitution
 * cannot widen it, because the port receives an ALREADY-jailed absolute path.
 */

/** Raw-byte write seam. `path` is an absolute path the tool has already passed
 *  through `resolveJailed` (so it is confined to `ctx.cwd`). */
export interface ImageWritePort {
  /** True iff a file exists at the absolute jailed path. */
  exists(path: string): Promise<boolean>
  /** Write raw bytes to the absolute jailed path (creating parent dirs). */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
}

/** Default `@/storage`-backed port using Bun's file primitives. `Bun.write`
 *  creates parent dirs and accepts a `Uint8Array` directly. */
export const defaultImageWritePort: ImageWritePort = {
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists()
  },
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await Bun.write(path, bytes)
  },
}
