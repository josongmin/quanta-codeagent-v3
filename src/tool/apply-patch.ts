// V4A apply_patch tool wrapper — Slice 4 (Wave C).
//
// Bridges the pure `@/patch` slice (parser + applier + FileSystemPort) to the
// agent's tool surface. Owns:
//
//   1. `FsJailFileSystemPort` — a thin ADAPTER that satisfies `@/patch`'s
//      storage-agnostic `FileSystemPort` by routing every path through
//      `@/storage`'s ONE jail (`resolveJailed` → the same `enforceJail`
//      chokepoint that read/write/edit use). There is no second jail anymore:
//      a sandbox-escape bug now has exactly ONE place to hide. Storage raises
//      a text-only `FsJailError`; this adapter re-types it as the categorical
//      `FsJailViolationError` so the apply pipeline can still tell a "boundary
//      breach" apart from a "patch grammar error" / "anchor not found".
//
//   2. `applyPatchTool` — the `Tool` entry that parses + applies a V4A patch
//      and propagates EVERY named error (PatchParseError /
//      PatchAnchorNotFoundError / PatchApplyError / FsJailViolationError)
//      to the registry without silent catch.
//
// Determinism: the jail boundary check is delegated wholesale to
// `@/storage.resolveJailed` (lexical `..` collapse + `realpath` of the longest
// existing ancestor, defeating symlink escape, + segment-boundary containment;
// honours `QUANTA_FS_JAIL=off`). The adapter adds only the two trivial
// pre-checks storage does not perform — empty path and embedded NUL byte —
// both unambiguous attacks rejected before any resolve. No heuristics, no
// fallback, no graceful skip — every violation throws.

import * as nodeFs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
import { type ApplyResult, applyPatch, type FileSystemPort, parsePatch } from "@/patch"
import { FsJailError, resolveJailed } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "./types"

/**
 * Raised when a `FsJailFileSystemPort` operation resolves to a path outside
 * the jail root. Distinct from `@/storage/FsJailError` so callers can
 * recognise a boundary violation as a category separate from patch grammar
 * errors (`PatchParseError`) and apply failures (`PatchApplyError`,
 * `PatchAnchorNotFoundError`). NEVER swallowed — propagates through the
 * tool generator to the dispatch seam.
 */
export class FsJailViolationError extends Error {
  public readonly attemptedPath: string
  public readonly jailRoot: string
  constructor(attemptedPath: string, jailRoot: string) {
    super(`apply_patch: path '${attemptedPath}' resolves outside the jail root '${jailRoot}'`)
    this.name = "FsJailViolationError"
    this.attemptedPath = attemptedPath
    this.jailRoot = jailRoot
  }
}

/** Minimal `node:fs/promises` surface this port needs. Re-typed locally so
 *  tests can inject an in-memory stand-in without pulling the global typings.
 *  Real call sites pass `node:fs/promises` directly. */
export interface NodeFsLike {
  readFile(p: string, encoding: "utf8"): Promise<string>
  writeFile(p: string, content: string, encoding: "utf8"): Promise<void>
  unlink(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(p: string, options: { recursive: true }): Promise<string | undefined>
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
}

interface PortOptions {
  jailRoot: string
  fs?: NodeFsLike
}

/**
 * ADAPTER that satisfies `@/patch`'s storage-agnostic {@link FileSystemPort}
 * by routing every path through `@/storage`'s ONE jail. There is no second
 * jail implementation here — {@link FsJailFileSystemPort.assertInside}
 * delegates the entire boundary decision to `@/storage.resolveJailed`, which
 * is the SAME `enforceJail` chokepoint the read/write/edit tools use:
 *
 *   - lexical `..` collapse against the jail root,
 *   - `realpath` of the longest existing ancestor (defeats symlink escape,
 *     including the `/tmp/jail-extra` vs `/tmp/jail` sibling-prefix trap, via
 *     segment-boundary containment),
 *   - `QUANTA_FS_JAIL=off` opt-out, read once at startup.
 *
 * The adapter adds only the two trivial pre-checks storage does not do — empty
 * path and embedded NUL byte — and re-types storage's text-only
 * {@link FsJailError} as the categorical {@link FsJailViolationError} so the
 * apply pipeline keeps its "boundary breach" vs "grammar / anchor" distinction.
 *
 * Symlink TOCTOU is defeated the same way storage does it: every I/O method
 * re-resolves through `resolveJailed` immediately before the syscall, so a
 * swap between check and use forces another `realpath`.
 */
export class FsJailFileSystemPort implements FileSystemPort {
  private readonly jailRoot: string
  private readonly fs: NodeFsLike

