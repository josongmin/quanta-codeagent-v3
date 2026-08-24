/**
 * HELLGATE — ADR-0548 follow-on: the apply_patch multi-target PREFLIGHT must use
 * the CONTENT DIGEST as the freshness authority, exactly like `edit` does.
 *
 * THE GAP THIS PINS (recorded in ADR-0548 Consequences and the feature YAML's
 * "REMAINING GAP"): ADR-0548 made the recorded whole-file digest the authority
 * for the stale-read guard, and wired it through `read` (records) and `edit`
 * (`editPreCommitDeny` passes `sha256Hex(planned.before)` — zero extra IO,
 * `planEdit` already read the file). `apply_patch`'s preflight
 * (`guardStalePatchTargets`) kept calling `guardWrite(state, resolvedPath,
 * mtimeMs)` with NO digest, because its port surface `statTarget` returns only
 * `{exists, resolvedPath, mtimeMs}`.
 *
 * Consequence, and the ASYMMETRY these tests measure: a content swap that does
 * NOT advance the mtime (`cp -p`, `rsync --times`, `tar -x`, a build step that
 * restores timestamps, two writes in one second-granularity tick) is REFUSED on
 * an `edit` target and ALLOWED on an `apply_patch` target. Same guard, same
 * state, two different verdicts — decided only by which tool the model picked.
 *
 * Invariants:
 *
 *  AP-1  RED — a SAME-mtime content swap on an Update target is DENIED
 *        (`stale_read`).
 *  AP-2  RED — a BACKWARD-mtime content swap on a Delete target is DENIED.
 *  AP-3  RED (the headline) — the ASYMMETRY: the identical swap on the identical
 *        file is refused by the real `edit` tool and allowed by the real
 *        apply_patch preflight.
 *  AP-4  PAIRED CONTROL — an UNCHANGED file still PASSES the preflight, even
 *        when its mtime moved FORWARD. Load-bearing: a "fix" that denied
 *        everything satisfies AP-1..AP-3 and breaks every patch.
 *  AP-5  UNREAD stays allowed, and costs ZERO extra IO — creating a new file
 *        must keep working and must not pay a read.
 *  AP-6  FALLBACK PARITY — a path with an mtime baseline but NO recorded digest
 *        keeps the forward-mtime rule byte-for-byte, and pays no read.
 *  AP-7  FAIL-SOFT PARITY — a failed content read is not a new crash path; it
 *        denies with `stale_read_check_failed`, the SAME shape a failed
 *        `statTarget` already uses.
 *  AP-8  ALL-TARGET PREFLIGHT-THEN-WRITE — a stale SECOND target denies the
 *        whole patch with the FIRST target byte-untouched on disk (no partial
 *        write), through the REAL `apply_patch` tool.
 *  AP-9  PAIRED CONTROL — a CHAINED patch to a file this agent just patched
 *        still applies. A digest baseline refreshed only by `read` goes stale on
 *        the agent's OWN write, so a preflight comparing against it would veto
 *        the second patch with no external writer anywhere. (The `edit` half of
 *        AP-9 covers the same self-veto in `edit`, now fixed — see there.)
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePatch } from "@/patch"
import { sha256Hex } from "@/storage"
import { defaultTools, ToolRegistry } from "@/tool"
import type { GuardedPatchFileSystemPort } from "@/tool/patch-mutation-safety"
import { guardStalePatchTargets } from "@/tool/patch-mutation-safety"
import { ReadFileState } from "@/tool/stale-read-guard"

/* ── fake port ────────────────────────────────────────────────────────────── */

interface FakeFile {
  content: string
  mtimeMs: number
}

/** A {@link GuardedPatchFileSystemPort} over an in-memory file table, counting
 *  every `readFile` so the "zero extra IO" claims are MEASURED, not asserted by
 *  reading the implementation. Every mutator throws: the preflight runs strictly
 *  BEFORE any write, so a preflight that wrote would fail loudly here. */
