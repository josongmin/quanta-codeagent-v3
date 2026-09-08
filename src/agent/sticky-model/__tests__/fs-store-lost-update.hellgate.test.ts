/**
 * ★ HELLGATE (MR-08 item 3) — two processes writing DIFFERENT sticky keys must
 * both survive.
 *
 * `fsBackedStickyModelStore.set`/`unset` are a read-modify-write over the WHOLE
 * map: read every key, splice one, atomically replace the file.
 * `write-file-atomic`'s tmp+rename makes a TORN write impossible; it does exactly
 * nothing about a LOST UPDATE. Two writers that read the same snapshot each
 * replace the file with their own copy of it, and the second rename erases the
 * first writer's key.
 *
 * The two writers are not hypothetical: the CLI and the web daemon are separate
 * processes over ONE `~/.quanta/sticky-model.json`, which is the entire point of
 * persisting the pick ("one user, one preference, across surfaces").
 *
 * MEASURED PRE-FIX. `LOST-1` below, run against the unlocked store, lost one of
 * the two keys in 30/30 rounds — never a torn file, always a clean file missing
 * a key, with WHICH key survived decided by the race (24 rounds kept only
 * `openai:plan`, 6 kept only `openai:default`). Post-fix the same 30 rounds keep
 * both keys, 30/30. That "always clean, always half" signature is why the atomic
 * rename was mistaken for enough.
 *
 * THE FIX under test: an `O_EXCL` lockfile (`<store>.lock`) around
 * read→mutate→rename, reusing `acquireLock`/`releaseLock` from
 * `@/permission/json-state-file/locking` — the in-repo helper built for the
 * identical read-merge-rename problem. Stale rule: a holder whose `{pid, ts}`
 * body (or, if unreadable, whose mtime) is older than `LOCK_STALE_MS` is declared
 * dead and its lockfile unlinked, so a `kill -9` mid-write wedges writers for one
 * 5s window rather than forever.
 *
 * RED-on-injection (each verified against a `cp` backup):
 *   - remove the `acquireLock` call from `mutateUnderLock`  ⇒ LOST-1 + LOST-2 red.
 *   - move the `readSnapshot` back OUTSIDE the lock          ⇒ LOST-1 red.
 *   - drop the `finally { releaseLock }`                     ⇒ NO-LEFTOVER red and
 *     LOST-1 red (the second round times out on the first round's orphan lock).
 *   - return `{ok:true}` instead of the typed error on a failed acquire
 *                                                            ⇒ TIMEOUT red.
 *
 * Hermetic: every case writes under its OWN `mkdtemp` dir, and `afterEach`
 * removes every dir this file created — a leak here is what took `ls /tmp`-shaped
 * tests over their timeout in this repo before.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { acquireLock, LOCK_STALE_MS, releaseLock } from "@/permission/json-state-file/locking"
import { fsBackedStickyModelStore, stickyModelLockPathOf } from ".."

/** Scratch registry — every dir this file makes is registered here and removed in
 *  `afterEach`, so a failing assertion cannot strand a `/private/tmp` directory. */
const scratch: string[] = []
const mkScratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mr08-sticky-lock-"))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readDisk = (path: string): Record<string, string> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, string>

const KEY_A = { mode: "default", provider: "openai" } as const
const KEY_B = { mode: "plan", provider: "openai" } as const
const BOTH = { "openai:default": "model-a", "openai:plan": "model-b" }

