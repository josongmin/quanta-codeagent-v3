/**
 * Filesystem adapter for session import/export (ADR-0157).
 *
 * Thin wrappers around `Bun.file().text()` and `Bun.write` that compose the
 * pure `import-export` module with disk I/O. Kept SEPARATE so the core
 * module (`./import-export`) stays free of `node:fs` — important for callers
 * that round-trip in memory (CI replay buffers, IPC marshaling, browser
 * test rigs that don't have a real filesystem).
 *
 * The "port + adapter" split: `import-export.ts` is the port (pure
 * serialization), this file is the FS adapter. A future S3 adapter or
 * HTTP-upload adapter would land as a sibling file with the same shape.
 *
 * Default-OFF: nothing in the loop calls these. A future `/session export`
 * slash command or CI replay harness will be the first consumer.
 *
 * Plane-clean: imports `./import-export` (sibling), `./types`, and Bun's
 * built-in `Bun.file`/`Bun.write` globals. We use Bun's APIs rather than
 * `node:fs/promises` to match the rest of the storage slice (and to get
 * automatic parent-dir creation on `Bun.write`).
 */

import { errMessage } from "@/shared"
import {
  exportSessionToJson,
  importSessionFromJson,
  type SessionExportOpts,
  SessionImportError,
  type SessionImportOpts,
  type SessionImportResult,
} from "./import-export"
import type { SavedSession } from "./types"
/** Export `session` and write the JSON envelope to `filePath`. Parent
 *  directories are created by Bun.write automatically. Throws on disk I/O
 *  failure (EACCES, ENOSPC, etc.) — the caller is expected to be running in
 *  an interactive surface that surfaces the error. */
export const exportSessionToFile = async (
  session: SavedSession,
  opts: SessionExportOpts,
  filePath: string,
): Promise<void> => {
  const json = exportSessionToJson(session, opts)
  await Bun.write(filePath, json)
}

/** Read a JSON envelope from `filePath` and import it. Missing files throw
 *  `SessionImportError("malformed", ...)` so the caller has a single error
 *  type to catch regardless of where the failure originated (FS vs. shape
 *  vs. version). */
export const importSessionFromFile = async (
  filePath: string,
  opts: SessionImportOpts,
): Promise<SessionImportResult> => {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new SessionImportError("malformed", `session envelope file does not exist: ${filePath}`)
  }
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    throw new SessionImportError(
      "malformed",
      `session envelope file read failed (${filePath}): ${errMessage(e)}`,
    )
  }
  return importSessionFromJson(text, opts)
}