const makePort = (
  files: Record<string, FakeFile>,
  opts: { readFileThrows?: boolean } = {},
): { port: GuardedPatchFileSystemPort; reads: string[] } => {
  const reads: string[] = []
  const mutated = (): never => {
    throw new Error("the preflight must never mutate")
  }
  const port: GuardedPatchFileSystemPort = {
    async readFile(p: string): Promise<string> {
      reads.push(p)
      if (opts.readFileThrows === true) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      }
      const f = files[p]
      if (f === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" })
      return f.content
    },
    async writeFile(): Promise<void> {
      mutated()
    },
    async deleteFile(): Promise<void> {
      mutated()
    },
    async renameFile(): Promise<void> {
      mutated()
    },
    async exists(p: string): Promise<boolean> {
      return files[p] !== undefined
    },
    async statTarget(p) {
      const f = files[p]
      return f === undefined
        ? ({ exists: false } as const)
        : ({ exists: true, resolvedPath: p, mtimeMs: f.mtimeMs } as const)
    },
  }
  return { port, reads }
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

const deletePatch = (file: string): string =>
  ["*** Begin Patch", `*** Delete File: ${file}`, "*** End Patch"].join("\n")

const addPatch = (file: string): string =>
  ["*** Begin Patch", `*** Add File: ${file}`, "+hello", "*** End Patch"].join("\n")

const ORIGINAL = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
const SWAPPED = "alpha\nbeta\nSOMEONE-ELSE\ndelta\nepsilon\n"

/** Run the REAL preflight and reduce it to the model-facing verdict. */
const preflight = async (
  patchText: string,
  port: GuardedPatchFileSystemPort,
  state: ReadFileState | undefined,
): Promise<{ denied: boolean; reason?: string }> => {
  const ev = await guardStalePatchTargets(
    parsePatch(patchText),
    port,
    state === undefined ? undefined : { readFileState: state },
    "apply_patch",
  )
  if (ev === null) return { denied: false }
  if (ev.type !== "result") throw new Error("preflight must deny with a result event")
  // `ToolFailure` is a discriminated union; only some arms carry `reason`, so
  // narrow structurally rather than asserting a shape.
  const failure = ev.result.failure
  const reason = failure !== undefined && "reason" in failure ? failure.reason : undefined
  return { denied: true, ...(typeof reason === "string" ? { reason } : {}) }
}

/** The state an agent holds after a FULL read of `content` at `mtimeMs` — the
 *  exact pair `src/tool/read/index.ts` records (`record` + `recordContent`). */
const afterFullRead = (path: string, content: string, mtimeMs: number): ReadFileState => {
  const state = new ReadFileState()
  state.record(path, mtimeMs)
  state.recordContent(path, sha256Hex(content))
  return state
}

/* ── AP-1 / AP-2 — the bypass, on the real preflight ──────────────────────── */

describe("AP — apply_patch preflight honours the content digest", () => {
  test("AP-1 a SAME-mtime content swap on an Update target is DENIED", async () => {
    const state = afterFullRead("/w/f.txt", ORIGINAL, 1000)
    // The content changed; the timestamp did not. `cp -p` / `rsync --times` /
    // `tar -x` / two writes in one second-granularity tick.
    const { port } = makePort({ "/w/f.txt": { content: SWAPPED, mtimeMs: 1000 } })
    expect(await preflight(updatePatch("/w/f.txt"), port, state)).toEqual({
      denied: true,
      reason: "stale_read",
    })
  })

  test("AP-2 a BACKWARD-mtime content swap on a Delete target is DENIED", async () => {
    const state = afterFullRead("/w/f.txt", ORIGINAL, 1000)
    const { port } = makePort({ "/w/f.txt": { content: SWAPPED, mtimeMs: 1 } })
    expect(await preflight(deletePatch("/w/f.txt"), port, state)).toEqual({
      denied: true,
      reason: "stale_read",
    })
  })

  /* ── AP-4 — the paired control that keeps the fix from being "deny all" ─── */

  test("AP-4 PAIRED CONTROL — an UNCHANGED file passes even with a FORWARD mtime", async () => {
    const state = afterFullRead("/w/f.txt", ORIGINAL, 1000)
    // A `touch`, a chmod, or a rewrite to identical bytes. Denying here would
    // veto every patch whose target was touched by an unrelated build step.
    const { port } = makePort({ "/w/f.txt": { content: ORIGINAL, mtimeMs: 9_999_999 } })
    expect(await preflight(updatePatch("/w/f.txt"), port, state)).toEqual({ denied: false })
  })

  test("AP-4b PAIRED CONTROL — an UNCHANGED file at an UNCHANGED mtime passes", async () => {
    const state = afterFullRead("/w/f.txt", ORIGINAL, 1000)
    const { port } = makePort({ "/w/f.txt": { content: ORIGINAL, mtimeMs: 1000 } })
    expect(await preflight(updatePatch("/w/f.txt"), port, state)).toEqual({ denied: false })
  })

  /* ── AP-5 / AP-6 — unread + fallback parity, and their IO cost ──────────── */

  test("AP-5 an UNREAD target is allowed and costs ZERO extra reads", async () => {
    const state = new ReadFileState() // nothing ever read
    const { port, reads } = makePort({ "/w/f.txt": { content: SWAPPED, mtimeMs: 1 } })
    expect(await preflight(updatePatch("/w/f.txt"), port, state)).toEqual({ denied: false })
    // `unread` is not stale — and the preflight must not pay a read to learn it.
    expect(reads).toEqual([])
  })

  test("AP-5b creating a NEW file (Add op) is never preflighted at all", async () => {
    const state = new ReadFileState()
    const { port, reads } = makePort({})
    expect(await preflight(addPatch("/w/new.txt"), port, state)).toEqual({ denied: false })
    expect(reads).toEqual([])
  })

  test("AP-6 FALLBACK PARITY — mtime baseline but NO digest keeps the forward-mtime rule", async () => {
    // A RANGED read records the mtime but no whole-file digest (a window is not
    // the file). The old rule must survive byte-for-byte, and pay no read.
    const state = new ReadFileState()
    state.record("/w/f.txt", 1000)

    const fwd = makePort({ "/w/f.txt": { content: SWAPPED, mtimeMs: 5000 } })
    expect(await preflight(updatePatch("/w/f.txt"), fwd.port, state)).toEqual({
      denied: true,
      reason: "stale_read",
    })
    expect(fwd.reads).toEqual([])

    const same = makePort({ "/w/f.txt": { content: SWAPPED, mtimeMs: 1000 } })
    expect(await preflight(updatePatch("/w/f.txt"), same.port, state)).toEqual({ denied: false })
    expect(same.reads).toEqual([])
  })

  test("AP-6b guard OFF (no readFileState) short-circuits before any IO", async () => {
    const { port, reads } = makePort({ "/w/f.txt": { content: SWAPPED, mtimeMs: 1 } })
    expect(await preflight(updatePatch("/w/f.txt"), port, undefined)).toEqual({ denied: false })
    expect(reads).toEqual([])
  })

  /* ── AP-7 — fail-soft parity with the existing statTarget failure ───────── */

  test("AP-7 FAIL-SOFT — a failed content read denies with stale_read_check_failed, never throws", async () => {
    const state = afterFullRead("/w/f.txt", ORIGINAL, 1000)
    const { port } = makePort(
      { "/w/f.txt": { content: ORIGINAL, mtimeMs: 1000 } },
      {
        readFileThrows: true,
      },
    )
    // Same shape the existing `statTarget` failure already uses — a new crash
    // path would surface as a rejected promise out of this call.
    expect(await preflight(updatePatch("/w/f.txt"), port, state)).toEqual({
      denied: true,
      reason: "stale_read_check_failed",
    })
  })

  /* ── AP-8 — the preflight-then-write invariant, all targets ─────────────── */

  test("AP-8 a stale SECOND target denies the whole patch (first target checked too)", async () => {
    const state = new ReadFileState()
    state.record("/w/a.txt", 1000)
    state.recordContent("/w/a.txt", sha256Hex(ORIGINAL))
    state.record("/w/b.txt", 1000)
    state.recordContent("/w/b.txt", sha256Hex(ORIGINAL))
    const { port } = makePort({
      "/w/a.txt": { content: ORIGINAL, mtimeMs: 1000 }, // fresh
      "/w/b.txt": { content: SWAPPED, mtimeMs: 1000 }, // same-mtime swap
    })
    const twoOps = [
      "*** Begin Patch",
      "*** Update File: /w/a.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** Update File: /w/b.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** End Patch",
    ].join("\n")
    expect(await preflight(twoOps, port, state)).toEqual({
      denied: true,
      reason: "stale_read",
    })
  })
})

/* ------------------------------------------------------------------------- *
 * AP-3 — the ASYMMETRY, through the SHIPPED tools.
 *
 * Everything above drives the preflight owner directly. What a user feels is
 * whether the two mutating tools agree. Read a file through the real `read`
 * tool, let an external writer swap its content while moving the mtime
 * BACKWARD, then drive the real `edit` and the real `apply_patch` against the
 * SAME state and the SAME file.
 * ------------------------------------------------------------------------- */

const driveTool = async (
  dir: string,
  state: ReadFileState,
  name: string,
  input: unknown,
): Promise<{ ok: boolean; reason?: string }> => {
  const tool = new ToolRegistry(defaultTools).get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  const ctx = {
    cwd: dir,
    readFileState: state,
    editFreshHash: true,
    signal: new AbortController().signal,
  } as never
  let last: { ok: boolean; failure?: { reason?: string } } | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") last = ev.result as typeof last
  }
  if (last === undefined) throw new Error("tool produced no result")
  const reason = last.failure?.reason
  return { ok: last.ok, ...(typeof reason === "string" ? { reason } : {}) }
}

