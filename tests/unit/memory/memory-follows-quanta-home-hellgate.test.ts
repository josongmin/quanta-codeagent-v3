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

import { Database } from "bun:sqlite"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveMemoryDirPathsUnder } from "@/memory/consolidate/paths"
import { defaultDurableStorePath, resolveStorePath } from "@/memory/store-path"
import { buildMemoryForSession } from "@/runner/assemble/memory-factory"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import { quantaHomeDirFrom } from "@/shared/quanta-home"
import { makeTempDirOwner } from "../../_helpers/temp-dir"
import {
  cleanupHermeticQuantaHomes,
  hermeticQuantaHomeEnv,
} from "../../_support/hermetic-quanta-home"

const storeFor = (env: NodeJS.ProcessEnv): string => defaultDurableStorePath(quantaHomeDirFrom(env))

/** Every scratch dir is OWNED, so it is removed even when an assertion throws before a
 *  test's own `finally` runs. The tmp-leak ratchet flagged thirteen bare `mkdtempSync`
 *  sites here; the per-test `for (const d of [...]) rmSync(d)` cleanup is a form its
 *  checker does not recognise, and the owner is the shape the repo standardises on. */
const temps = makeTempDirOwner()
afterEach(() => temps.disposeAll())
afterAll(() => cleanupHermeticQuantaHomes())

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
    const scratch = temps.create("mem-home-")
    const decoy = temps.create("mem-decoy-")
    const cwd = temps.create("mem-cwd-")
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
   * NO SILENT ORPHAN, AND A NOTICE THAT STAYS ACTIONABLE.
   *
   * Two designs failed here, both measured.
   *  1. No probe: with `QUANTA_CONFIG_DIR` set and months of memory at
   *     `<os-home>/.quanta/memory/memory.sqlite`, the resolution returned a fresh empty
   *     store and no notice.
   *  2. Notice only, resolution under the relocated home: opening that path CREATED the
   *     destination on the launch that printed the notice. The notice therefore fired
   *     exactly once, and the `mv -n` it recommended then found a destination already
   *     there, skipped, and exited 0 — the old store orphaned, reported as success.
   *     An adversarial audit reproduced it through the real factory: launch 1 notice,
   *     launch 2 silent, command exit 0, 40 old rows left behind, new store holding 1.
   *
   * Now the existing store is read IN PLACE — the same answer the cwd-scoped legacy
   * store has always had — so no second store is created, the notice repeats every
   * launch until the operator migrates, and the command stays valid until they do.
   */
  const sqliteWithRows = (file: string, rows: number): void => {
    mkdirSync(dirname(file), { recursive: true })
    const db = new Database(file, { create: true })
    db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)")
    for (let i = 0; i < rows; i++) db.run("INSERT INTO t (v) VALUES (?)", [`row-${i}`])
    db.close()
  }
  const rowCount = (file: string): number => {
    const db = new Database(file, { readonly: true })
    try {
      return (db.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n
    } finally {
      db.close()
    }
  }
  const commandOf = (notice: string | undefined): string | undefined =>
    /running\): (.+)$/.exec(notice ?? "")?.[1]

  test("an existing pre-relocation store is read in place, and the notice carries a migration", () => {
    const osHome = temps.create("mem-oshome-")
    const relocated = temps.create("mem-reloc-")
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      mkdirSync(dirname(prior), { recursive: true })
      writeFileSync(prior, "existing memory")
      const dest = join(relocated, "memory", "memory.sqlite")
      const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
      expect(r.path, "the existing store must be read where it is").toBe(prior)
      expect(r.source).toBe("pre-relocation-home")
      // The notice names the two memory DIRECTORIES — the unit that moves.
      expect(r.legacyNotice).toContain(dirname(prior))
      expect(r.legacyNotice).toContain(dirname(dest))
      expect(commandOf(r.legacyNotice), "the notice must carry a runnable command").toBeDefined()
      // The whole memory DIRECTORY moves — the WAL/SHM and the consolidator's files with it.
      expect(commandOf(r.legacyNotice)).toContain(
        `mv '${join(osHome, ".quanta", "memory")}' '${join(relocated, "memory")}'`,
      )
    } finally {
      for (const d of [osHome, relocated]) rmSync(d, { recursive: true, force: true })
    }
  })

  test("THROUGH THE FACTORY: two launches before migrating create no second store and both notify", () => {
    const osHome = temps.create("mem-launch-")
    const relocated = temps.create("mem-launch2-")
    const cwd = temps.create("mem-launch-cwd-")
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      const dest = join(relocated, "memory", "memory.sqlite")
      sqliteWithRows(prior, 40)
      const env = { QUANTA_MEMORY: "sqlite", QUANTA_HOME: relocated, HOME: osHome }
      for (const launch of [1, 2]) {
        const notices: string[] = []
        const slot = buildMemoryForSession(env, { cwd, onStoreNotice: (l) => notices.push(l) })
        expect(slot.storePath, `launch ${launch} opened the wrong store`).toBe(prior)
        expect(notices.length, `launch ${launch} was silent`).toBe(1)
        expect(existsSync(dest), `launch ${launch} created a second store`).toBe(false)
      }
    } finally {
      for (const d of [osHome, relocated, cwd]) rmSync(d, { recursive: true, force: true })
    }
  })

  test("RUN the command: it migrates real rows, and the next launch is silent and relocated", () => {
    const osHome = temps.create("mem-run-")
    const relocated = temps.create("mem-run2-")
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      const dest = join(relocated, "memory", "memory.sqlite")
      sqliteWithRows(prior, 40)
      writeFileSync(`${prior}-wal`, "")
      // The consolidator's files live in the same directory and must travel too.
      writeFileSync(join(dirname(prior), "MEMORY.md"), "# prior memory\n")
      writeFileSync(join(dirname(prior), "memory_summary.md"), "- prior hint\n")
      const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
      const res = spawnSync("sh", ["-c", commandOf(r.legacyNotice) as string], { encoding: "utf8" })
      expect(res.status, `exit ${res.status}: ${res.stderr}`).toBe(0)
      expect(rowCount(dest), "rows did not arrive").toBe(40)
      expect(existsSync(prior), "the old store is still there").toBe(false)
      expect(existsSync(`${dest}-wal`), "the WAL side file did not travel").toBe(true)
      expect(readFileSync(join(relocated, "memory", "MEMORY.md"), "utf8")).toBe("# prior memory\n")
      expect(existsSync(join(relocated, "memory", "memory_summary.md"))).toBe(true)
      const after = resolveStorePath({
        homeDir: relocated,
        cwd: "/nonexistent-cwd",
        osHomeDir: osHome,
      })
      expect(after).toEqual({ path: dest, source: "home-default" })
    } finally {
      for (const d of [osHome, relocated]) rmSync(d, { recursive: true, force: true })
    }
  })

  test("the command REFUSES — non-zero, nothing moved — when the destination or its WAL exists", () => {
    // `mv -n` exited 0 on a skip and still moved the side files: measured with real
    // SQLite, the new store went from 5 rows to 50 OLD rows via the carried WAL.
    for (const occupied of ["", "-wal"]) {
      const osHome = temps.create("mem-refuse-")
      const relocated = temps.create("mem-refuse2-")
      try {
        const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
        const dest = join(relocated, "memory", "memory.sqlite")
        sqliteWithRows(prior, 50)
        writeFileSync(`${prior}-wal`, "OLD-WAL")
        const cmd = commandOf(
          resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
            .legacyNotice,
        ) as string
        if (occupied === "") sqliteWithRows(dest, 5)
        else {
          mkdirSync(dirname(dest), { recursive: true })
          writeFileSync(`${dest}-wal`, "NEWER")
        }
        const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8" })
        expect(res.status, `occupied "${occupied}" must refuse`).not.toBe(0)
        expect(res.stderr).toContain("nothing moved")
        expect(rowCount(prior), "the old store was touched").toBe(50)
        expect(readFileSync(`${prior}-wal`, "utf8"), "the old WAL moved").toBe("OLD-WAL")
        if (occupied === "") expect(rowCount(dest), "the newer store was changed").toBe(5)
        else expect(readFileSync(`${dest}-wal`, "utf8")).toBe("NEWER")
      } finally {
        for (const d of [osHome, relocated]) rmSync(d, { recursive: true, force: true })
      }
    }
  })

  test("an EMPTY destination directory does not block the migration; a non-empty one does", () => {
    const osHome = temps.create("mem-emptydest-")
    const relocated = temps.create("mem-emptydest2-")
    const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
    sqliteWithRows(prior, 4)
    const cmd = commandOf(
      resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
        .legacyNotice,
    ) as string
    // Something created `<home>/memory/` and put nothing in it.
    mkdirSync(join(relocated, "memory"), { recursive: true })
    const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8" })
    expect(res.status, `exit ${res.status}: ${res.stderr}`).toBe(0)
    expect(rowCount(join(relocated, "memory", "memory.sqlite"))).toBe(4)
    // Paired control: a destination holding anything at all is refused.
    const osHome2 = temps.create("mem-fulldest-")
    const relocated2 = temps.create("mem-fulldest2-")
    sqliteWithRows(join(osHome2, ".quanta", "memory", "memory.sqlite"), 4)
    const cmd2 = commandOf(
      resolveStorePath({ homeDir: relocated2, cwd: "/nonexistent-cwd", osHomeDir: osHome2 })
        .legacyNotice,
    ) as string
    mkdirSync(join(relocated2, "memory"), { recursive: true })
    writeFileSync(join(relocated2, "memory", "MEMORY.md"), "newer")
    const refused = spawnSync("sh", ["-c", cmd2], { encoding: "utf8" })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain("nothing moved")
    expect(rowCount(join(osHome2, ".quanta", "memory", "memory.sqlite"))).toBe(4)
  })

  test("THE CONSOLIDATOR follows the same decision: it reads the unmigrated home's files in place", async () => {
    const osHome = temps.create("mem-auto-")
    const relocated = temps.create("mem-auto2-")
    const priorDir = join(osHome, ".quanta", "memory")
    sqliteWithRows(join(priorDir, "memory.sqlite"), 2)
    writeFileSync(join(priorDir, "memory_summary.md"), "- prior hint\n")
    const llm = { stream: async function* () {} } as never
    const env = { QUANTA_HOME: relocated, HOME: osHome }
    const before = await buildSessionMemoryAutoWires({ env, llm, sessionId: "auto-reloc" })
    try {
      expect(before?.memorySummaryMd, "the consolidator split from the store").toBe(
        "- prior hint\n",
      )
      expect(existsSync(join(relocated, "memory")), "a second memory directory was created").toBe(
        false,
      )
    } finally {
      before?.dispose()
    }
    // Paired control: once the directory is migrated, the relocated home is used.
    const cmd = commandOf(
      resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
        .legacyNotice,
    ) as string
    expect(spawnSync("sh", ["-c", cmd], { encoding: "utf8" }).status).toBe(0)
    writeFileSync(join(relocated, "memory", "memory_summary.md"), "- migrated hint\n")
    const after = await buildSessionMemoryAutoWires({ env, llm, sessionId: "auto-reloc-2" })
    try {
      expect(after?.memorySummaryMd).toBe("- migrated hint\n")
    } finally {
      after?.dispose()
    }
  })

  test("hostile directory names are data, not shell", () => {
    // Paths used to sit inside DOUBLE quotes: a legacy cwd named `$(touch PWNED)` created
    // PWNED when the notice was pasted.
    for (const hostile of [
      "$(touch PWNED_SUB)",
      "`touch PWNED_TICK`",
      '"; touch PWNED_DQ; echo "',
      "proj$HOME",
      "it's",
    ]) {
      const root = temps.create("mem-hostile-")
      try {
        const cwd = join(root, hostile)
        const legacy = join(cwd, ".quanta", "memory.sqlite")
        sqliteWithRows(legacy, 3)
        const home = join(root, "qhome")
        const r = resolveStorePath({ homeDir: home, cwd })
        const res = spawnSync("sh", ["-c", commandOf(r.legacyNotice) as string], {
          encoding: "utf8",
          cwd: root,
        })
        expect(res.status, `${hostile}: exit ${res.status} ${res.stderr}`).toBe(0)
        expect(rowCount(join(home, "memory", "memory.sqlite")), hostile).toBe(3)
        const markers = spawnSync("find", [root, "-name", "PWNED*"], { encoding: "utf8" }).stdout
        expect(markers, `${hostile} executed`).toBe("")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  test("two stores: the session keeps this home's, and the notice recommends nothing destructive", () => {
    const osHome = temps.create("mem-both-")
    const relocated = temps.create("mem-both2-")
    const cwd = temps.create("mem-both-cwd-")
    try {
      const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
      const dest = join(relocated, "memory", "memory.sqlite")
      sqliteWithRows(prior, 7)
      sqliteWithRows(dest, 2)
      const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
      expect(r.path).toBe(dest)
      expect(r.legacyNotice, "an orphan must still be named").toContain(dirname(prior))
      // No store-only redirect: QUANTA_MEMORY_PATH alone would split the store from the
      // consolidator, which stays on this home (round 9: following that advice did).
      expect(r.legacyNotice).not.toContain("QUANTA_MEMORY_PATH=")
      expect(
        commandOf(r.legacyNotice),
        "no command may be offered onto an existing store",
      ).toBeUndefined()
      expect(r.legacyNotice).not.toContain("mv ")
      // The legacy-cwd store gets the same treatment when the home store exists too.
      const legacy = join(cwd, ".quanta", "memory.sqlite")
      sqliteWithRows(legacy, 1)
      const l = resolveStorePath({ homeDir: relocated, cwd })
      expect(l.path).toBe(legacy)
      expect(commandOf(l.legacyNotice)).toBeUndefined()
      expect(l.legacyNotice).toContain(dest)
    } finally {
      for (const d of [osHome, relocated, cwd]) rmSync(d, { recursive: true, force: true })
    }
  })

  /**
   * One file under two spellings is ONE store. The notice above tells the operator to
   * remove the store the session is not using; when the two paths alias, that is the
   * store the session IS using.
   */
  test("aliased paths to one store are one store: no TWO-stores notice, no removal advice", () => {
    const osHome = temps.create("mem-alias-")
    const cwd = temps.create("mem-alias-cwd-")
    const prior = join(osHome, ".quanta", "memory", "memory.sqlite")
    sqliteWithRows(prior, 3)
    // A dotfiles-style QUANTA_HOME: a symlink to the OS home's own `.quanta`.
    const linked = join(temps.create("mem-alias-link-"), "quanta")
    symlinkSync(join(osHome, ".quanta"), linked)
    const viaLink = resolveStorePath({ homeDir: linked, cwd, osHomeDir: osHome })
    expect(viaLink.legacyNotice).toBeUndefined()
    expect(viaLink.source).toBe("home-default")
    // The macOS alias: `/tmp` and `/var` are symlinks into `/private`, so the same
    // directory has a second spelling.
    if (process.platform === "darwin" && /^\/(?:tmp|var)\//.test(osHome)) {
      const aliased = resolveStorePath({
        homeDir: join(`/private${osHome}`, ".quanta"),
        cwd,
        osHomeDir: osHome,
      })
      expect(aliased.legacyNotice).toBeUndefined()
    }
    // …and two genuinely different files still get the notice (paired control).
    const other = temps.create("mem-alias-other-")
    sqliteWithRows(join(other, "memory", "memory.sqlite"), 1)
    const two = resolveStorePath({ homeDir: other, cwd, osHomeDir: osHome })
    expect(two.legacyNotice).toContain("TWO memory directories exist")
  })

  test("a legacy cwd store that is the SAME file as the home store is not a second store", () => {
    // Claims audit: only the pre-relocation branch's alias check was tested; removing the
    // legacy branch's `sameFile` check passed every memory suite.
    const home = temps.create("mem-legacy-alias-")
    const cwd = temps.create("mem-legacy-alias-cwd-")
    const store = join(home, "memory", "memory.sqlite")
    sqliteWithRows(store, 2)
    mkdirSync(join(cwd, ".quanta"), { recursive: true })
    symlinkSync(store, join(cwd, ".quanta", "memory.sqlite"))
    const r = resolveStorePath({ homeDir: home, cwd })
    expect(r).toEqual({ path: store, source: "home-default" })
  })

  test("a relocated home with consolidator files and no store is NOT abandoned for the old store", () => {
    // Deciding by the sqlite alone, this home's MEMORY.md and stage-1 data were orphaned the
    // moment its store was missing and the old home still had one (round-9 audit).
    const osHome = temps.create("mem-md-only-")
    const relocated = temps.create("mem-md-only2-")
    sqliteWithRows(join(osHome, ".quanta", "memory", "memory.sqlite"), 3)
    mkdirSync(join(relocated, "memory"), { recursive: true })
    writeFileSync(join(relocated, "memory", "MEMORY.md"), "# relocated memory\n")
    const r = resolveStorePath({ homeDir: relocated, cwd: "/nonexistent-cwd", osHomeDir: osHome })
    expect(r.source).toBe("home-default")
    expect(r.path).toBe(join(relocated, "memory", "memory.sqlite"))
    expect(r.legacyNotice).toContain("TWO memory directories exist")
  })

  test("with the home UNSET the probe is inert — no notice, no behaviour change", () => {
    const osHome = temps.create("mem-same-")
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
      expect(r).toEqual({ path: prior, source: "home-default" })
    } finally {
      rmSync(osHome, { recursive: true, force: true })
    }
  })

  test("the cwd-scoped legacy file still wins over the pre-relocation one", () => {
    const osHome = temps.create("mem-osh2-")
    const cwd = temps.create("mem-cwd2-")
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

  test("the factory takes the OS home from the injected env, never homedir()", () => {
    // Because a found pre-relocation store is now read IN PLACE, the probe's reach
    // decides whose store a session opens. `homedir()` answers the developer's real home
    // and cannot be redirected inside a running bun process, so a suite relocating only
    // QUANTA_HOME would have opened the real store.
    const relocated = temps.create("mem-nohome-")
    const cwd = temps.create("mem-nohome-cwd-")
    try {
      const notices: string[] = []
      const slot = buildMemoryForSession(
        { QUANTA_MEMORY: "sqlite", QUANTA_HOME: relocated },
        { cwd, onStoreNotice: (l) => notices.push(l) },
      )
      expect(slot.storePath, "no HOME in the env must mean no probe").toBe(
        join(relocated, "memory", "memory.sqlite"),
      )
      expect(notices).toEqual([])
      const factory = readFileSync(
        join(import.meta.dir, "..", "..", "..", "src/runner/assemble/memory-factory.ts"),
        "utf8",
      )
      expect(factory).toContain("osHomeDir: env.HOME")
      expect(factory).not.toMatch(/osHomeDir:\s*homedir\(\)/)
    } finally {
      for (const d of [relocated, cwd]) rmSync(d, { recursive: true, force: true })
    }
  })

  test("hermeticQuantaHomeEnv pins HOME, so the probe cannot reach the developer's store", () => {
    const env = hermeticQuantaHomeEnv(process.env, "memory-probe-fence")
    expect(env.HOME, "HOME must be a scratch dir").not.toBe(homedir())
    expect(env.HOME?.startsWith(tmpdir())).toBe(true)
    expect(env.QUANTA_CONFIG_DIR).not.toBe(env.HOME)
  })

  /** ANTI-VACUITY: the helper under test must actually be doing the join, or every
   *  assertion above could be satisfied by a function that returns a constant. */
  test("the resolver is a function of its argument", () => {
    expect(resolveMemoryDirPathsUnder("/a").root).toBe(join("/a", "memory"))
    expect(resolveMemoryDirPathsUnder("/b").root).toBe(join("/b", "memory"))
    expect(() => resolveMemoryDirPathsUnder("")).toThrow(/non-empty/)
  })
})