describe("MR-08 · fs sticky store — cross-process lost update", () => {
  test("LOST-1: 30 rounds of two instances writing different keys keep BOTH", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const rounds = 30
    const survived: number[] = []
    for (let round = 0; round < rounds; round++) {
      rmSync(path, { force: true })
      const a = fsBackedStickyModelStore({ path })
      const b = fsBackedStickyModelStore({ path })
      // Both instances start from the SAME (empty) snapshot and interleave
      // naturally — the read of one lands inside the read-modify-write of the
      // other. Pre-fix this alone was enough: 30/30 rounds lost a key.
      const [ra, rb] = await Promise.all([
        a.set({ ...KEY_A, modelId: "model-a" }),
        b.set({ ...KEY_B, modelId: "model-b" }),
      ])
      expect(ra.ok).toBe(true)
      expect(rb.ok).toBe(true)
      survived.push(Object.keys(readDisk(path)).length)
    }
    // Reported as a count rather than 30 separate assertions so a partial
    // regression ("28/30") is legible in the failure message.
    expect(survived).toEqual(new Array(rounds).fill(2))
    expect(readDisk(path)).toEqual(BOTH)
  })

  test("LOST-2: a FORCED barrier — both writers are blocked, then both land", async () => {
    // The deterministic half of LOST-1. Rather than hoping the two writers
    // interleave, the test itself takes the store's REAL lock first, so both
    // `set`s are provably parked at the critical section's door at the same
    // instant. Pre-fix there was no door: both would have completed during the
    // sleep below and the `[false, false]` assertion reds.
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const lockPath = stickyModelLockPathOf(path)
    mkdirSync(dirname(path), { recursive: true })
    expect(await acquireLock(lockPath, "hellgate-barrier", Date.now)).toBe(true)

    const a = fsBackedStickyModelStore({ path })
    const b = fsBackedStickyModelStore({ path })
    let aDone = false
    let bDone = false
    const pa = a.set({ ...KEY_A, modelId: "model-a" }).then((r) => {
      aDone = true
      return r
    })
    const pb = b.set({ ...KEY_B, modelId: "model-b" }).then((r) => {
      bDone = true
      return r
    })
    await new Promise((r) => setTimeout(r, 40))
    expect([aDone, bDone]).toEqual([false, false])
    expect(existsSync(path)).toBe(false)

    await releaseLock(lockPath)
    const [ra, rb] = await Promise.all([pa, pb])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(readDisk(path)).toEqual(BOTH)
  })

  test("LOST-3: a set racing an UNSET of another key does not resurrect or erase", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const seed = fsBackedStickyModelStore({ path })
    await seed.set({ ...KEY_A, modelId: "model-a" })
    await seed.set({ ...KEY_B, modelId: "model-b" })
    const a = fsBackedStickyModelStore({ path })
    const b = fsBackedStickyModelStore({ path })
    const [ra, rb] = await Promise.all([a.set({ ...KEY_A, modelId: "model-a2" }), b.unset(KEY_B)])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    // The removal must not carry a stale copy of `openai:default` back, and the
    // set must not resurrect the removed `openai:plan`.
    expect(readDisk(path)).toEqual({ "openai:default": "model-a2" })
  })

  test("TIMEOUT: a live peer holding the flock degrades to a typed ok:false", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const lockPath = stickyModelLockPathOf(path)
    mkdirSync(dirname(path), { recursive: true })
    expect(await acquireLock(lockPath, "hellgate-barrier", Date.now, 50)).toBe(true)
    const store = fsBackedStickyModelStore({ path })
    const startedAt = Date.now()
    const pending = store.set({ ...KEY_A, modelId: "model-a" })
    await new Promise((r) => setTimeout(r, 40))
    expect(existsSync(path)).toBe(false)
    await releaseLock(lockPath)
    const res = await pending
    expect(res.ok).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  test("STALE: a leftover lock pathname without a holder is flockable", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const lockPath = stickyModelLockPathOf(path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, ts: Date.now() - LOCK_STALE_MS * 10 }))
    const res = await fsBackedStickyModelStore({ path }).set({ ...KEY_A, modelId: "model-a" })
    expect(res.ok).toBe(true)
    expect(readDisk(path)).toEqual({ "openai:default": "model-a" })
  })

  test("STALE-2: an UNREADABLE leftover lock body is still flockable", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const lockPath = stickyModelLockPathOf(path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(lockPath, "{ truncated")
    const res = await fsBackedStickyModelStore({ path }).set({ ...KEY_A, modelId: "model-a" })
    expect(res.ok).toBe(true)
    expect(readDisk(path)).toEqual({ "openai:default": "model-a" })
  })

  test("NO-LEFTOVER: a successful set and unset each release the flock", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const store = fsBackedStickyModelStore({ path })
    expect((await store.set({ ...KEY_A, modelId: "model-a" })).ok).toBe(true)
    expect((await store.unset(KEY_A)).ok).toBe(true)
    expect((await store.set({ ...KEY_A, modelId: "model-a2" })).ok).toBe(true)
  })

  // ── behaviours the lock must not have broken (paired controls) ────────────
  test("KEEP-1: a corrupt file is still preserved to .corrupt.bak before overwrite", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    writeFileSync(path, "{ this is not json ::::")
    const res = await fsBackedStickyModelStore({ path }).set({ ...KEY_A, modelId: "model-a" })
    expect(res.ok).toBe(true)
    expect(readFileSync(`${path}.corrupt.bak`, "utf8")).toBe("{ this is not json ::::")
    expect(readDisk(path)).toEqual({ "openai:default": "model-a" })
  })

  test("KEEP-2: removing the LAST key leaves a valid {} file, never an unlink", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const store = fsBackedStickyModelStore({ path })
    await store.set({ ...KEY_A, modelId: "model-a" })
    expect((await store.unset(KEY_A)).ok).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readDisk(path)).toEqual({})
  })

  test("KEEP-3: an idempotent unset on a first-run machine touches NOTHING", async () => {
    const dir = mkScratch()
    // A directory that does not exist yet: if `unset` acquired the lock (or even
    // just `mkdir -p`-ed) before deciding it had nothing to do, this dir would
    // appear on a machine that never had a preference.
    const path = join(dir, "never-existed", "sticky-model.json")
    const res = await fsBackedStickyModelStore({ path }).unset(KEY_A)
    expect(res.ok).toBe(true)
    expect(existsSync(dirname(path))).toBe(false)
  })

  test("KEEP-4: an unset of an ABSENT key in an EXISTING file leaves the file byte-identical", async () => {
    const dir = mkScratch()
    const path = join(dir, "sticky-model.json")
    const store = fsBackedStickyModelStore({ path })
    await store.set({ ...KEY_A, modelId: "model-a" })
    const before = readFileSync(path, "utf8")
    expect((await store.unset(KEY_B)).ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe(before)
  })
})