/** Swap `file`'s content and pull its mtime BACKWARD — the case the mtime-only
 *  rule calls fresh. Returns nothing; asserts the backward move happened. */
const swapContentBackwardMtime = (file: string, next: string, beforeMtimeMs: number): void => {
  writeFileSync(file, next)
  const past = new Date(beforeMtimeMs - 60_000)
  utimesSync(file, past, past)
  expect(statSync(file).mtimeMs).toBeLessThan(beforeMtimeMs)
}

describe("AP-3 end-to-end — edit and apply_patch must agree on the same swap", () => {
  test("a backward-mtime content swap is refused by BOTH edit and apply_patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-asym-"))
    try {
      const file = join(dir, "f.txt")
      writeFileSync(file, ORIGINAL)
      const beforeMtime = statSync(file).mtimeMs

      // Two independent agents that each did the same full read.
      const editState = new ReadFileState()
      const patchState = new ReadFileState()
      expect((await driveTool(dir, editState, "read", { path: file })).ok).toBe(true)
      expect((await driveTool(dir, patchState, "read", { path: file })).ok).toBe(true)

      swapContentBackwardMtime(file, SWAPPED, beforeMtime)

      const edit = await driveTool(dir, editState, "edit", {
        path: file,
        old_string: "SOMEONE-ELSE",
        new_string: "MINE",
      })
      expect({ ok: edit.ok, reason: edit.reason }).toEqual({ ok: false, reason: "stale_read" })

      // THE ASYMMETRY: the identical swap on the identical file, through
      // apply_patch. Before the fix this returns ok:true and patches the file
      // the agent never saw.
      const patched = await driveTool(dir, patchState, "apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: f.txt",
          "@@",
          " beta",
          "-SOMEONE-ELSE",
          "+MINE",
          " delta",
          "*** End Patch",
        ].join("\n"),
      })
      expect({ ok: patched.ok, reason: patched.reason }).toEqual({
        ok: false,
        reason: "stale_read",
      })
      // And the swapped bytes are still on disk — the deny was not a partial write.
      expect(readFileSync(file, "utf8")).toBe(SWAPPED)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("AP-8e PAIRED CONTROL + preflight-then-write — a fresh first file survives a stale second", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-multi-"))
    try {
      const a = join(dir, "a.txt")
      const b = join(dir, "b.txt")
      writeFileSync(a, ORIGINAL)
      writeFileSync(b, ORIGINAL)
      const bMtime = statSync(b).mtimeMs

      const state = new ReadFileState()
      expect((await driveTool(dir, state, "read", { path: a })).ok).toBe(true)
      expect((await driveTool(dir, state, "read", { path: b })).ok).toBe(true)

      // Only `b` drifts, and it drifts the invisible way.
      swapContentBackwardMtime(b, SWAPPED, bMtime)

      const twoFile = [
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
        "-SOMEONE-ELSE",
        "+MINE",
        " delta",
        "*** End Patch",
      ].join("\n")
      const r = await driveTool(dir, state, "apply_patch", { patch: twoFile })
      expect({ ok: r.ok, reason: r.reason }).toEqual({ ok: false, reason: "stale_read" })
      // ALL-TARGET PREFLIGHT-THEN-WRITE: `a` was patchable and is byte-untouched.
      expect(readFileSync(a, "utf8")).toBe(ORIGINAL)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("AP-4e PAIRED CONTROL — an untouched multi-file patch still applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-ok-"))
    try {
      const a = join(dir, "a.txt")
      const b = join(dir, "b.txt")
      writeFileSync(a, ORIGINAL)
      writeFileSync(b, ORIGINAL)
      const state = new ReadFileState()
      expect((await driveTool(dir, state, "read", { path: a })).ok).toBe(true)
      expect((await driveTool(dir, state, "read", { path: b })).ok).toBe(true)

      const twoFile = [
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
        "*** End Patch",
      ].join("\n")
      const r = await driveTool(dir, state, "apply_patch", { patch: twoFile })
      expect({ ok: r.ok, reason: r.reason }).toEqual({ ok: true, reason: undefined })
      expect(readFileSync(a, "utf8")).toContain("GAMMA")
      expect(readFileSync(b, "utf8")).toContain("GAMMA")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------------- *
 * AP-9 — CHAINED MUTATION, the control that stops the fix from self-vetoing.
 *
 * A digest baseline that is only ever refreshed by `read` goes STALE the moment
 * the agent's OWN mutation rewrites the file. If the preflight compares against
 * that stale digest, the SECOND patch to a file the FIRST patch just wrote is
 * denied `stale_read` — the agent blocked by its own work, with no external
 * writer anywhere. Same shape as the ~41% self-inflicted staleness the
 * jul-13 edit-fresh-hash work already had to cure for the mtime rule.
 * ------------------------------------------------------------------------- */

describe("AP-9 chained mutation — the agent must not be vetoed by its own write", () => {
  test("read → apply_patch → apply_patch on the same file succeeds twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-chain-"))
    try {
      const file = join(dir, "f.txt")
      writeFileSync(file, ORIGINAL)
      const state = new ReadFileState()
      expect((await driveTool(dir, state, "read", { path: file })).ok).toBe(true)

      const first = await driveTool(dir, state, "apply_patch", { patch: updatePatch("f.txt") })
      expect({ ok: first.ok, reason: first.reason }).toEqual({ ok: true, reason: undefined })

      const second = await driveTool(dir, state, "apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: f.txt",
          "@@",
          " beta",
          "-GAMMA",
          "+DELTA",
          " delta",
          "*** End Patch",
        ].join("\n"),
      })
      expect({ ok: second.ok, reason: second.reason }).toEqual({ ok: true, reason: undefined })
      expect(readFileSync(file, "utf8")).toContain("DELTA")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * REGRESSION LOCK — `edit` had the SAME self-veto; it is FIXED and this is now
   * a live assertion (it was pinned `test.failing` for exactly one commit).
   *
   * ADR-0548 wired `sha256Hex(planned.before)` into `editPreCommitDeny`, but no
   * call site refreshed the digest after a successful edit — `recordContent` was
   * reached from `src/tool/read/index.ts` ONLY. `state.ts` already claimed the
   * digest is "Populated ONLY by a full-file read ... and by a successful
   * self-mutation"; the second half had no implementation. With the DEFAULT-ON
   * guard and DEFAULT-ON `QUANTA_EDIT_FRESH_HASH`, the SECOND consecutive edit
   * to a file (no re-read between) was denied `stale_read` against the agent's
   * OWN write — measured through the shipped tools, not inferred.
   *
   * The cure is at the shared chokepoint: `recordFreshBaseline` now takes the
   * post-mutation content and records its digest alongside the mtime, so every
   * single-file mutator (edit/write/scripted_replace/notebook_edit) refreshes
   * BOTH baselines. Anti-vacuum: `AP-10` proves a genuine EXTERNAL clobber is
   * still denied, so this cannot pass by the guard having been defanged.
   */
  test("read → edit → edit on the same file succeeds twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-chain-edit-"))
    try {
      const file = join(dir, "f.txt")
      writeFileSync(file, ORIGINAL)
      const state = new ReadFileState()
      expect((await driveTool(dir, state, "read", { path: file })).ok).toBe(true)

      const first = await driveTool(dir, state, "edit", {
        path: file,
        old_string: "gamma",
        new_string: "GAMMA",
      })
      expect({ ok: first.ok, reason: first.reason }).toEqual({ ok: true, reason: undefined })

      const second = await driveTool(dir, state, "edit", {
        path: file,
        old_string: "GAMMA",
        new_string: "DELTA",
      })
      expect({ ok: second.ok, reason: second.reason }).toEqual({ ok: true, reason: undefined })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * AP-10 — ANTI-VACUUM for AP-9.
 *
 * AP-9 asserts a chained edit SUCCEEDS. That assertion is worthless on its own:
 * ripping the stale-read guard out entirely, or making `recordContent` record a
 * constant, would also make it pass. This is the paired control that fails in
 * both of those worlds — after a genuine THIRD-PARTY write the guard must still
 * deny, so AP-9 can only be green because the digest tracks the agent's own
 * write specifically.
 */
describe("AP-10 anti-vacuum — an EXTERNAL clobber is still denied", () => {
  test("read → external write → edit is denied stale_read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-clobber-"))
    try {
      const file = join(dir, "f.txt")
      writeFileSync(file, ORIGINAL)
      const state = new ReadFileState()
      expect((await driveTool(dir, state, "read", { path: file })).ok).toBe(true)

      // Someone else (another agent, the user's editor, a build step) rewrites it.
      writeFileSync(file, `${ORIGINAL}appended-by-someone-else\n`)

      const denied = await driveTool(dir, state, "edit", {
        path: file,
        old_string: "gamma",
        new_string: "GAMMA",
      })
      expect({ ok: denied.ok, reason: denied.reason }).toEqual({
        ok: false,
        reason: "stale_read",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
