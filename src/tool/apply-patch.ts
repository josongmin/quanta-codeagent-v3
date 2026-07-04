// V4A apply_patch tool wrapper — Slice 4 (Wave C).
//
// Bridges the pure `@/patch` slice (parser + applier + PatchFileSystemPort) to
// the agent's tool surface. Owns:
//
//   1. `FsJailFileSystemPort` — a thin ADAPTER that satisfies `@/patch`'s
//      storage-agnostic `PatchFileSystemPort` by routing every path through
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

import { randomBytes } from "node:crypto"
import * as nodeFs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
// Documented cross-slice carve-out (mirror of `coverage_check`'s
// `@/observability/coverage` exception): the V4A applier is a pure `@/patch`
// leaf that takes an injected `PatchTracePort` (closed-port DI). This tool is
// the composition root for `apply_patch`, so it wires the production OTel-bound
// adapter here — the SINGLE runtime point the `quanta.patch.*` vocabulary is
// bound. `@/patch` itself imports NOTHING from `@/observability`.
import { otelPatchTracePort } from "@/observability/patch-trace"
import {
  type ApplyResult,
  applyPatch,
  isUnifiedDiff,
  type Patch,
  type PatchFileSystemPort,
  parsePatch,
  unifiedDiffToV4A,
  // biome-ignore lint/style/noRestrictedImports: @/patch is reachable by @/tool/apply-patch per the documented ADR slice carve-out.
} from "@/patch"
import { errMessage } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import { classifyFastApplyError, failingTargetPath } from "./apply-patch-fallback-wire"
import { guardWrite } from "./stale-read-guard"
import type {
  EditToolContext,
  FastApplyFallbackSeam,
  GitWriteGuard,
  Tool,
  ToolEvent,
} from "./types"

/** Process-wide OTel-bound patch tracing port, injected into every `applyPatch`
 *  call from this tool. Stateless + Default-OFF (a zero-allocation no-op when no
 *  span sink is registered), so a single shared instance is sufficient. */
const PATCH_TRACE = otelPatchTracePort()

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
  stat(p: string): Promise<{
    isFile(): boolean
    isDirectory(): boolean
    mode?: number
    /** OPTIONAL on-disk modification time in epoch milliseconds. PRESENT on the
     *  real `node:fs/promises` (`Stats.mtimeMs`); the ADR-0474 stale-read-guard
     *  parity (see {@link FsJailFileSystemPort.statTarget}) reads it to compare
     *  against the recorded read-time mtime. ABSENT on an in-memory test fake ⇒
     *  the guard treats the target as un-stat-able (see `statTarget`), which only
     *  matters when `ctx.readFileState` is wired — the default-OFF path never
     *  reaches it, so a fake without `mtimeMs` is byte-identical to today. */
    mtimeMs?: number
  }>
  /** OPTIONAL durability barrier. When present (real `node:fs/promises`) the
   *  atomic write `fsync`s the temp BYTES before the rename so a crash in the
   *  window between write and rename cannot promote a torn / zero-length temp
   *  under the final name. ABSENT on an in-memory test fake ⇒ the atomic write
   *  DEGRADES GRACEFULLY (temp + rename still hold; only the on-disk durability
   *  flush is skipped, which a fake has no concept of anyway). Best-effort: a
   *  rejection is swallowed (some platforms reject an fsync on the handle). */
  fsync?(p: string): Promise<void>
  /** OPTIONAL mode setter. When present (real `node:fs/promises`) the atomic
   *  write re-applies the ORIGINAL file's permission bits to the temp BEFORE the
   *  rename, so editing an existing `0o755` script does not silently drop it to
   *  `0o644` (a fresh temp inode is created with default perms). ABSENT on an
   *  in-memory fake ⇒ skipped (a fake has no mode concept); best-effort — a
   *  rejection is swallowed. */
  chmod?(p: string, mode: number): Promise<void>
}

interface PortOptions {
  jailRoot: string
  fs?: NodeFsLike
}

/** Real `node:fs/promises`-backed {@link NodeFsLike}. `node:fs/promises` has no
 *  path-form `fsync` (it requires a file handle), so we supply one that opens
 *  the temp `r+`, `sync()`s, and closes — the SAME durability barrier
 *  `@/storage/atomic-write.ts`'s `defaultAtomicWriteSync.syncFile` uses. The
 *  rest of the surface forwards straight to `node:fs/promises`. Built ONCE and
 *  shared; the production port uses this when no `fs` is injected so the atomic
 *  write gets a real flush, while an in-memory test fake (no `fsync`) degrades
 *  gracefully. */
