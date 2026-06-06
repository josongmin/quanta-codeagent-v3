/**
 * H16 — `FileDreamWriteTarget`: the shared `team/`-style write target.
 *
 * Cross-session consolidated knowledge is written HERE, NOT to the user's
 * live `MEMORY.md`. Convention (mirrors Claude's `team/` dir):
 *
 *   ~/.quanta/memory/team/cross-session.md
 *
 * `team/` is a SIBLING of `MEMORY.md` inside the memory root; the dream pass
 * never opens `MEMORY.md`. The target path is a config/convention surfaced by
 * `dream status` and asserted by the hellgate to NOT end in `MEMORY.md`.
 *
 * SAFETY (jun-06 hardening) — four guards, defense-in-depth:
 *   1. MEMORY.md-REFUSAL across the whole class — case-insensitive, every path
 *      segment (so a `MEMORY.md` DIR component or a `team/../MEMORY.md`
 *      traversal is also refused), plus a NUL-byte poison reject.
 *   2. JAIL — `resolveDreamTeamPath` rejects a relative root, a NUL byte, and a
 *      root carrying a `..` segment that could escape its own subtree.
 *   3. ATOMIC — write a temp sibling then rename; a rename failure cleans the
 *      temp so no torn file survives. Rename (not write) also defeats a planted
 *      symlink at the target (the symlink is replaced, not followed).
 *   4. CAP — content is bounded to {@link DREAM_TEAM_CONTENT_MAX_BYTES}; a
 *      non-string content is refused.
 *
 * DIP: the fs primitives are injected ({@link DreamFsPort}) so unit tests run
 * with an in-memory fake — no real disk touch, no `node:fs` import in the
 * domain path. The composition root wires `node:fs/promises`.
 */

import * as path from "node:path"
import type { DreamWriteTargetPort } from "./port"

/** Minimal fs seam — mirrors the consolidate writer's `NodeFsLike` subset. */
export interface DreamFsPort {
  mkdir(p: string, options: { recursive: true; mode?: number }): Promise<string | undefined>
  writeFile(p: string, content: string, encoding: "utf8"): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(p: string): Promise<void>
}

/** Team subdir name + filename — the cross-session SSOT path components. */
export const DREAM_TEAM_SUBDIR = "team"
export const DREAM_TEAM_FILENAME = "cross-session.md"

/** Upper bound on a single consolidated dream write. A consolidated note is a
 *  short markdown digest; anything past this is a runaway summarizer / hostile
 *  payload and is TRUNCATED rather than written unbounded. */
export const DREAM_TEAM_CONTENT_MAX_BYTES = 256 * 1024

/** True iff any normalized path segment is a `MEMORY.md` (case-insensitive) —
 *  catches the literal basename, a `MEMORY.md` DIR component, and a traversal
 *  that collapses onto MEMORY.md. */
const touchesMemoryMd = (p: string): boolean => {
  const normalized = path.normalize(p)
  return normalized.split(/[/\\]/).some((segment) => /^memory\.md$/i.test(segment))
}

/** Resolve the team target absolute path from the memory ROOT (e.g.
 *  `~/.quanta/memory`). Pure path math + JAIL: rejects a relative root, a NUL
 *  byte, and a root with a `..` segment that could escape its own subtree. */
export const resolveDreamTeamPath = (memoryRoot: string): string => {
  if (typeof memoryRoot !== "string" || memoryRoot.length === 0) {
    throw new Error("resolveDreamTeamPath: memoryRoot must be a non-empty string")
  }
  if (memoryRoot.includes("\0")) {
    throw new Error("resolveDreamTeamPath: memoryRoot contains a NUL byte")
  }
  if (!path.isAbsolute(memoryRoot)) {
    throw new Error(
      `resolveDreamTeamPath: memoryRoot must be absolute to be jailable (${memoryRoot})`,
    )
  }
  // A `..` segment in the root can escape its own subtree (jail escape). The
  // legitimate root is a clean absolute dir; reject any parent-traversal.
  if (memoryRoot.split(/[/\\]/).includes("..")) {
    throw new Error(
      `resolveDreamTeamPath: memoryRoot must not escape its root via ".." (${memoryRoot})`,
    )
  }
  return path.join(memoryRoot, DREAM_TEAM_SUBDIR, DREAM_TEAM_FILENAME)
}

export interface FileDreamWriteTargetOpts {
  /** Memory root dir (e.g. `~/.quanta/memory`). */
  readonly memoryRoot: string
  /** Injected fs primitives. */
  readonly fs: DreamFsPort
}

/** Truncate `content` to at most `maxBytes` UTF-8 bytes without splitting a
 *  multi-byte code point. */
const capUtf8 = (content: string, maxBytes: number): string => {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content
  const buf = Buffer.from(content, "utf8")
  let end = maxBytes
  // Back up off a UTF-8 continuation byte (0b10xxxxxx) so we never emit a torn
  // code point.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString("utf8")
}

export class FileDreamWriteTarget implements DreamWriteTargetPort {
  public readonly targetPath: string
  private readonly dir: string
  private readonly fs: DreamFsPort

  constructor(opts: FileDreamWriteTargetOpts) {
    this.targetPath = resolveDreamTeamPath(opts.memoryRoot)
    this.dir = path.dirname(this.targetPath)
    this.fs = opts.fs
  }

  async write(content: string): Promise<number> {
    if (typeof content !== "string") {
      throw new Error("FileDreamWriteTarget.write: content must be a string")
    }
    // Defense-in-depth: refuse to write anything that resolves onto MEMORY.md
    // (the live user memory) — case, traversal, or a MEMORY.md DIR component.
    // This can only happen via a mis-wired/poisoned path; fail loud.
    if (this.targetPath.includes("\0")) {
      throw new Error(`FileDreamWriteTarget refuses a NUL-byte target path (${this.targetPath})`)
    }
    if (touchesMemoryMd(this.targetPath)) {
      throw new Error(`FileDreamWriteTarget refuses to write live MEMORY.md (${this.targetPath})`)
    }

    const capped = capUtf8(content, DREAM_TEAM_CONTENT_MAX_BYTES)
    await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })

    // ATOMIC: write a temp sibling, then rename onto the final target. Rename
    // (not a direct write) also defeats a planted symlink at the target — the
    // symlink is REPLACED, not followed into MEMORY.md. A rename failure cleans
    // the temp so no torn file survives.
    const tmp = `${this.targetPath}.tmp-${process.pid}-${Date.now()}`
    await this.fs.writeFile(tmp, capped, "utf8")
    try {
      await this.fs.rename(tmp, this.targetPath)
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => {})
      throw err
    }
    return Buffer.byteLength(capped, "utf8")
  }
}