  constructor(opts: PortOptions) {
    if (typeof opts.jailRoot !== "string" || opts.jailRoot.length === 0) {
      throw new Error("FsJailFileSystemPort requires a non-empty jailRoot")
    }
    if (!path.isAbsolute(opts.jailRoot)) {
      throw new Error(`FsJailFileSystemPort requires an absolute jailRoot, got '${opts.jailRoot}'`)
    }
    this.jailRoot = opts.jailRoot
    this.fs = opts.fs ?? (nodeFs as unknown as NodeFsLike)
  }

  /** Resolve `target` against the jail root and verify it stays inside, by
   *  delegating to the single `@/storage` jail. Throws
   *  {@link FsJailViolationError} on any violation (re-typed from storage's
   *  {@link FsJailError}). Returns the resolved absolute path for the I/O call. */
  private assertInside(target: string): string {
    // Trivial rejects storage does not cover — never resolved, unambiguous
    // attacks. (`resolveJailed("", root)` would otherwise resolve to the root
    // itself, and a NUL byte must never reach a syscall.)
    if (typeof target !== "string" || target.length === 0) {
      throw new FsJailViolationError(String(target), this.jailRoot)
    }
    if (target.includes("\0")) {
      throw new FsJailViolationError(target, this.jailRoot)
    }
    // The ONE jail. resolveJailed throws FsJailError on escape; re-type it as
    // the categorical FsJailViolationError, leaving any other error to surface.
    try {
      return resolveJailed(target, this.jailRoot)
    } catch (e) {
      if (e instanceof FsJailError) {
        throw new FsJailViolationError(target, this.jailRoot)
      }
      throw e
    }
  }

  async readFile(p: string): Promise<string> {
    const resolved = this.assertInside(p)
    return this.fs.readFile(resolved, "utf8")
  }

  async writeFile(p: string, content: string): Promise<void> {
    const resolved = this.assertInside(p)
    // The parent of an in-jail path is in-jail by construction; mkdir it.
    await this.fs.mkdir(path.dirname(resolved), { recursive: true })
    await this.fs.writeFile(resolved, content, "utf8")
  }

  async deleteFile(p: string): Promise<void> {
    const resolved = this.assertInside(p)
    await this.fs.unlink(resolved)
  }

  async renameFile(from: string, to: string): Promise<void> {
    const resolvedFrom = this.assertInside(from)
    const resolvedTo = this.assertInside(to)
    await this.fs.mkdir(path.dirname(resolvedTo), { recursive: true })
    await this.fs.rename(resolvedFrom, resolvedTo)
  }

  async exists(p: string): Promise<boolean> {
    const resolved = this.assertInside(p)
    try {
      await this.fs.stat(resolved)
      return true
    } catch {
      return false
    }
  }
}

const schema = z.object({
  patch: z
    .string()
    .describe("V4A patch text. Must begin with '*** Begin Patch' and end with '*** End Patch'."),
})

type Input = z.infer<typeof schema>

/**
 * Format an `ApplyResult` into a deterministic single-string summary the
 * dispatch seam surfaces back to the model. The order is stable:
 * added → updated → moved → deleted. Empty categories are omitted.
 */
function formatApplyResult(r: ApplyResult): string {
  const parts: string[] = []
  if (r.filesAdded.length > 0) parts.push(`added: ${r.filesAdded.join(", ")}`)
  if (r.filesUpdated.length > 0) parts.push(`updated: ${r.filesUpdated.join(", ")}`)
  if (r.filesMoved.length > 0) {
    parts.push(`moved: ${r.filesMoved.map(([from, to]) => `${from} -> ${to}`).join(", ")}`)
  }
  if (r.filesDeleted.length > 0) parts.push(`deleted: ${r.filesDeleted.join(", ")}`)
  return parts.length === 0 ? "apply_patch: no-op patch" : parts.join("; ")
}

export const applyPatchTool: Tool<Input> = {
  name: "apply_patch",
  description:
    "Apply a Codex V4A patch (Add/Update/Delete/Move) atomically against the session cwd. Every op is pre-flighted; a single failure aborts the whole patch.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Patch application mutates the filesystem; serialize with every other
  // mutating call. Concurrency-unsafe by definition.
  isConcurrencySafe: () => false,
  // HITL secure-by-default: a V4A patch is a multi-file workspace mutation
  // — pre-approval covers it (same posture as `write`/`edit`/`scripted_replace`).
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // parsePatch throws PatchParseError on grammar violation — propagate.
    // applyPatch throws PatchApplyError / PatchAnchorNotFoundError on apply
    // failure — propagate. FsJailFileSystemPort throws FsJailViolationError
    // on boundary breach — propagate. NO silent catch, NO graceful skip;
    // the dispatch seam decides how to surface the failure.
    const patch = parsePatch(input.patch)
    const port = new FsJailFileSystemPort({ jailRoot: ctx.cwd })
    const result = await applyPatch(patch, port)
    yield {
      type: "result",
      result: { ok: true, output: formatApplyResult(result) },
    }
  },
}
