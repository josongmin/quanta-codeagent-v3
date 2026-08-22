/**
 * HELLGATE — `~/.quanta/knobs.json` persistence: ATOMIC commit + MERGE-on-save.
 *
 * jun-10 silent-failure audit:
 *   - #19: `writeKnobConfig` used a plain truncating `writeFile`; a crash
 *     mid-write left a torn knobs.json which the (in-contract) read side
 *     collapses to `null` — silently resetting the user to "never saved
 *     defaults". The fix routes the commit through `@/storage` writeFileAtomic
 *     (ADR-0398 temp+rename), with the fsync barrier exposed as an INJECTION
 *     seam so this file can prove the crash window: a write whose durability
 *     barrier fails must leave the previous COMPLETE file untouched.
 *   - #18 (helper): `saveKnobConfigMerged` is the merge-on-save primitive the
 *     `/knobs save` surfaces use — a fresh read of the persisted user_defaults
 *     is the base and THIS process's overrides overlay it, so a second
 *     session's save can never wipe the first session's saved knobs.
 *
 * House rules exercised here: real observable effects (fresh readback of the
 * actual file), red-on-injection (the crashing-sync arm fails against a
 * truncating write), paired control (same write with the real barrier
 * succeeds — proves the seam sits on the live path, not a test-only fork).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readKnobConfig, saveKnobConfigMerged, writeKnobConfig } from "@/runner/knobs"
import type { AtomicWriteSync } from "@/storage"

const IS_WIN = process.platform === "win32"

let dir = ""
let file = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knobs-atomic-"))
  file = join(dir, "knobs.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Fault-injection durability barrier: the temp-file fsync rejects, which per
 *  the writeFileAtomic contract MUST abort the commit before the rename. */
const crashingSync: AtomicWriteSync = {
  syncFile: () => Promise.reject(new Error("injected crash: fsync barrier")),
  syncDir: () => Promise.resolve(),
}

describe("writeKnobConfig — crash-mid-write leaves the OLD complete file intact (audit #19)", () => {
  test("injected barrier crash → write REJECTS and the previous file survives byte-identical", async () => {
    await writeKnobConfig({ persona: "friendly" }, file)
    const before = await readFile(file, "utf8")

    await expect(writeKnobConfig({ persona: "WIPED" }, file, crashingSync)).rejects.toThrow(
      "injected crash",
    )

    // Fresh readback: readers still see the OLD complete file — not a torn
    // half-write that the read contract would collapse to null.
    expect(await readFile(file, "utf8")).toBe(before)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({ persona: "friendly" })
  })

  test("paired control: the same write with the REAL barrier succeeds (seam is on the live path)", async () => {
    await writeKnobConfig({ persona: "friendly" }, file)
    await writeKnobConfig({ persona: "pragmatic" }, file)
    expect((await readKnobConfig(file))?.user_defaults).toEqual({ persona: "pragmatic" })
  })

  test("aborted commit leaves NO temp residue next to the config", async () => {
    await writeKnobConfig({ a: "1" }, file)
    await expect(writeKnobConfig({ b: "2" }, file, crashingSync)).rejects.toThrow("injected crash")
    expect(await readdir(dir)).toEqual(["knobs.json"])
  })

  test.skipIf(IS_WIN)(
    "first-ever write lands at exactly 0o600 (no transient default-perms window)",
    async () => {
      await writeKnobConfig({ k: "v" }, file)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    },
  )

  test.skipIf(IS_WIN)(
    "re-write of an existing config keeps 0o600 across the temp+rename",
    async () => {
      await writeKnobConfig({ k: "v" }, file)
      await writeKnobConfig({ k: "w" }, file)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    },
  )
})

describe("saveKnobConfigMerged — two sessions' saves BOTH survive (audit #18)", () => {
  test("sequential sessions saving DIFFERENT knobs merge — exact map, fresh readback", async () => {
    // Session 1 saves persona; session 2 (a fresh process whose bag never saw
    // persona) saves working-state. Both must survive — the pre-fix wholesale
    // replace left only the second.
    await saveKnobConfigMerged({ persona: "friendly" }, file)
    await saveKnobConfigMerged({ "working-state": "1" }, file)

    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({ persona: "friendly", "working-state": "1" })
  })

  test("conflicting key: the SAVING process's value wins", async () => {
    await saveKnobConfigMerged({ persona: "friendly", lsp: "1" }, file)
    await saveKnobConfigMerged({ persona: "pragmatic" }, file)

    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({ persona: "pragmatic", lsp: "1" })
  })

  test("empty bag save is a content no-op for prior saves (the audit's exact wipe scenario)", async () => {
    await saveKnobConfigMerged({ persona: "friendly" }, file)
    // A session that set nothing runs `/knobs save` — must NOT wipe.
    await saveKnobConfigMerged({}, file)
    expect((await readKnobConfig(file))?.user_defaults).toEqual({ persona: "friendly" })
  })

  test("corrupt existing file degrades to overrides-only (read contract: corrupt ⇒ null, unchanged)", async () => {
    await writeFile(file, "{torn-json", "utf8")
    await saveKnobConfigMerged({ a: "1" }, file)
    expect((await readKnobConfig(file))?.user_defaults).toEqual({ a: "1" })
  })

  test("crash-mid-merged-save also leaves the old file intact (atomicity composes)", async () => {
    await saveKnobConfigMerged({ persona: "friendly" }, file)
    const before = await readFile(file, "utf8")
    await expect(saveKnobConfigMerged({ persona: "WIPED" }, file, crashingSync)).rejects.toThrow(
      "injected crash",
    )
    expect(await readFile(file, "utf8")).toBe(before)
  })
})
