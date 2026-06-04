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
}

/** Team subdir name + filename — the cross-session SSOT path components. */
export const DREAM_TEAM_SUBDIR = "team"
export const DREAM_TEAM_FILENAME = "cross-session.md"

/** Resolve the team target absolute path from the memory ROOT (e.g.
 *  `~/.quanta/memory`). Pure path math. */
export const resolveDreamTeamPath = (memoryRoot: string): string => {
  if (typeof memoryRoot !== "string" || memoryRoot.length === 0) {
    throw new Error("resolveDreamTeamPath: memoryRoot must be a non-empty string")
  }
  return path.join(memoryRoot, DREAM_TEAM_SUBDIR, DREAM_TEAM_FILENAME)
}

export interface FileDreamWriteTargetOpts {
  /** Memory root dir (e.g. `~/.quanta/memory`). */
  readonly memoryRoot: string
  /** Injected fs primitives. */
  readonly fs: DreamFsPort
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
    // Defense-in-depth: refuse to write anything named MEMORY.md (the live
    // user memory). This can only happen via a mis-wired path; fail loud.
    if (path.basename(this.targetPath) === "MEMORY.md") {
      throw new Error(`FileDreamWriteTarget refuses to write live MEMORY.md (${this.targetPath})`)
    }
    await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await this.fs.writeFile(this.targetPath, content, "utf8")
    return Buffer.byteLength(content, "utf8")
  }
}
