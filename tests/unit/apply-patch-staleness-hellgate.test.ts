/**
 * LANE 2 — apply_patch STALENESS parity (ADR-0474 stale-read-guard wired into
 * apply_patch). HELLGATE e2e: drives the REAL `applyPatchTool.execute` end-to-end
 * (async-generator ToolContext run that yields the actual ToolResult) against a
 * REAL temp-dir filesystem.
 *
 * THE GAP this pins: `edit` blocks a write whose target was externally modified
 * since the model last read it (read-before-write staleness / TOCTOU guard).
 * `apply_patch` previously had NO such guard — it applied to whatever bytes were
 * on disk now, so a target that drifted since the last read got patched on
 * drifted content (or only the anchor broke). This lane wires the SAME
 * `guardWrite(ctx.readFileState, ...)` the edit tool uses.
 *
 * Red-on-injection: reverting the guard wiring in `src/tool/apply-patch.ts` MUST
 * turn cases (i) and (iii) RED — the patch would apply to the drifted file.
 *
 * Byte-identical default-OFF: with `readFileState` ABSENT the SAME patch applies
 * ok:true exactly as today (case ii).
 */
import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePatch } from "@/patch"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool, FsJailFileSystemPort, type NodeFsLike } from "@/tool/apply-patch"
import { guardStalePatchTargets } from "@/tool/patch-mutation-safety"
import { ReadFileState } from "@/tool/stale-read-guard"

const root = mkdtempSync(join(tmpdir(), "apply-patch-stale-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tmpSub = (name: string): string => {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

/** A ToolContext with the OPTIONAL stale-read-guard state wired (host opt-in
 *  mirror). Absent `readFileState` ⇒ byte-identical default-OFF path. */
const ctx = (cwd: string, readFileState?: ReadFileState): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(readFileState !== undefined ? { readFileState } : {}),
})

