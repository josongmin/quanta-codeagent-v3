import { randomBytes } from "node:crypto"
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { errMessage } from "@/shared"
import type { CodeActionWorkspaceEdit } from "../../ports/code-action-port"
import type { RenameWorkspaceEdit } from "../../ports/rename-apply-port"
import { applyEditsToText, throwIfAborted } from "./mappers"

/** Filesystem + read seams for {@link applyWorkspaceEditAtomic}. The
 *  {@link LspClient} supplies these from its own `protected` methods so tests
 *  can still capture / fail-inject without touching disk. */
export interface AtomicEditSeams {
  readFileText(filePath: string): Promise<string>
  writeFileText(filePath: string, text: string): Promise<unknown>
  renameFile(from: string, to: string): Promise<void>
  unlinkTmp(filePath: string): Promise<void>
  listDir(dir: string): Promise<string[]>
}

/** Best-effort sweep of `<dir>` for leftover tmps from prior `sessionId`
 *  runs. Pattern: any entry matching `*.quanta-tmp-<sessionId>-*` is
 *  unlinked. Errors per-entry are swallowed (file may already be gone or
 *  owned by another process). */
const cleanupStaleTmps = async (
  seams: AtomicEditSeams,
  dir: string,
  sessionId: string,
): Promise<void> => {
  const entries = await seams.listDir(dir)
  const marker = `.quanta-tmp-${sessionId}-`
  for (const name of entries) {
    // Match the marker anywhere after the original-filename portion. The
    // suffix is always `<original>.quanta-tmp-<sessionId>-<hex>` so we look
    // for the marker substring; presence ⇒ this is our tmp.
    if (!name.includes(marker)) continue
    const full = `${dir}/${basename(name)}`
    await seams.unlinkTmp(full).catch(() => undefined)
  }
}

/** Apply a workspace edit using 2-phase temp+rename atomic commit (ADR-0152,
 *  upgrade of ADR-0143 per-file sequential write).
 *
 *  Phases (per call):
 *    0. **Cleanup** — best-effort scan of each target dir for leftover
 *       `<original>.quanta-tmp-<sessionId>-*` files from prior failed runs;
 *       silently unlinked. Scoped by `sessionId`, so concurrent sessions
 *       don't clobber each other.
 *    1. **Prepare** — for every doc, compute patched text and write to a
 *       sibling tmp file `<original>.quanta-tmp-<sessionId>-<rand>`
 *       (`<rand>` = 4 hex bytes, prevents same-session same-file collisions).
 *       If ANY prepare fails, all already-written tmps are unlinked and the
 *       originating error re-thrown. Originals are NEVER touched in Phase 1.
 *    2. **Commit** — `fs.rename(tmp, target)` per doc. POSIX rename is atomic
 *       on the same filesystem (Linux/macOS); same-FS is the steady-state
 *       assumption (LSP edits hit workspace files which live with their tmps).
 *
 *  Failure model:
 *    - Phase 1 fails ⇒ NO original modified, NO tmp remains.
 *    - Phase 2 fails on file K of N ⇒ files 1..K-1 are committed, file K's
 *      tmp + remaining unrenamed tmps stay on disk under `.quanta-tmp-…`
 *      suffix. Caller can recover via dir scan; we surface a typed error
 *      naming the failed path. Cross-FS rename (EXDEV) is the most likely
 *      Phase 2 cause — that's a follow-up (copy+delete fallback).
 *
 *  Concurrency: the random hex suffix means two parallel calls editing the
 *  same file under the same `sessionId` get distinct tmps; neither clobbers
 *  the other's prepare buffer. Default `sessionId` is per-call random, so
 *  callers that don't pass one are naturally isolated. */
export const applyWorkspaceEditAtomic = async (
  seams: AtomicEditSeams,
  edit: CodeActionWorkspaceEdit | RenameWorkspaceEdit,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal, "LSP applyWorkspaceEdit")
  // Resolve URIs to paths once; reuse across all 3 phases.
  const resolved = edit.changes.map((doc) => ({
    path: fileURLToPath(doc.uri),
    edits: doc.edits,
  }))

  // --- Phase 0 — best-effort cleanup of leftover tmps from prior runs ---
  // Scoped by sessionId so a concurrent session's in-flight tmps survive.
  // Errors here are intentionally swallowed: a stale-tmp scan must NEVER
  // block a legitimate edit (e.g. dir missing → caller will fail in Phase 1
  // with a clearer error than "couldn't list dir for cleanup").
  const cleanupDirs = new Set(resolved.map((d) => dirname(d.path)))
  for (const dir of cleanupDirs) {
    throwIfAborted(signal, "LSP applyWorkspaceEdit")
    await cleanupStaleTmps(seams, dir, sessionId)
  }

  // --- Phase 1 — prepare: write all tmps before touching any original. ---
  const prepared: { tmp: string; target: string }[] = []
  try {
    for (const { path, edits } of resolved) {
      throwIfAborted(signal, "LSP applyWorkspaceEdit")
      const original = await seams.readFileText(path)
      const patched = applyEditsToText(original, edits)
      const tmp = `${path}.quanta-tmp-${sessionId}-${randomBytes(4).toString("hex")}`
      await seams.writeFileText(tmp, patched)
      prepared.push({ tmp, target: path })
    }
  } catch (e) {
    // Phase 1 failure ⇒ unlink every tmp we wrote so far; no original touched.
    for (const { tmp } of prepared) {
      await seams.unlinkTmp(tmp).catch(() => undefined)
    }
    throw e
  }

  // --- Phase 2 — commit: atomic rename per file (same-FS POSIX). ---
  // If rename K fails: files 1..K-1 are committed; K and later tmps remain
  // on disk under `.quanta-tmp-<sessionId>-*`. Caller can scan + recover.
  for (let i = 0; i < prepared.length; i++) {
    const entry = prepared[i]
    if (!entry) continue
    throwIfAborted(signal, "LSP applyWorkspaceEdit")
    try {
      await seams.renameFile(entry.tmp, entry.target)
    } catch (e) {
      const remaining = prepared.length - i
      const err = new Error(
        `LSP applyWorkspaceEdit Phase 2 (commit) failed on "${entry.target}" ` +
          `(${i}/${prepared.length} files renamed, ${remaining} tmp file(s) remain): ${errMessage(
            e,
          )}`,
      )
      throw err
    }
  }
}
