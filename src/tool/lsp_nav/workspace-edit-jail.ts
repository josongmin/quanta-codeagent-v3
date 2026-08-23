/** FS-jail containment for LSP **workspace edits** (aug-23 security fix).
 *
 *  WHY THIS LIVES IN `@/tool` AND NOT IN THE WRITER.
 *  The `@/lsp` writer (`adapters/base/atomic-edit.ts`) resolves each document
 *  with a bare `fileURLToPath(doc.uri)` and writes/renames it — there is NO
 *  containment check anywhere in that slice (`grep -rn "jail" src/lsp` → 0
 *  hits), and there cannot be one: `resolveJailed` lives in `@/storage`, which
 *  the `src/lsp` slice is forbidden to import (biome `noRestrictedImports`:
 *  "@/lsp depends on @/shared only", independently enforced by
 *  `tools/slice-graph/validate.ts`). The tool slice, by contrast, already owns
 *  the jail (`rename-apply.ts` / `code-action.ts` both import `resolveJailed`),
 *  so the guard belongs on the CALLER side of the port.
 *
 *  WHAT IT DEFENDS. The tools jail only the ANCHOR path the model supplied.
 *  Every URI in the returned workspace edit is chosen by the LANGUAGE SERVER,
 *  and the server's view of the workspace comes from repo-owned configuration
 *  (tsconfig `include` / `paths` / project references, rust-analyzer
 *  `linkedProjects`, …). This repo already treats repo content as UNTRUSTED
 *  (`src/agent/run-mode/repo-rules-policy.ts`), so a hostile checkout can steer
 *  an otherwise-honest server at files outside the workspace.
 *
 *  ALL-OR-NOTHING. A violation rejects the WHOLE edit. Filtering the offending
 *  documents and applying the rest would land a half-renamed symbol — i.e. it
 *  would break the source it was asked to refactor.
 *
 *  Plane-clean: `node:url` + `@/storage` only. No `@/lsp`, no `@/agent`. */

import { fileURLToPath } from "node:url"
import { errMessage, logger } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"

/** Structural minimum of every LSP workspace-edit mirror in this slice
 *  (`RenameApplyPortWorkspaceEdit`, `CodeActionPortWorkspaceEdit`, and the
 *  canonical `@/lsp` ports they mirror). Only `uri` is load-bearing here. */
export interface JailableDocumentEdit {
  readonly uri: string
}

export interface JailableWorkspaceEdit {
  readonly changes: readonly JailableDocumentEdit[]
}

export type WorkspaceEditJailVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly string[]; readonly message: string }

/** Decode a document URI to a filesystem path, or `null` when it is not a
 *  `file:` URI. A non-`file:` URI (`untitled:`, `vscode-vfs:`, a malformed
 *  one) has NO filesystem identity we can contain, so it is fail-closed —
 *  treated as a violation by {@link checkWorkspaceEditJail}. */
const editTargetPath = (uri: string): string | null => {
  try {
    return fileURLToPath(uri)
  } catch (e) {
    // Bound + attributed rather than bare: this is a REFUSAL path (the caller
    // treats `null` as a jail violation), so an operator debugging "why was my
    // rename refused" needs the URI and the decode error, not silence.
    logger.warn(`lsp.workspaceEditJail: undecodable edit target ${uri}: ${errMessage(e)}`)
    return null
  }
}

/**
 * Verify that EVERY document targeted by `edit` resolves inside `jailRoot`
 * (the tool's `ctx.cwd`). Returns the offending targets rather than throwing so
 * a tool can surface its own typed `ok:false` failure.
 *
 * Honours `QUANTA_FS_JAIL=off` exactly as every other jail site does — the
 * containment decision is delegated to `resolveJailed`, which is the single
 * chokepoint (symlink-aware, dangling-symlink-aware).
 */
export const checkWorkspaceEditJail = (
  edit: JailableWorkspaceEdit,
  jailRoot: string,
  toolName: string,
): WorkspaceEditJailVerdict => {
  const violations: string[] = []
  for (const doc of edit.changes) {
    const target = editTargetPath(doc.uri)
    if (target === null) {
      violations.push(doc.uri)
      continue
    }
    try {
      resolveJailed(target, jailRoot)
    } catch (e) {
      if (e instanceof FsJailError) {
        violations.push(target)
        continue
      }
      throw e
    }
  }
  if (violations.length === 0) return { ok: true }
  return {
    ok: false,
    violations,
    message:
      `${toolName}: refusing to apply the language server's workspace edit — ` +
      `${violations.length} of ${edit.changes.length} target(s) resolve OUTSIDE the ` +
      `working-directory jail (${jailRoot}): ${violations.join(", ")}. ` +
      "All-or-nothing: NO file was modified (a partially applied edit would corrupt " +
      "the source). Set QUANTA_FS_JAIL=off to allow cross-directory edits.",
  }
}

/** Throwing form of {@link checkWorkspaceEditJail} for `Promise<void>` port
 *  seams (the assembled `CodeActionPort.applyEdit` in `@/agent/lsp-bridge`)
 *  that have no typed-failure channel. Raises the same `FsJailError` the rest
 *  of the FS jail raises, so existing catch sites classify it identically. */
export const assertWorkspaceEditJailed = (
  edit: JailableWorkspaceEdit,
  jailRoot: string,
  toolName: string,
): void => {
  const verdict = checkWorkspaceEditJail(edit, jailRoot, toolName)
  if (verdict.ok) return
  const first = verdict.violations[0]
  throw new FsJailError(verdict.message, {
    root: jailRoot,
    ...(first === undefined ? {} : { target: first }),
  })
}
