/**
 * Import dedup primitives (ADR-0038 + ADR-0430).
 *
 * The import log now records per-item rows carrying `{ itemKind, contentHash,
 * ok }` (ADR-0430 schema growth) in ADDITION to the append-only summary row.
 * {@link wasAlreadyImported} answers the per-item dedup query against those
 * rows so a re-import skips items it already persisted. N10: every byte-read
 * in this slice routes through {@link readImportFile}, which refuses a
 * credential file (`auth.json`) before any read syscall.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { QuantaError } from "@/shared"
import type { ImportLog } from "./types"

/**
 * N10 credential-read ban (ADR-0430 HARD invariant).
 *
 * The importer reads transcripts, configs, and rule docs off a competitor's
 * install dir — but it MUST NEVER read a credential file (Claude Code's
 * `auth.json` holds OAuth tokens). Detection uses `access(2)` existence
 * checks only (no bytes read); every byte-reading path in this slice routes
 * through {@link readImportFile}, which refuses a banned basename BEFORE any
 * `open`/`read` syscall. Tests spy on `node:fs` to assert no read of
 * `auth.json` ever reaches the filesystem.
 */
const BANNED_CREDENTIAL_BASENAMES: ReadonlySet<string> = new Set([
  "auth.json",
  ".credentials.json",
  "credentials.json",
])

/** Thrown if any code in the migration slice attempts to READ a credential
 *  file. The throw happens before the filesystem is touched. */
export class CredentialReadBannedError extends QuantaError {
  readonly path: string
  constructor(path: string) {
    super(
      "credential_read_banned",
      `N10 credential-read ban: refusing to read credential file ${JSON.stringify(path)}. ` +
        `The importer never reads auth/credential files.`,
    )
    this.path = path
  }
}

/** Returns true iff `path`'s basename is a known credential file. */
export const isCredentialPath = (path: string): boolean =>
  BANNED_CREDENTIAL_BASENAMES.has(basename(path))

/** The ONLY byte-reading primitive the migration slice may use. Refuses a
 *  credential file (N10) before any read syscall, then reads UTF-8 text. */
export const readImportFile = async (path: string): Promise<string> => {
  if (isCredentialPath(path)) throw new CredentialReadBannedError(path)
  return readFile(path, "utf8")
}

/** SHA-256 (hex) of a file's raw bytes. Real implementation — used to
 *  fingerprint a session transcript for dedup + change detection. N10: a
 *  credential path is refused before any read. */
export const contentSha256 = async (jsonlPath: string): Promise<string> => {
  if (isCredentialPath(jsonlPath)) throw new CredentialReadBannedError(jsonlPath)
  const bytes = await readFile(jsonlPath)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** SHA-256 (hex) of an in-memory string (UTF-8). Used to fingerprint rule
 *  documents that were already read into memory (avoids a second disk read). */
export const contentSha256OfText = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * ADR-0430 content-hash dedup: has an item with `contentHash` (of `kind`)
 * already been recorded as a successfully-persisted import in `log`? A
 * re-import consults this to skip work already done. Matches only rows that
 * carry the same `itemKind` AND `contentHash` AND `ok === true`.
 */
export const wasAlreadyImported = (
  log: ImportLog,
  kind: "session" | "rule",
  contentHash: string,
): boolean => log.entries.some((e) => e.ok && e.itemKind === kind && e.contentHash === contentHash)
