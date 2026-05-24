/**
 * Import dedup primitives (ADR-0038, L4 promotion).
 *
 * Today the slice only exposes the content-hash primitive. The persisted
 * import log still records one append-only summary row per run
 * (`timestamp/provider/stage/ok/detail`), so it cannot answer a per-session
 * dedup query without growing new structured fields. Until that schema exists,
 * we deliberately DO NOT expose a public `wasAlreadyImported(...)` surface.
 */

import { readFile } from "node:fs/promises"

/** SHA-256 (hex) of a file's raw bytes. Real implementation — used to
 *  fingerprint a session transcript for dedup + change detection. */
export const contentSha256 = async (jsonlPath: string): Promise<string> => {
  const bytes = await readFile(jsonlPath)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
