/**
 * Hellgate — the memory plane follows QUANTA_HOME, like every other plane.
 *
 * `QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta` is the one home root. Sessions,
 * knobs, snooze state and the session registry all resolve under it. Memory did not:
 * `resolveMemoryDirPaths(homedir = os.homedir())` joined an OS home with
 * `.quanta/memory`, and three call sites passed `os.homedir()` or `env.HOME`.
 *
 * Measured before the fix, with QUANTA_HOME pointed at a scratch dir:
 *
 *   quantaHomeDir()    /tmp/qh.XXXX
 *   sessions index     /tmp/qh.XXXX/sessions/index.jsonl
 *   memory store       /Users/<me>/.quanta/memory/memory.sqlite    <- not relocated
 *
 * So a run that believed it was isolated opened the developer's real store, and
 * `tests/_support/hermetic-quanta-home.ts` — the repo's own isolation helper — was
 * not hermetic for memory. That helper needed no change; the plane did.
 *
 * NOT a migration: `quantaHomeDirFrom({})` is `~/.quanta`, so with the env unset the
 * resolved root is byte-identical to the old one. That equality is asserted below,
 * because it is the property that makes the change safe for existing installs.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { resolveMemoryDirPathsUnder } from "@/memory/consolidate/paths"
import { defaultDurableStorePath } from "@/memory/store-path"
import { buildMemoryForSession } from "@/runner/assemble/memory-factory"
import { quantaHomeDirFrom } from "@/shared/quanta-home"
import { hermeticQuantaHomeEnv } from "../../_support/hermetic-quanta-home"

const storeFor = (env: NodeJS.ProcessEnv): string => defaultDurableStorePath(quantaHomeDirFrom(env))

describe("the memory plane follows the quanta home", () => {
  test("an unset home resolves to the pre-existing default, byte for byte", () => {
    const expected = join(homedir(), ".quanta", "memory", "memory.sqlite")
    expect(storeFor({}), "changing this default would silently orphan every install").toBe(expected)
    expect(resolveMemoryDirPathsUnder(quantaHomeDirFrom({})).root).toBe(
      join(homedir(), ".quanta", "memory"),
    )
  })

  test("QUANTA_HOME relocates the store", () => {
    expect(storeFor({ QUANTA_HOME: "/tmp/relocated" })).toBe("/tmp/relocated/memory/memory.sqlite")
  })

  test("QUANTA_CONFIG_DIR wins over QUANTA_HOME, same precedence as every other plane", () => {
    expect(storeFor({ QUANTA_HOME: "/tmp/h", QUANTA_CONFIG_DIR: "/tmp/c" })).toBe(
      "/tmp/c/memory/memory.sqlite",
    )
  })

  /** `HOME` is the OS home. It used to win here and must not: it is not the quanta
   *  home, and reading it is what made memory the odd plane out. */
  test("HOME does NOT relocate the store", () => {
    const under = storeFor({ HOME: "/tmp/os-home" })
    expect(under).not.toContain("/tmp/os-home")
    expect(under).toBe(storeFor({}))
  })

  /**
   * The repo's own isolation helper must isolate MEMORY, not just sessions. It sets
   * only `QUANTA_CONFIG_DIR`; before the plane was fixed that left the store in the
   * real home while every other path moved, so a suite could pass the
   * `real-quanta-home-escape-ratchet` and still open the developer's store.
   */
  test("hermeticQuantaHomeEnv isolates the memory store", () => {
    const env = hermeticQuantaHomeEnv({}, "memory-follows-home")
    const p = storeFor(env)
    expect(p.startsWith(join(homedir(), ".quanta")), `not hermetic: ${p}`).toBe(false)
    expect(p).toContain("/memory/memory.sqlite")
  })

  /**
   * WIRING PROOF — through the real composition root, not the pure helper.
   *
   * Every assertion above calls `defaultDurableStorePath(quantaHomeDirFrom(env))`
   * directly. Measured: restoring `env.HOME` precedence inside
   * `resolveSessionStorePath` left all of them GREEN, because none of them goes
   * through the factory. `buildMemoryForSession` is what production calls and what
   * reports `storePath`, so it is what has to be asserted.
   */
  test("buildMemoryForSession resolves the store under the quanta home, not HOME", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mem-home-"))
    const decoy = mkdtempSync(join(tmpdir(), "mem-decoy-"))
    const cwd = mkdtempSync(join(tmpdir(), "mem-cwd-"))
    try {
      const slot = buildMemoryForSession(
        { QUANTA_MEMORY: "sqlite", QUANTA_HOME: scratch, HOME: decoy },
        { cwd, onStoreNotice: () => {} },
      )
      expect(slot.kind).toBe("sqlite")
      expect(slot.storePath, `HOME leaked into the store path: ${slot.storePath}`).not.toContain(
        decoy,
      )
      expect(slot.storePath).toBe(join(scratch, "memory", "memory.sqlite"))
      // …and the file really was opened there, so this is not a label-only check.
      expect(existsSync(join(scratch, "memory", "memory.sqlite"))).toBe(true)
      // `PersistentStorePort` has no close(); the sqlite handle is released when the
      // process exits. The scratch dir is removed either way, which is what keeps
      // this arm from leaking into /tmp.
    } finally {
      for (const d of [scratch, decoy, cwd]) rmSync(d, { recursive: true, force: true })
    }
  })

  /** ANTI-VACUITY: the helper under test must actually be doing the join, or every
   *  assertion above could be satisfied by a function that returns a constant. */
  test("the resolver is a function of its argument", () => {
    expect(resolveMemoryDirPathsUnder("/a").root).toBe(join("/a", "memory"))
    expect(resolveMemoryDirPathsUnder("/b").root).toBe(join("/b", "memory"))
    expect(() => resolveMemoryDirPathsUnder("")).toThrow(/non-empty/)
  })
})
