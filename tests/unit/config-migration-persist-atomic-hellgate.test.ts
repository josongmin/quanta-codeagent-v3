/**
 * HELLGATE — config-migration JSON writers: ATOMIC commit + SINGLE-resolution
 * destination (jun-10 silent-failure audit #17).
 *
 * The settings.json / .mcp.json merge writers (`persistSettings` /
 * `persistHooks` / `persistMcp`) used to commit with a plain truncating
 * `writeFile`:
 *   - a crash mid-write left a TORN file which the next run's
 *     `readExistingJson` classifies "corrupt" and permanently refuses to touch
 *     — the user's audited permissions / MCP servers never self-heal;
 *   - the symlink check (`lstat`) and the write re-walked the path
 *     INDEPENDENTLY — a symlink planted between check and write was FOLLOWED
 *     (TOCTOU path-traversal write).
 *
 * Fixed shape under test: the destination is resolved ONCE (realpath of the
 * parent dir + leaf), the symlink check + existing-state read + atomic
 * temp+rename all operate on that SAME resolved path, and the rename REPLACES
 * (never follows) any leaf symlink.
 *
 * Injection here is "write cannot complete": with the parent dir read-only,
 * the OLD truncating write still succeeded (file write-perm suffices for
 * O_TRUNC on an existing file) and replaced the user's file, while the atomic
 * temp+rename cannot create its temp and must REFUSE with a typed warning,
 * leaving the old bytes byte-identical — a true red-on-injection differential
 * with zero new prod seams. Hermetic: every path lives in tmpdirs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfigWriteSync } from "@/migration/external-config"
import { persistConvertedItems } from "@/migration/external-config"

const IS_WIN = process.platform === "win32"
// Root bypasses directory write-permission checks — the read-only-dir
// injection arm is meaningless under uid 0 (visible skip, not silent pass).
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0

const configEntries = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((name) => !name.endsWith(".lock"))

let home = ""
let project = ""
let outside = ""

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cmpa-home-"))
  project = await mkdtemp(join(tmpdir(), "cmpa-proj-"))
  outside = await mkdtemp(join(tmpdir(), "cmpa-out-"))
})

afterEach(async () => {
  // Restore perms first — rm on a 0o555 dir's children fails otherwise.
  await chmod(project, 0o755).catch(() => undefined)
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const SETTINGS_ITEM = {
  type: "settings",
  ok: true,
  value: { allow: ["Read"], deny: ["Bash(rm -rf:*)"], ask: [] },
} as const

const HOOKS_ITEM = {
  type: "hooks",
  ok: true,
  value: [{ event: "PreToolUse", matcher: "Bash", commands: ["guard.sh"] }],
} as const

const MCP_ITEM = {
  type: "mcp",
  ok: true,
  value: [{ name: "fs", transport: "stdio", command: "mcp-fs", args: ["--root", "."] }],
} as const

describe.skipIf(IS_WIN || IS_ROOT)(
  "config-migration ATOMIC commit — a write that cannot complete leaves the old config byte-identical",
  () => {
    test("settings.json: read-only parent dir → typed warning, OLD bytes intact (no truncation window)", async () => {
      const path = join(project, "settings.json")
      const ORIGINAL = `${JSON.stringify({ permissions: { allow: ["Keep"] }, peer: true }, null, 2)}\n`
      await writeFile(path, ORIGINAL, "utf8")
      await chmod(project, 0o555)

      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: project,
        converted: [SETTINGS_ITEM],
      })
      await chmod(project, 0o755)

      // The pre-fix truncating writeFile SUCCEEDED here (file write-perm is
      // enough for O_TRUNC) and replaced the user's file — red-on-injection.
      expect(await readFile(path, "utf8")).toBe(ORIGINAL)
      expect(r.writtenTypes).not.toContain("settings")
      expect(r.warnings.some((w) => w.path.endsWith("settings.json"))).toBe(true)
    })

    test("hooks (settings.json writer): read-only parent dir → typed warning, OLD bytes intact", async () => {
      const path = join(project, "settings.json")
      const ORIGINAL = `${JSON.stringify({ hooks: { Stop: [] }, peer: "keep" }, null, 2)}\n`
      await writeFile(path, ORIGINAL, "utf8")
      await chmod(project, 0o555)

      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: project,
        converted: [HOOKS_ITEM],
      })
      await chmod(project, 0o755)

      expect(await readFile(path, "utf8")).toBe(ORIGINAL)
      expect(r.writtenTypes).not.toContain("hooks")
      expect(r.warnings.some((w) => w.path.endsWith("settings.json"))).toBe(true)
    })

    test(".mcp.json: read-only parent dir → typed warning, OLD bytes intact (executable config)", async () => {
      const path = join(project, ".mcp.json")
      const ORIGINAL = `${JSON.stringify(
        { mcpServers: { keepme: { command: "keep-server", args: ["--safe"] } } },
        null,
        2,
      )}\n`
      await writeFile(path, ORIGINAL, "utf8")
      await chmod(project, 0o555)

      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: project,
        converted: [MCP_ITEM],
      })
      await chmod(project, 0o755)

      expect(await readFile(path, "utf8")).toBe(ORIGINAL)
      expect(r.writtenTypes).not.toContain("mcp")
      expect(r.warnings.some((w) => w.path.endsWith(".mcp.json"))).toBe(true)
    })
  },
)

describe.skipIf(IS_WIN)("config-migration SINGLE-resolution destination (TOCTOU close)", () => {
  test("symlinked projectDir: write lands at the RESOLVED real target via one up-front resolution", async () => {
    // The project path handed in goes THROUGH a directory symlink. The writer
    // must resolve it ONCE and then check+read+write the SAME resolved real
    // path — never re-walking the symlinked path between check and write.
    const realProj = await mkdtemp(join(tmpdir(), "cmpa-real-"))
    const linkProj = join(outside, "proj-link")
    await symlink(realProj, linkProj)
    try {
      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: linkProj,
        converted: [SETTINGS_ITEM],
      })

      expect(r.writtenTypes).toContain("settings")
      expect(r.warnings).toEqual([])
      // Fresh readback at the RESOLVED real path — the bytes landed at the
      // target the single resolution chose.
      const raw = await readFile(join(realProj, "settings.json"), "utf8")
      const parsed = JSON.parse(raw) as { permissions: { allow: string[] } }
      expect(parsed.permissions.allow).toContain("Read")
      // The committed file is a REGULAR file (rename replaced, never linked)…
      expect((await lstat(join(realProj, "settings.json"))).isSymbolicLink()).toBe(false)
      // …and the atomic temp was renamed away, not leaked next to the config.
      expect(await configEntries(realProj)).toEqual(["settings.json"])
    } finally {
      await rm(realProj, { recursive: true, force: true })
    }
  })

  test("leaf symlink posture UNCHANGED by the rework: symlinked settings.json is still REFUSED", async () => {
    // Guards the resolver against over-resolution: realpath-ing the FULL path
    // (leaf included) would dereference a hostile leaf symlink and write at
    // its outside target — the exact escape the write-jail refuses. Only the
    // PARENT may be resolved; the leaf check must still see the symlink.
    const target = join(outside, "authorized_keys.json")
    const ORIGINAL = JSON.stringify({ owner: "sensitive", keep: true }, null, 2)
    await writeFile(target, ORIGINAL, "utf8")
    await symlink(target, join(project, "settings.json"))

    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [SETTINGS_ITEM],
    })

    expect(await readFile(target, "utf8")).toBe(ORIGINAL)
    expect((await lstat(join(project, "settings.json"))).isSymbolicLink()).toBe(true)
    expect(r.writtenTypes).not.toContain("settings")
    expect(r.warnings.some((w) => w.path.endsWith("settings.json"))).toBe(true)
  })

  test("happy path (plain dir) still merges + leaves no temp residue", async () => {
    const path = join(project, "settings.json")
    await writeFile(
      path,
      `${JSON.stringify({ permissions: { allow: ["Existing"] }, peer: 7 }, null, 2)}\n`,
      "utf8",
    )

    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [SETTINGS_ITEM],
    })

    expect(r.writtenTypes).toContain("settings")
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      permissions: { allow: string[] }
      peer: number
    }
    // Merge semantics preserved: union of allow, peer keys intact.
    expect(parsed.permissions.allow).toEqual(["Existing", "Read"])
    expect(parsed.peer).toBe(7)
    expect(await configEntries(project)).toEqual(["settings.json"])
  })
})

// ─── D15: fsync DURABILITY barrier (parity with import-log) ─────────────────
//
// D10 brought `writeJsonAtomic` to parity with the slice's sibling import-log
// writer: an INJECTABLE durability barrier (`syncFile` BEFORE the rename,
// `syncDir` AFTER it). The barrier is fail-CLOSED: if `syncFile` rejects (a
// simulated crash at the fsync point), the rename is SKIPPED, the partial temp
// is cleaned up, and the user's ORIGINAL config survives byte-identical — the
// torn-file regression D10 fixed can never re-appear. A paired control proves
// the real barrier merges + flushes in the right order.
describe("config-migration fsync barrier (D15 — durability parity, injectable seam)", () => {
  test("syncFile rejects (crash at the fsync barrier): typed warning, ORIGINAL bytes intact, no temp residue", async () => {
    const path = join(project, "settings.json")
    const ORIGINAL = `${JSON.stringify({ permissions: { allow: ["Keep"] }, peer: true }, null, 2)}\n`
    await writeFile(path, ORIGINAL, "utf8")

    const order: string[] = []
    const crashingSync: ConfigWriteSync = {
      syncFile: async () => {
        order.push("syncFile")
        throw new Error("injected crash: fsync barrier")
      },
      syncDir: async () => {
        order.push("syncDir")
      },
    }

    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [SETTINGS_ITEM],
      writeSync: crashingSync,
    })

    // The barrier fired and aborted BEFORE any dir flush (rename skipped).
    expect(order).toEqual(["syncFile"])
    // Fail-closed: original survives byte-for-byte, nothing recorded written.
    expect(await readFile(path, "utf8")).toBe(ORIGINAL)
    expect(r.writtenTypes).not.toContain("settings")
    expect(r.warnings.some((w) => w.path.endsWith("settings.json"))).toBe(true)
    // No leaked atomic temp next to the config.
    const residue = (await readdir(project)).filter((n) => n.includes(".quanta-tmp-"))
    expect(residue).toEqual([])
    expect(await configEntries(project)).toEqual(["settings.json"])
  })

  test("paired control: real barrier succeeds → merges + flushes in order [syncFile, syncDir]", async () => {
    const path = join(project, "settings.json")
    await writeFile(
      path,
      `${JSON.stringify({ permissions: { allow: ["Existing"] }, peer: 7 }, null, 2)}\n`,
      "utf8",
    )

    const order: string[] = []
    const realOrdered: ConfigWriteSync = {
      syncFile: async () => {
        order.push("syncFile")
      },
      syncDir: async () => {
        order.push("syncDir")
      },
    }

    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [SETTINGS_ITEM],
      writeSync: realOrdered,
    })

    // Same fsync ordering invariant the import-log writer asserts: temp flush
    // BEFORE rename, dir flush AFTER.
    expect(order).toEqual(["syncFile", "syncDir"])
    expect(r.writtenTypes).toContain("settings")
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      permissions: { allow: string[] }
      peer: number
    }
    expect(parsed.permissions.allow).toEqual(["Existing", "Read"])
    expect(parsed.peer).toBe(7)
    expect(await configEntries(project)).toEqual(["settings.json"])
  })
})