const defaultNodeFs: NodeFsLike = {
  readFile: (p, encoding) => nodeFs.readFile(p, encoding),
  writeFile: (p, content, encoding) => nodeFs.writeFile(p, content, encoding),
  unlink: (p) => nodeFs.unlink(p),
  rename: (from, to) => nodeFs.rename(from, to),
  mkdir: (p, options) => nodeFs.mkdir(p, options),
  stat: (p) => nodeFs.stat(p),
  chmod: (p, mode) => nodeFs.chmod(p, mode),
  fsync: async (p) => {
    // Open r+ and flush bytes to stable storage; best-effort close. Mirrors
    // `defaultAtomicWriteSync.syncFile` in `@/storage/atomic-write.ts`.
    const handle = await nodeFs.open(p, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

/**
 * ADAPTER that satisfies `@/patch`'s storage-agnostic {@link PatchFileSystemPort}
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
export class FsJailFileSystemPort implements PatchFileSystemPort {
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
    this.fs = opts.fs ?? defaultNodeFs
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
    // [F4] ATOMIC single-file write — temp + rename (SOTA++, mirrors
    // `@/storage/atomic-write.ts` and Codex/CC). A plain `writeFile(resolved)`
    // truncates-then-writes the FINAL path: a crash/throw mid-write tears the
    // committed file (a reader — or a later op in the SAME patch — observes a
    // zero-length / partial file). Instead:
    //   1. write `content` to a unique sibling `<resolved>.quanta-tmp-<hex>`
    //      (8 crypto-random bytes keep concurrent writes non-colliding),
    //   2. `fsync` the temp BYTES when the injected fs offers it (the real
    //      port does; an in-memory fake omits it ⇒ graceful degrade — best-
    //      effort, a flush rejection is swallowed),
    //   3. `rename(temp, resolved)` — POSIX-atomic on the same filesystem.
    // The FINAL path is NEVER touched until the atomic rename, so a failure
    // before/at the rename leaves the original byte-identical. On a rename
    // failure we best-effort `unlink` the temp and rethrow the ORIGINAL error.
    // [F4 follow-up] PRESERVE the original file's permission bits across the
    // temp+rename. A fresh temp inode is created with default perms, so without
    // this an existing `0o755` script silently drops to `0o644` on edit (a real
    // regression the pre-atomic direct write did NOT have). A brand-new file has
    // no original ⇒ perms stay default (byte-identical to the pre-atomic write).
    let originalMode: number | undefined
    try {
      const st = await this.fs.stat(resolved)
      originalMode = typeof st.mode === "number" ? st.mode : undefined
    } catch {
      // No existing file (ENOENT) ⇒ nothing to preserve; keep default perms.
    }
    const temp = `${resolved}.quanta-tmp-${randomBytes(8).toString("hex")}`
    try {
      await this.fs.writeFile(temp, content, "utf8")
      // Durability barrier — flush temp bytes before promoting. Best-effort:
      // absent on a fake (degrade), and a real-port rejection is swallowed
      // (some platforms reject an fsync on the handle; the rename still wins).
      if (this.fs.fsync !== undefined) {
        await this.fs.fsync(temp).catch(() => undefined)
      }
      // Carry the original mode onto the temp BEFORE the rename so the promoted
      // file lands with the right perms atomically (best-effort: a fake without
      // `chmod`, or a platform that rejects it, degrades to default perms).
      if (originalMode !== undefined && this.fs.chmod !== undefined) {
        await this.fs.chmod(temp, originalMode).catch(() => undefined)
      }
    } catch (e) {
      // Temp write/flush failed BEFORE any rename ⇒ the original is untouched.
      // Clean up the partial temp (swallow ENOENT) and rethrow the real error.
      await this.fs.unlink(temp).catch(() => undefined)
      throw e
    }
    try {
      await this.fs.rename(temp, resolved)
    } catch (e) {
      // Atomic commit failed ⇒ the original at `resolved` was never touched
      // (rename is the only step that does). Remove the orphaned temp and
      // rethrow so the apply pipeline surfaces the failure unchanged.
      await this.fs.unlink(temp).catch(() => undefined)
      throw e
    }
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

  /**
   * ADR-0474 stale-read-guard parity — resolve `p` through the ONE jail
   * ({@link assertInside}, the SAME chokepoint every other I/O method uses — NO
   * second jail) and `stat` it via the SAME `this.fs.stat` primitive `exists`
   * already calls, returning the resolved absolute path + its on-disk mtime.
   *
   * `{ exists: false }` when the target is absent (ENOENT ⇒ `stat` rejects): a
   * file that is not there cannot be "stale relative to a prior read", so the
   * caller treats it as not-stale (the missing-file case surfaces later as the
   * applier's own typed error, unchanged). The `resolvedPath` is returned even
   * on success so the caller can call `guardWrite` against the SAME canonical
   * absolute path the `read` tool recorded (byte-for-byte path identity — the
   * stale-read-guard compares paths verbatim, never normalising). Throws
   * {@link FsJailViolationError} on a boundary breach (re-typed by
   * `assertInside`) — a stale check must never resolve outside the jail.
   */
  async statTarget(
    p: string,
  ): Promise<{ exists: true; resolvedPath: string; mtimeMs: number } | { exists: false }> {
    const resolved = this.assertInside(p)
    let st: Awaited<ReturnType<NodeFsLike["stat"]>>
    try {
      st = await this.fs.stat(resolved)
    } catch {
      // ENOENT / unreadable ⇒ no on-disk baseline to compare; not stale.
      return { exists: false }
    }
    // A fake `stat` that omits `mtimeMs` (in-memory test port) has no on-disk
    // baseline either ⇒ treat as not-stale (this path is reached ONLY when the
    // host wired `ctx.readFileState`; the default-OFF apply never gets here).
    if (typeof st.mtimeMs !== "number") return { exists: false }
    return { exists: true, resolvedPath: resolved, mtimeMs: st.mtimeMs }
  }
}

const schema = z.object({
  patch: z
    .string()
    .describe("V4A patch text. Must begin with '*** Begin Patch' and end with '*** End Patch'."),
})

type Input = z.infer<typeof schema>

/**
 * ADR-0091 git-write-protection for `apply_patch`. A V4A patch is a multi-file
 * workspace mutation, so EVERY target path the patch would create / overwrite /
 * delete / move-to is a potential code-execution / policy-escape vector exactly
 * as for `write`/`edit`/`scripted_replace`. The parser yields a typed op union;
 * we scan its targets:
 *
 *   - `add`    → `op.path`              (file created — `*** Add File:`)
 *   - `delete` → `op.path`              (file removed — `*** Delete File:`)
 *   - `update` → `op.path` (+ `moveTo`) (file edited — `*** Update File:`,
 *                                         and the rename DESTINATION when
 *                                         `*** Move to:` is present)
 *
 * The `moveTo` destination MUST be guarded independently: a patch could update
 * a benign file and rename it ONTO `.git/hooks/pre-commit`. Returns the FIRST
 * guarded target's denial `ToolEvent` (deterministic — ops in patch order),
 * mirroring `gitWriteGuardDeny`'s single source of truth so the model-facing
 * `output` and typed `permission_denied` failure are byte-identical to the
 * write/edit/scripted_replace path. Returns `null` when the guard is unwired
 * (DEFAULT-OFF) or no target is an escape vector — the apply proceeds normally.
 */
function guardPatchTargets(patch: Patch, guard: GitWriteGuard | undefined): ToolEvent | null {
  if (guard === undefined) return null
  for (const op of patch.ops) {
    const targets =
      op.kind === "update" && op.moveTo !== undefined ? [op.path, op.moveTo] : [op.path]
    for (const target of targets) {
      const reason = guard(target)
      if (reason != null) {
        return {
          type: "result",
          result: {
            ok: false,
            output: `git-escape-vector denial: cannot apply_patch to ${target} (${reason}); use a different path`,
            failure: { mode: "permission_denied", path: target },
          },
        }
      }
    }
  }
  return null
}

/**
 * ADR-0474 stale-read-guard parity for `apply_patch` — mirrors `edit`'s
 * `editPreCommitDeny` (`src/tool/edit/index.ts`). `edit` blocks a write whose
 * target was externally modified since the model last read it; `apply_patch` had
 * NO such TOCTOU guard, so a V4A patch landed on bytes that drifted since the
 * read (or only the anchor broke). This closes that gap by consulting the SAME
 * `guardWrite(ctx.readFileState, path, mtimeMs)` the edit tool uses.
 *
 * Scope (which ops are staleness-checked) mirrors edit's "read-before-write" on
 * an EXISTING target:
 *
 *   - `update` → `op.path` (the file being edited; also the rename SOURCE when
 *                `moveTo` is present — the SOURCE is the file the model read).
 *   - `delete` → `op.path` (the file being removed — the model read it to
 *                decide it was obsolete).
 *
 * NOT checked (no prior-read baseline exists / target must not yet exist):
 *   - `add`     → `op.path`   (a brand-new file has no read-time baseline; the
 *                              guard's `unread ⇒ allow` posture covers it).
 *   - `update`'s `moveTo` DESTINATION (a move destination must NOT exist; it has
 *                              no read-time baseline either).
 *
 * HARD-STOP / no partial apply: the FIRST stale target (ops scanned in patch
 * order — deterministic) returns the typed `rejected` / `stale_read` ToolEvent
 * and the caller NEVER reaches `applyPatch`, so ZERO files are written. The
 * model-facing `output` is the verbatim `StaleReadError.message` (the same
 * "re-read first" guidance `edit` surfaces), and the typed failure shape
 * (`{ mode: "rejected", reason: "stale_read" }`) is byte-identical to `edit`'s.
 *
 * DEFAULT-OFF / byte-identical: returns `null` immediately when
 * `ctx.readFileState` is undefined (the host did not opt into the guard — see
 * `staleReadGuardEnabled`), so the apply path is byte-identical to today.
 * Path identity: `statTarget` resolves through the ONE jail and returns the
 * canonical absolute path, and `guardWrite` is called against THAT — the same
 * absolute path the `read` tool records, so the byte-for-byte comparison agrees.
 */
async function guardStaleTargets(
  patch: Patch,
  port: FsJailFileSystemPort,
  ctx: EditToolContext | undefined,
): Promise<ToolEvent | null> {
  const state = ctx?.readFileState
  if (state === undefined) return null
  for (const op of patch.ops) {
    if (op.kind !== "update" && op.kind !== "delete") continue
    const stat = await port.statTarget(op.path)
    // Absent on disk (or no mtime baseline) ⇒ no prior-read staleness to assert;
    // the applier surfaces its own typed error for a missing update/delete target.
    if (!stat.exists) continue
    const guard = guardWrite(state, stat.resolvedPath, stat.mtimeMs)
    if (!guard.ok) {
      return {
        type: "result",
        result: {
          ok: false,
          output: guard.error.message,
          failure: { mode: "rejected", reason: "stale_read" },
        },
      }
    }
  }
  return null
}

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

/**
 * Parse + git-write-guard + apply a V4A patch text against the port. THROWS the
 * canonical typed errors (`PatchParseError` / `PatchApplyError` /
 * `PatchAnchorNotFoundError` / `FsJailViolationError`) on failure — exactly the
 * pre-ADR-0421 contract. NO silent catch, NO graceful skip.
 *
 * Returns `{ guardDeny }` (a terminal `permission_denied` ToolEvent) when ANY
 * target path is an ADR-0091 git-escape vector — surfaced verbatim by the
 * caller, NEVER applied (hard-stop BEFORE `applyPatch`, never a partial mutate).
 * Otherwise returns `{ result }`. This is the SINGLE chokepoint shared by the
 * primary patch and the fast-apply fallback re-emit — both are guarded, so a
 * model cannot re-emit a patch that targets `.git/hooks/**` to slip past.
 *
 * OTel emission (ADR-0028 `quanta.patch.op` + `quanta.patch.fuzzy_match_tier`)
 * is wired by INJECTING `PATCH_TRACE` (the OTel-bound `PatchTracePort` adapter
 * from `@/observability/patch-trace`) into `applyPatch`. The pure `@/patch`
 * slice imports NOTHING from `@/observability`; this tool is the composition
 * root that binds the vocabulary. The port is a Default-OFF no-op when no span
 * sink is active, so emission is byte-identical to the prior self-wired path.
 */
async function guardedParseAndApply(
  patchText: string,
  port: FsJailFileSystemPort,
  guard: GitWriteGuard | undefined,
  ctx?: EditToolContext,
): Promise<{ deny: ToolEvent } | { result: ApplyResult }> {
  // Auto-convert standard unified diff (--- a/file / +++ b/file format) to V4A.
  // Models frequently produce unified diff; without this, parsePatch throws on a
  // structurally-valid patch that simply uses the wrong sentinel format.
  const normalizedPatch = isUnifiedDiff(patchText) ? unifiedDiffToV4A(patchText) : patchText
  const patch = parsePatch(normalizedPatch)
  // Guard EVERY target BEFORE any filesystem mutation (hard-stop posture).
  const guardDeny = guardPatchTargets(patch, guard)
  if (guardDeny) return { deny: guardDeny }
  // ADR-0474 stale-read-guard parity — block the patch if ANY existing target
  // drifted since the model last read it, BEFORE any write (hard-stop, no partial
  // apply). Default-OFF: `null` when `ctx.readFileState` is unwired ⇒ the apply
  // path below is byte-identical to today. This runs AFTER the git-guard and
  // BEFORE the critical-section commit — both pre-flight denies precede any FS
  // mutation, so a denied patch is NEVER a partial write.
  const staleDeny = await guardStaleTargets(patch, port, ctx)
  if (staleDeny) return { deny: staleDeny }
  // applyPatch throws PatchApplyError / PatchAnchorNotFoundError on apply
  // failure — propagate. FsJailFileSystemPort throws FsJailViolationError
  // on boundary breach — propagate. `PATCH_TRACE` injects the OTel binding.
  //
  // [F6] jun-6 tool-interrupt-behavior — parity with `edit`/`write`'s
  // `commitEdit`. The COMMIT (a MULTI-FILE FS mutation) runs inside the OPTIONAL
  // critical section so an in-flight ESC cannot tear a half-applied patch.
  // `begin?.()` is undefined when the seam is unwired (the three OFF gates) ⇒
  // byte-identical legacy path. The withheld abort (if any) is re-delivered at
  // `end()` (the dispatch impl re-checks the turn signal there), so the tool's
  // next `signal.aborted` check post-commit sees it. The section scopes the
  // FS-mutating window ONLY — parse + git-guard above never write.
  const cs = ctx?.criticalSection?.begin()
  try {
    return { result: await applyPatch(patch, port, undefined, PATCH_TRACE) }
  } finally {
    cs?.end()
  }
}

/**
 * ADR-0421 — attempt ONE fast-apply fallback re-emit after a recoverable V4A
 * failure. Returns the retry's `ApplyResult` + `modelUsed` when the fallback
 * rescued the patch, or `null` to signal "surface the ORIGINAL error" for
 * EVERY non-rescue path (unrecoverable error kind, aborted signal, fallback
 * declined / threw, no patch re-emitted, retry also failed). NO-THROW: the
 * port contract is no-throw, but a misbehaving port that throws is caught here
 * too so the original failure always wins. At most ONE attempt — no loop.
 */
async function tryFastApplyFallback(
  originalPatchText: string,
  originalError: unknown,
  port: FsJailFileSystemPort,
  fallback: FastApplyFallbackSeam,
  signal: AbortSignal,
  guard: GitWriteGuard | undefined,
  ctx: EditToolContext,
): Promise<{ result: ApplyResult; modelUsed?: string } | null> {
  const errorKind = classifyFastApplyError(originalError)
  // FsJailViolationError + any non-patch error are not re-emittable — a model
  // cannot fix a security-boundary breach, so we never spend a fallback on it.
  if (errorKind === null) return null
  // Honour an already-aborted turn before any I/O / dispatch.
  if (signal.aborted) return null

  const errorMessage = errMessage(originalError)
  // Read the failing op's current bytes so the model can re-anchor against
  // them. Best-effort: a missing/unreadable target simply omits the snapshot.
  const sourceFile = failingTargetPath(originalError)
  let sourceContent: string | undefined
  if (sourceFile !== undefined) {
    try {
      sourceContent = await port.readFile(sourceFile)
    } catch {
      sourceContent = undefined
    }
  }

  let attempt: Awaited<ReturnType<FastApplyFallbackSeam["attempt"]>>
  try {
    attempt = await fallback.attempt(
      {
        failure: { patch: originalPatchText, errorKind, errorMessage },
        ...(sourceFile !== undefined ? { sourceFile } : {}),
        ...(sourceContent !== undefined ? { sourceContent } : {}),
      },
      signal,
    )
  } catch {
    // A port that breaks its no-throw contract MUST NOT mask the real failure.
    return null
  }

  if (attempt.ok !== true || attempt.newPatch === null) return null

  // Re-run the V4A applier ONCE with the re-emitted patch. A retry that also
  // fails surfaces the ORIGINAL error (caller re-throws it), never the retry's.
  // The re-emitted patch is git-write-guarded the SAME as the primary: a model
  // MUST NOT be able to slip a `.git/hooks/**` target through the fallback. A
  // guarded re-emit is treated as a non-rescue (return null ⇒ original error).
  try {
    // [F6] the retry commit is ALSO a multi-file FS mutation ⇒ same critical
    // section as the primary apply (parity; default-OFF when the seam is unwired).
    const applied = await guardedParseAndApply(attempt.newPatch, port, guard, ctx)
    // A git-escape deny OR a stale-read deny on the re-emit is a non-rescue: the
    // model cannot slip a guarded/stale target through the fallback ⇒ surface the
    // ORIGINAL error (caller re-throws), never the retry's.
    if ("deny" in applied) return null
    const { result } = applied
    return attempt.modelUsed !== undefined ? { result, modelUsed: attempt.modelUsed } : { result }
  } catch {
    return null
  }
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
  // [F6] jun-6 tool-interrupt-behavior — PARITY with `edit`/`write`. A V4A patch
  // writes MULTIPLE files: an ESC mid-commit can leave a half-applied patch.
  // Declare `"block"` so the dispatch abort-router WITHHOLDS the turn abort ONLY
  // while the commit window (inside `guardedParseAndApply`) is open, then force-
  // delivers it at `end()`. Default-OFF / byte-identical unless the host wired
  // `ctx.criticalSection` AND the `QUANTA_TOOL_INTERRUPT_BLOCK` knob is on
  // (see ToolInterruptPolicy) — absent the seam, `begin?.()` is undefined ⇒
  // `block` degrades to `cancel`.
  interruptBehavior: (): "block" => "block",

  async *execute(input: Input, ctx: EditToolContext): AsyncIterable<ToolEvent> {
    const port = new FsJailFileSystemPort({ jailRoot: ctx.cwd })
    // ADR-0091 git-write-protection: guard EVERY target path the patch would
    // create/overwrite/delete/move-to BEFORE any filesystem mutation. A V4A
    // patch can target `.git/hooks/**`, `.git/config`, `.vscode/**` etc.
    // exactly like `write`/`edit`/`scripted_replace`; without this it bypassed
    // the guard those tools enforce. Default-OFF: `ctx.gitWriteGuard` unwired ⇒
    // `guardPatchTargets` returns null and the path is byte-identical.
    const guard = ctx.gitWriteGuard

    // Default-OFF fast path: no fallback port attached ⇒ the parse + apply
    // throws its typed error straight to the dispatch seam, byte-identical to
    // the pre-ADR-0421 contract (NO catch, NO fallback attempt).
    const fallback = ctx.fastApplyFallback
    if (fallback === undefined) {
      const applied = await guardedParseAndApply(input.patch, port, guard, ctx)
      if ("deny" in applied) {
        yield applied.deny
        return
      }
      yield { type: "result", result: { ok: true, output: formatApplyResult(applied.result) } }
      return
    }

    // Fallback wired: parse + apply once; on a RECOVERABLE V4A failure, make
    // ONE fast-apply re-emit attempt + retry. Any non-rescue path re-throws
    // the ORIGINAL typed error (NOT the retry's) so callers see unchanged
    // failure semantics (ADR-0421).
    try {
      const applied = await guardedParseAndApply(input.patch, port, guard, ctx)
      if ("deny" in applied) {
        yield applied.deny
        return
      }
      yield { type: "result", result: { ok: true, output: formatApplyResult(applied.result) } }
    } catch (err) {
      const rescued = await tryFastApplyFallback(
        input.patch,
        err,
        port,
        fallback,
        ctx.signal,
        guard,
        ctx,
      )
      if (rescued === null) throw err
      const note =
        rescued.modelUsed !== undefined
          ? ` (recovered via fast-apply fallback, model ${rescued.modelUsed})`
          : " (recovered via fast-apply fallback)"
      yield {
        type: "result",
        result: { ok: true, output: `${formatApplyResult(rescued.result)}${note}` },
      }
    }
  },
}
