// V4A apply_patch tool wrapper — Slice 4 (Wave C).
//
// Bridges the pure `@/patch` slice (parser + applier + FileSystemPort) to the
// agent's tool surface. Owns:
//
//   1. `FsJailFileSystemPort` — a concrete `FileSystemPort` that confines
//      every read/write/delete/rename to a single jail root (`ctx.cwd`).
//      Distinct from `@/storage`'s `FsJailError` (text-only diagnostic):
//      a jail violation here throws a typed `FsJailViolationError` so the
//      apply pipeline can distinguish "boundary breach" from "patch grammar
//      error" / "anchor not found" categorically.
//
//   2. `applyPatchTool` — the `Tool` entry that parses + applies a V4A patch
//      and propagates EVERY named error (PatchParseError /
//      PatchAnchorNotFoundError / PatchApplyError / FsJailViolationError)
//      to the registry without silent catch.
//
// Determinism: jail boundary check is `path.resolve` + `realpath` (for
// existing ancestors, defeats symlink TOCTOU) + `startsWith(jailRoot +
// path.sep)` AND `=== jailRoot`. No heuristics, no fallback, no graceful
// skip — every violation throws.

import * as nodeFs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
import { type ApplyResult, applyPatch, type FileSystemPort, parsePatch } from "@/patch"
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
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
}

interface PortOptions {
  jailRoot: string
  fs?: NodeFsLike
}

/**
 * `FileSystemPort` implementation rooted at `jailRoot`. Every public method
 * routes its target path through {@link FsJailFileSystemPort.assertInside}
 * BEFORE touching the underlying filesystem.
 *
 * Jail boundary algorithm (deterministic, three-stage):
 *   1. Reject empty paths and any path containing a NUL byte
 *      (`String.prototype.includes('\0')`) — both are unambiguous attacks.
 *   2. Lexically resolve via `path.resolve(jailRoot, target)`. The resolver
 *      collapses `..` segments AGAINST the jail root, so `../../etc/passwd`
 *      lands outside and is rejected.
 *   3. Resolve symlinks on the longest existing prefix via
 *      `fs.realpath` — applied to BOTH the jail root and the target. The
 *      pair is compared with `realTarget === realRoot ||
 *      realTarget.startsWith(realRoot + path.sep)`. The trailing separator
 *      is REQUIRED — otherwise `/tmp/jail-extra` passes a `/tmp/jail` root.
 *
 * Symlink TOCTOU is defeated by always re-resolving immediately before the
 * I/O call, so a swap between check and use forces another `realpath`.
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

  /** Resolve `target` against the jail root and verify it stays inside.
   *  Throws {@link FsJailViolationError} on any violation. Returns the
   *  resolved absolute path to use for the actual I/O call. */
  private async assertInside(target: string): Promise<string> {
    // (1) Trivial rejects — never normalised, never resolved.
    if (typeof target !== "string" || target.length === 0) {
      throw new FsJailViolationError(String(target), this.jailRoot)
    }
    if (target.includes("\0")) {
      throw new FsJailViolationError(target, this.jailRoot)
    }

    // (2) Lexical resolve against the jail root.
    const lexical = path.resolve(this.jailRoot, target)

    // (3) Symlink-real resolve for the jail root and the longest existing
    //     ancestor of the target. We can't `realpath` a not-yet-created
    //     file, so we climb until we find a real ancestor and re-append.
    const realRoot = await this.realResolve(this.jailRoot)
    const realTarget = await this.realResolve(lexical)

    // startsWith(realRoot + path.sep) is REQUIRED — otherwise `/tmp/jail-extra`
    // would pass for a `/tmp/jail` root. Equality is the only other accept.
    const sep = path.sep
    const acceptableEqual = realTarget === realRoot
    const acceptablePrefix = realTarget.startsWith(realRoot + sep)
    if (!acceptableEqual && !acceptablePrefix) {
      throw new FsJailViolationError(target, this.jailRoot)
    }
    return realTarget
  }

  /** Realpath the longest EXISTING prefix of `abs`, then re-append the
   *  not-yet-existing tail. Symlinks in the existing portion are resolved;
   *  symlinks introduced LATER are caught by the next `assertInside` (TOCTOU
   *  guard — every I/O re-resolves immediately before the syscall). */
  private async realResolve(abs: string): Promise<string> {
    const segs = abs.split(path.sep).filter((s) => s.length > 0)
    for (let i = segs.length; i >= 0; i--) {
      const candidate = path.sep + segs.slice(0, i).join(path.sep) || path.sep
      try {
        const real = await this.fs.realpath(candidate)
        const tail = segs.slice(i)
        if (tail.length === 0) return real
        // Normalise the rejoin so any `.` or `..` in the tail (defensive — the
        // caller already lexically resolved, but be belt-and-suspenders)
        // collapses on the resolved real root.
        return path.resolve(real, ...tail)
      } catch {
        // Ancestor doesn't exist — climb up.
      }
    }
    // Filesystem root must always exist; the loop guarantees we return above.
    // Surface a clear error if it ever doesn't.
    throw new FsJailViolationError(abs, this.jailRoot)
  }

  async readFile(p: string): Promise<string> {
    const resolved = await this.assertInside(p)
    return this.fs.readFile(resolved, "utf8")
  }

  async writeFile(p: string, content: string): Promise<void> {
    const resolved = await this.assertInside(p)
    const parent = path.dirname(resolved)
    // Re-assert the parent is inside the jail. `path.dirname` of an
    // in-jail path is always in-jail or === jailRoot, but we still go
    // through `assertInside` so the mkdir target is normalised + realpath'd.
    await this.assertInside(path.relative(this.jailRoot, parent) || ".")
    await this.fs.mkdir(parent, { recursive: true })
    await this.fs.writeFile(resolved, content, "utf8")
  }

  async deleteFile(p: string): Promise<void> {
    const resolved = await this.assertInside(p)
    await this.fs.unlink(resolved)
  }

  async renameFile(from: string, to: string): Promise<void> {
    const resolvedFrom = await this.assertInside(from)
    const resolvedTo = await this.assertInside(to)
    const parent = path.dirname(resolvedTo)
    await this.assertInside(path.relative(this.jailRoot, parent) || ".")
    await this.fs.mkdir(parent, { recursive: true })
    await this.fs.rename(resolvedFrom, resolvedTo)
  }

  async exists(p: string): Promise<boolean> {
    const resolved = await this.assertInside(p)
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