/** Drive the REAL tool generator end-to-end and capture the terminal result. */
const run = async (
  input: unknown,
  cwd: string,
  readFileState?: ReadFileState,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute(input as never, ctx(cwd, readFileState))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/** Force `path`'s on-disk mtime to be NEWER than its current mtime (simulate an
 *  external write after the model's read). Returns the actual new mtimeMs.
 *
 *  Robustness: round the current mtime UP to the next whole second and add the
 *  margin as whole seconds, so the new mtime is a CLEAN integer-second value
 *  STRICTLY greater than the current one regardless of filesystem mtime
 *  granularity. The earlier `cur.mtimeMs/1000 + byMs/1000` float-second
 *  round-trip could, on a coarse-granularity FS, collapse back to the same tick
 *  the model recorded (a witnessed-once, hard-to-reproduce flake). Integer
 *  seconds + ceil eliminate that non-determinism. */
const bumpMtimeForward = (path: string, byMs: number): number => {
  const cur = statSync(path)
  const newMtimeSec = Math.ceil(cur.mtimeMs / 1000) + Math.max(1, Math.ceil(byMs / 1000))
  utimesSync(path, Math.ceil(cur.atimeMs / 1000), newMtimeSec)
  return statSync(path).mtimeMs
}

const updatePatch = (file: string): string =>
  [
    "*** Begin Patch",
    `*** Update File: ${file}`,
    "@@",
    " beta",
    "-gamma",
    "+GAMMA",
    " delta",
    "*** End Patch",
  ].join("\n")

const ORIGINAL = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
const PATCHED = "alpha\nbeta\nGAMMA\ndelta\nepsilon\n"

describe("apply_patch stale-read-guard parity (ADR-0474)", () => {
  // (i) recorded OLD mtime, on-disk now NEWER ⇒ REJECT, file byte-UNTOUCHED.
  test("(i) stale Update target ⇒ ok:false stale_read, file untouched on disk", async () => {
    const dir = tmpSub("stale-update")
    const file = join(dir, "f.txt")
    writeFileSync(file, ORIGINAL)
    // Record the read-time mtime the model "saw", then bump disk forward.
    const recordedMtime = statSync(file).mtimeMs
    const state = new ReadFileState()
    state.record(file, recordedMtime)
    const newMtime = bumpMtimeForward(file, 5000)
    expect(newMtime).toBeGreaterThan(recordedMtime)

    const r = await run({ patch: updatePatch("f.txt") }, dir, state)

    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    // The patch must NEVER have reached the filesystem — byte-untouched.
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL)
  })

  // (ii) absent readFileState ⇒ the SAME patch applies ok:true (byte-identical
  // default-OFF). Same drifted-on-disk situation as (i), but no guard wired.
  test("(ii) absent readFileState ⇒ SAME patch applies ok:true (byte-identical)", async () => {
    const dir = tmpSub("absent-state")
    const file = join(dir, "f.txt")
    writeFileSync(file, ORIGINAL)
    bumpMtimeForward(file, 5000)

    const r = await run({ patch: updatePatch("f.txt") }, dir /* no readFileState */)

    expect(r.ok).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(PATCHED)
  })

  // (ii-b) readFileState present + target FRESH (recorded mtime === current) ⇒
  // applies ok:true. Confirms the guard does not reject a non-stale target
  // (a guard that rejected everything would pass (i)/(iii) for the wrong reason).
  test("(ii-b) readFileState present but target FRESH ⇒ applies ok:true", async () => {
    const dir = tmpSub("fresh-state")
    const file = join(dir, "f.txt")
    writeFileSync(file, ORIGINAL)
    const state = new ReadFileState()
    state.record(file, statSync(file).mtimeMs) // recorded === current ⇒ fresh

    const r = await run({ patch: updatePatch("f.txt") }, dir, state)

    expect(r.ok).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(PATCHED)
  })

  // (iii) multi-op patch where ONE target is stale ⇒ WHOLE patch rejected with
  // ZERO files written (no partial apply). The patch updates two files + adds a
  // new one; only the SECOND update target is stale.
  test("(iii) one stale target in a multi-op patch ⇒ whole patch rejected, zero writes", async () => {
    const dir = tmpSub("multi-op-stale")
    const fileA = join(dir, "a.txt")
    const fileB = join(dir, "b.txt")
    writeFileSync(fileA, ORIGINAL)
    writeFileSync(fileB, ORIGINAL)

    const state = new ReadFileState()
    // A is recorded fresh (current mtime); B is recorded then drifted forward.
    state.record(fileA, statSync(fileA).mtimeMs)
    const recordedB = statSync(fileB).mtimeMs
    state.record(fileB, recordedB)
    const newB = bumpMtimeForward(fileB, 5000)
    expect(newB).toBeGreaterThan(recordedB)

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** Update File: b.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** Add File: c.txt",
      "+brand new",
      "*** End Patch",
    ].join("\n")

    const r = await run({ patch }, dir, state)

    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    // NO partial apply: neither updated file changed, and the Add file was never
    // created (the whole patch is rejected BEFORE any write).
    expect(readFileSync(fileA, "utf8")).toBe(ORIGINAL)
    expect(readFileSync(fileB, "utf8")).toBe(ORIGINAL)
    expect(existsSync(join(dir, "c.txt"))).toBe(false)
  })

  // (iv) Delete target staleness — a stale Delete target is also rejected (the
  // model's read-time view of the to-be-deleted file is drifted).
  test("(iv) stale Delete target ⇒ ok:false stale_read, file still present", async () => {
    const dir = tmpSub("stale-delete")
    const file = join(dir, "doomed.txt")
    writeFileSync(file, "remove me\n")
    const state = new ReadFileState()
    const recorded = statSync(file).mtimeMs
    state.record(file, recorded)
    bumpMtimeForward(file, 5000)

    const patch = ["*** Begin Patch", "*** Delete File: doomed.txt", "*** End Patch"].join("\n")

    const r = await run({ patch }, dir, state)

    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    expect(existsSync(file)).toBe(true)
  })

  // (v) Add target (new file) is NOT staleness-checked — a brand-new file the
  // model never read has no baseline, so an Add always applies even with the
  // guard wired (mirrors edit's `unread ⇒ allow` posture).
  test("(v) Add target is never staleness-checked ⇒ applies ok:true with guard wired", async () => {
    const dir = tmpSub("add-not-checked")
    const state = new ReadFileState() // empty: nothing recorded
    const patch = ["*** Begin Patch", "*** Add File: fresh.txt", "+hello", "*** End Patch"].join(
      "\n",
    )

    const r = await run({ patch }, dir, state)

    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "fresh.txt"), "utf8")).toBe("hello")
  })

  // (vi) Update-with-Move: the SOURCE (op.path) is the read target and IS
  // staleness-checked; the move DESTINATION (op.moveTo, must-not-exist) is not.
  // A stale move SOURCE ⇒ whole patch rejected, source untouched, dest never
  // created. Pins the documented move-source/move-dest asymmetry.
  test("(vi) stale Move SOURCE ⇒ ok:false stale_read; source untouched, dest never created", async () => {
    const dir = tmpSub("stale-move-source")
    const src = join(dir, "src.txt")
    writeFileSync(src, ORIGINAL)
    const state = new ReadFileState()
    const recorded = statSync(src).mtimeMs
    state.record(src, recorded)
    const bumped = bumpMtimeForward(src, 5000)
    expect(bumped).toBeGreaterThan(recorded)

    const patch = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** End Patch",
    ].join("\n")

    const r = await run({ patch }, dir, state)

    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    expect(readFileSync(src, "utf8")).toBe(ORIGINAL)
    expect(existsSync(join(dir, "dst.txt"))).toBe(false)
  })

  test("(vii) EACCES while statting a stale target fails closed before any write", async () => {
    const dir = tmpSub("stat-eacces")
    const file = join(dir, "f.txt")
    writeFileSync(file, ORIGINAL)
    const state = new ReadFileState()
    state.record(file, 1)
    let stats = 0
    const fs: NodeFsLike = {
      readFile: (p, encoding) => nodeFs.readFile(p, encoding),
      writeFile: (p, content, encoding) => nodeFs.writeFile(p, content, encoding),
      unlink: (p) => nodeFs.unlink(p),
      rename: (from, to) => nodeFs.rename(from, to),
      mkdir: (p, options) => nodeFs.mkdir(p, options),
      stat: async (p) => {
        if (stats++ === 0) {
          const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
          throw error
        }
        return nodeFs.stat(p)
      },
    }
    const port = new FsJailFileSystemPort({ jailRoot: dir, fs })

    const deny = await guardStalePatchTargets(
      parsePatch(updatePatch("f.txt")),
      port,
      { readFileState: state },
      "apply_patch",
    )

    expect(deny?.type).toBe("result")
    if (deny?.type !== "result") return
    expect(deny.result.failure).toEqual({ mode: "rejected", reason: "stale_read_check_failed" })
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL)
  })

  test("(viii) a stat result without mtime fails closed before any write", async () => {
    const dir = tmpSub("stat-no-mtime")
    const file = join(dir, "f.txt")
    writeFileSync(file, ORIGINAL)
    const state = new ReadFileState()
    state.record(file, 1)
    const fs: NodeFsLike = {
      readFile: (p, encoding) => nodeFs.readFile(p, encoding),
      writeFile: (p, content, encoding) => nodeFs.writeFile(p, content, encoding),
      unlink: (p) => nodeFs.unlink(p),
      rename: (from, to) => nodeFs.rename(from, to),
      mkdir: (p, options) => nodeFs.mkdir(p, options),
      stat: async (p) => {
        const stat = await nodeFs.stat(p)
        return { isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory() }
      },
    }
    const port = new FsJailFileSystemPort({ jailRoot: dir, fs })

    const deny = await guardStalePatchTargets(
      parsePatch(updatePatch("f.txt")),
      port,
      { readFileState: state },
      "apply_patch",
    )

    expect(deny?.type).toBe("result")
    if (deny?.type !== "result") return
    expect(deny.result.failure).toEqual({ mode: "rejected", reason: "stale_read_check_failed" })
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL)
  })

  test("(ix) existence checks do not convert EACCES into a false absent verdict", async () => {
    const dir = tmpSub("exists-eacces")
    const fs: NodeFsLike = {
      readFile: (p, encoding) => nodeFs.readFile(p, encoding),
      writeFile: (p, content, encoding) => nodeFs.writeFile(p, content, encoding),
      unlink: (p) => nodeFs.unlink(p),
      rename: (from, to) => nodeFs.rename(from, to),
      mkdir: (p, options) => nodeFs.mkdir(p, options),
      stat: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      },
    }
    const port = new FsJailFileSystemPort({ jailRoot: dir, fs })

    await expect(port.exists("f.txt")).rejects.toMatchObject({ code: "EACCES" })
  })
})
