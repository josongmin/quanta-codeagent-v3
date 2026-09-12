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
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveMemoryDirPathsUnder } from "@/memory/consolidate/paths"
import { defaultDurableStorePath, resolveStorePath } from "@/memory/store-path"
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

  /**
   * NO SILENT ORPHAN — the property that makes the relocation safe for an operator who
   * ALREADY set QUANTA_HOME or QUANTA_CONFIG_DIR.
   *
   * Measured before this existed: with `QUANTA_CONFIG_DIR` set and months of memory at
   * `<os-home>/.quanta/memory/memory.sqlite`, `resolveStorePath` returned
   * `source: "home-default"`, `legacyNotice: undefined`, and never probed the old path
   * at all. A fresh empty store, silently, for the one operator the relocation was
   * most likely to affect. The `legacyNotice` machinery already existed for the
   * cwd-scoped case and was not extended to the case the fix itself created.
   */
  test("an existing store under the PRE-RELOCATION home is used, and named", () => {
    const osHome = mkdtempSync(join(tmpdir(), "mem-oshome-"))
    const relocated = mkdtempSync(join(tmpdir(), "mem-reloc-"))
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "existing memory")
      const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
      // The path stays under the home the operator ASKED for. Returning the old file
      // instead would be the split-brain again, inverted — a session whose QUANTA_HOME
      // says one place secretly reading another — and it broke every suite that
      // injects a scratch home.
      expect(r.path).toBe(join(relocated, "memory", "memory.sqlite"))
      expect(r.source).toBe("home-default")
      expect(r.legacyNotice, "an orphan must be attributed, not silent").toBeDefined()
      expect(r.legacyNotice).toContain(prior)
      expect(r.legacyNotice).toContain(join(relocated, "memory", "memory.sqlite"))
      expect(r.legacyNotice, "the operator must be told it is not being read").toContain(
        "NOT being read",
      )
      // The migration command must move the WAL side files too. Moving the database
      // out from under an uncheckpointed log loses whatever was not checkpointed —
      // silent data loss in the line written to prevent silent data loss.
      expect(r.legacyNotice).toContain("-wal")
      expect(r.legacyNotice).toContain("-shm")
    } finally {
      for (const d of [osHome, relocated]) rmSync(d, { recursive: true, force: true })
    }
  })

  /**
   * The notice fires ONLY while the destination is absent, and its command cannot
   * clobber.
   *
   * Measured on the first version: the notice re-fired on every launch (3 of 3), launch
   * 1 CREATES the destination, and the printed bare `mv` then replaced the new session's
   * store with the old one — real fixture, destination held `NEW-SESSION-DATA`, ran the
   * command, destination became `OLD-MONTHS-OF-DATA`. The same silent data loss the
   * helper was written to prevent, one level up.
   */
  test("no notice once this home has its own store — a `mv` would destroy the newer one", () => {
    const osHome = mkdtempSync(join(tmpdir(), "mem-both-"))
    const relocated = mkdtempSync(join(tmpdir(), "mem-both2-"))
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "old months of data")
      const dest = join(relocated, "memory", "memory.sqlite")
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, "this session's data")
      const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
      expect(r.path).toBe(dest)
      expect(
        r.legacyNotice,
        "recommending a `mv` onto an existing store is how the newer one gets destroyed",
      ).toBeUndefined()
    } finally {
      for (const d of [osHome, relocated]) rmSync(d, { recursive: true, force: true })
    }
  })

  test("the migration command is no-clobber and exits 0 when there are no side files", () => {
    const osHome = mkdtempSync(join(tmpdir(), "mem-cmd-"))
    const relocated = mkdtempSync(join(tmpdir(), "mem-cmd2-"))
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "OLD")
      const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
      const cmd = /running\): (.+)$/.exec(r.legacyNotice ?? "")?.[1]
      expect(cmd, "the notice must carry a runnable command").toBeDefined()
      // RUN IT, twice, against real files — a string assertion is not enough. A
      // `toContain("mv -n")` is satisfied by the side-file loop while the MAIN move is
      // still a clobbering bare `mv`, which is exactly how that mutant survived.
      //
      // Pass 1: no side files, empty destination — the case that used to exit 1 with
      // the migration complete.
      const res = spawnSync("sh", ["-c", cmd as string], { encoding: "utf8" })
      expect(res.status, `exit ${res.status}: ${res.stderr}`).toBe(0)
      expect(readFileSync(join(relocated, "memory", "memory.sqlite"), "utf8")).toBe("OLD")

      // Pass 2: the destination now EXISTS and holds this session's data, and the old
      // path has data again. The command must not replace it.
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "OLD-AGAIN")
      writeFileSync(join(relocated, "memory", "memory.sqlite"), "THIS-SESSION")
      spawnSync("sh", ["-c", cmd as string], { encoding: "utf8" })
      expect(
        readFileSync(join(relocated, "memory", "memory.sqlite"), "utf8"),
        "the command clobbered the newer store",
      ).toBe("THIS-SESSION")
    } finally {
      for (const d of [osHome, relocated]) rmSync(d, { recursive: true, force: true })
    }
  })

  test("with the home UNSET the probe is inert — no notice, no behaviour change", () => {
    const osHome = mkdtempSync(join(tmpdir(), "mem-same-"))
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "existing memory")
      // `quantaHomeDirFrom({})` is `<os-home>/.quanta`, so the two paths coincide.
      const r = resolveStorePath({
        homeDir: join(osHome, ".quanta"),
        cwd: "/nonexistent-cwd",
        osHomeDir: osHome,
      })
      expect(r.source, "coinciding paths must not be reported as a legacy find").toBe(
        "home-default",
      )
      expect(r.legacyNotice).toBeUndefined()
      expect(r.path).toBe(prior)
    } finally {
      rmSync(osHome, { recursive: true, force: true })
    }
  })

  test("the cwd-scoped legacy file still wins over the pre-relocation one", () => {
    const osHome = mkdtempSync(join(tmpdir(), "mem-osh2-"))
    const cwd = mkdtempSync(join(tmpdir(), "mem-cwd2-"))
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "home data")
      const legacy = join(cwd, ".quanta", "memory.sqlite")
      mkdirSync(dirname(legacy), { recursive: true })
      writeFileSync(legacy, "cwd data")
      const r = resolveStorePath({ homeDir: "/tmp/relocated", cwd, osHomeDir: osHome })
      expect(r.source).toBe("legacy-cwd")
      expect(r.path).toBe(legacy)
    } finally {
      for (const d of [osHome, cwd]) rmSync(d, { recursive: true, force: true })
    }
  })

  /** WIRING PROOF for the probe: the factory must actually inject the OS home. */
  test("buildMemoryForSession injects the OS home so the probe can fire", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mem-wire-"))
    const cwd = mkdtempSync(join(tmpdir(), "mem-wcwd-"))
    try {
      const notices: string[] = []
      // A relocated home with no prior store: the probe runs and finds nothing, so the
      // resolution is the ordinary home default and no notice fires.
      const slot = buildMemoryForSession(
        { QUANTA_MEMORY: "sqlite", QUANTA_HOME: scratch },
        { cwd, onStoreNotice: (l) => notices.push(l) },
      )
      // The resolution is always the relocated home, notice or not.
      expect(slot.storePath).toBe(join(scratch, "memory", "memory.sqlite"))
      // On a developer box the real `~/.quanta/memory/memory.sqlite` usually exists,
      // so the probe fires and emits ONE notice. Either way the path is unchanged —
      // that invariant is what this arm pins, not the notice count.
      for (const n of notices) expect(n).toContain("NOT being read")
      // The injection itself is asserted at the source: without `osHomeDir` the probe
      // is skipped entirely and an orphan is silent again.
      const factory = readFileSync(
        join(import.meta.dir, "..", "..", "..", "src/runner/assemble/memory-factory.ts"),
        "utf8",
      )
      expect(factory, "the factory must inject the OS home for the probe").toContain(
        "osHomeDir: homedir()",
      )
    } finally {
      for (const d of [scratch, cwd]) rmSync(d, { recursive: true, force: true })
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
