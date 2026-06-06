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
  type Patch,
  type PatchFileSystemPort,
  parsePatch,
} from "@/patch"
import { errMessage } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import { classifyFastApplyError, failingTargetPath } from "./apply-patch-fallback-wire"
import type { FastApplyFallbackSeam, GitWriteGuard, Tool, ToolContext, ToolEvent } from "./types"

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
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
}

interface PortOptions {
  jailRoot: string
  fs?: NodeFsLike
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
  port: PatchFileSystemPort,
  guard: GitWriteGuard | undefined,
): Promise<{ guardDeny: ToolEvent } | { result: ApplyResult }> {
  // parsePatch throws PatchParseError on grammar violation — propagate.
  const patch = parsePatch(patchText)
  // Guard EVERY target BEFORE any filesystem mutation (hard-stop posture).
  const guardDeny = guardPatchTargets(patch, guard)
  if (guardDeny) return { guardDeny }
  // applyPatch throws PatchApplyError / PatchAnchorNotFoundError on apply
  // failure — propagate. FsJailFileSystemPort throws FsJailViolationError
  // on boundary breach — propagate. `PATCH_TRACE` injects the OTel binding.
  return { result: await applyPatch(patch, port, undefined, PATCH_TRACE) }
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
  port: PatchFileSystemPort,
  fallback: FastApplyFallbackSeam,
  signal: AbortSignal,
  guard: GitWriteGuard | undefined,
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
    const applied = await guardedParseAndApply(attempt.newPatch, port, guard)
    if ("guardDeny" in applied) return null
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

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
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
      const applied = await guardedParseAndApply(input.patch, port, guard)
      if ("guardDeny" in applied) {
        yield applied.guardDeny
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
      const applied = await guardedParseAndApply(input.patch, port, guard)
      if ("guardDeny" in applied) {
        yield applied.guardDeny
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
