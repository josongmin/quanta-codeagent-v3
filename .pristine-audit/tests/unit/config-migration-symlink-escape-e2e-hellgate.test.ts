/**
 * HELLGATE e2e (H2) — config-migration SYMLINK-ESCAPE / path-traversal WRITE.
 *
 * The sibling hellgates (`config-migration-persist-e2e-hellgate`,
 * `external-config-migration-e2e-hellgate`) cover code-exec guards, atomic
 * merge, corrupt-target refusal, and credential-drop — but NOT a SYMLINKED
 * destination. The READ path of this slice is already O_NOFOLLOW-hardened
 * (`readImportFile` → `refuseSymlink` / lstat, N10), yet the WRITE path
 * (`persistConvertedItems` → `writeFile`) had no symmetric guard: a competitor
 * `.claude` tree whose `settings.json` / `.mcp.json` is a SYMLINK pointing OUT
 * of the project tree (e.g. at `~/.ssh/authorized_keys`) would have `writeFile`
 * FOLLOW the link and CLOBBER the outside target — a path-traversal write.
 *
 * This file pins the WRITE-jail (and re-pins the read-jail) end-to-end:
 *
 *   1. settings.json is a symlink → outside `evil-target` ⇒ persist MUST NOT
 *      clobber the target (bytes preserved), the symlink stays a symlink, and a
 *      typed warning is surfaced (fail-closed, not silent-clobber).
 *   2. same for .mcp.json (the EXECUTABLE config — the worst clobber target).
 *   3. read path: a settings.json symlinked at `../../<sensitive>` is NOT
 *      followed for reading (no outside bytes leak into the converted output).
 *   4. a NON-symlink destination still persists normally (the guard is precise,
 *      not a blanket refusal — regression guard for over-correction).
 *
 * Hermetic + offline: the ENTIRE fixture (project tree, home, AND the symlink
 * targets) lives inside two tmpdirs. We NEVER touch a real `~/.ssh` etc — the
 * "sensitive" file is a planted decoy inside the tmp evil-target dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importExternalConfig, persistConvertedItems } from "@/migration/external-config"

const IS_WIN = process.platform === "win32"

let home: string
let project: string
let evil: string

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const isSymlink = async (p: string): Promise<boolean> => {
  try {
    return (await lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

/** A realistic, importable `.claude` tree under `project` so detect finds a
 *  settings + mcp + hooks source set. The JSON files themselves are replaced by
 *  symlinks in the individual tests; the rest of the tree makes the run real. */
const plantBaseTree = async (): Promise<void> => {
  await mkdir(join(project, ".claude", "agents"), { recursive: true })
  await writeFile(
    join(project, "CLAUDE.md"),
    "# Project rules\nNo heuristics; fail closed.",
    "utf8",
  )
  await writeFile(
    join(project, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ntools: Read\n---\nYou review diffs.",
    "utf8",
  )
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cmse-home-"))
  project = await mkdtemp(join(tmpdir(), "cmse-proj-"))
  evil = await mkdtemp(join(tmpdir(), "cmse-evil-"))
  await plantBaseTree()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
  await rm(evil, { recursive: true, force: true })
})

// ───────────────────────────────────────────────────────────────────────────
// WRITE-jail: a symlinked persist DESTINATION must NOT be followed (clobber).
// We drive the LOW-LEVEL `persistConvertedItems` directly so the test does not
// depend on detect ordering — it hands a converted item straight to the writer
// whose destination is a pre-planted symlink.
// ───────────────────────────────────────────────────────────────────────────

describe.skipIf(IS_WIN)(
  "config-migration WRITE-jail — symlinked destination is not followed",
  () => {
    test("settings.json → symlink to outside evil-target: persist must NOT clobber the target", async () => {
      // Plant a sensitive outside file + a symlink at the persist destination.
      // The decoy is VALID JSON on purpose: a non-JSON decoy would trip the
      // (incidental) corrupt-target refusal and mask the real symlink-follow
      // clobber. A valid-JSON target is read-merged-rewritten through the link
      // unless the WRITE path is O_NOFOLLOW-jailed.
      const target = join(evil, "authorized_keys.json")
      const ORIGINAL = JSON.stringify({ owner: "sensitive-config", keep: true }, null, 2)
      await writeFile(target, ORIGINAL, "utf8")
      await symlink(target, join(project, "settings.json"))

      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: project,
        sourceKey: "project:symlink-settings",
        converted: [
          {
            type: "settings",
            ok: true,
            value: { allow: ["Read", "Edit"], deny: ["Bash(rm -rf:*)"], ask: [] },
          },
        ],
      })

      // The outside target MUST be byte-for-byte intact — the whole point.
      expect(await readFile(target, "utf8")).toBe(ORIGINAL)
      // The destination is STILL a symlink (we didn't replace it with a real
      // file either — a symlink-following write would have left it a symlink
      // pointing at a now-clobbered target; a no-follow refusal leaves it as-is).
      expect(await isSymlink(join(project, "settings.json"))).toBe(true)
      // Nothing was written for this item ⇒ a typed warning, no persist.
      expect(r.writtenTypes).not.toContain("settings")
      expect(r.warnings.length).toBeGreaterThanOrEqual(1)
      expect(r.warnings.some((w) => w.path.endsWith("settings.json"))).toBe(true)
    })

    test(".mcp.json → symlink to outside evil-target: executable config target NOT clobbered", async () => {
      // Valid JSON decoy (see settings test) so the clobber is not masked by the
      // corrupt-target refusal — this is the worst target: an executable config.
      const target = join(evil, "id_rsa.json")
      const ORIGINAL = JSON.stringify({ owner: "private-config", keep: true }, null, 2)
      await writeFile(target, ORIGINAL, "utf8")
      await symlink(target, join(project, ".mcp.json"))

      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: project,
        sourceKey: "project:symlink-mcp",
        converted: [
          {
            type: "mcp",
            ok: true,
            value: [{ name: "fs", transport: "stdio", command: "mcp-fs", args: ["--root", "."] }],
          },
        ],
      })

      expect(await readFile(target, "utf8")).toBe(ORIGINAL)
      expect(await isSymlink(join(project, ".mcp.json"))).toBe(true)
      expect(r.writtenTypes).not.toContain("mcp")
      expect(r.warnings.some((w) => w.path.endsWith(".mcp.json"))).toBe(true)
    })

    test("hooks (writes to settings.json) → symlinked settings target NOT clobbered", async () => {
      // Valid JSON decoy (hooks write to settings.json — same merge-rewrite path).
      const target = join(evil, "shell-rc.json")
      const ORIGINAL = JSON.stringify({ owner: "shell-config", keep: true }, null, 2)
      await writeFile(target, ORIGINAL, "utf8")
      await symlink(target, join(project, "settings.json"))

      const r = await persistConvertedItems({
        enabled: true,
        homeDir: home,
        projectDir: project,
        sourceKey: "project:symlink-hooks",
        converted: [
          {
            type: "hooks",
            ok: true,
            value: [{ event: "PreToolUse", matcher: "Bash", commands: ["guard.sh"] }],
          },
        ],
      })

      expect(await readFile(target, "utf8")).toBe(ORIGINAL)
      expect(await isSymlink(join(project, "settings.json"))).toBe(true)
      expect(r.warnings.some((w) => w.path.endsWith("settings.json"))).toBe(true)
    })

    // End-to-end through the public importExternalConfig: a competitor tree whose
    // settings.json is a hostile symlink. The full detect→convert→persist flow
    // must leave the outside target intact.
    test("importExternalConfig end-to-end: hostile symlinked settings.json never clobbers outside file", async () => {
      // Valid JSON decoy so the corrupt-target refusal cannot mask a real follow.
      const target = join(evil, "secret.json")
      const ORIGINAL = JSON.stringify({ OWNER_API_KEY: "sk-do-not-overwrite" }, null, 2)
      await writeFile(target, ORIGINAL, "utf8")
      // Plant a real settings file under .claude so detect picks up a 'settings'
      // source, then point the DESTINATION (<project>/settings.json) at the decoy.
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Read"], deny: [] } }),
        "utf8",
      )
      await symlink(target, join(project, "settings.json"))

      const r = await importExternalConfig({ enabled: true, homeDir: home, projectDir: project })
      expect(r.ran).toBe(true)
      // The decoy outside the project tree is untouched.
      expect(await readFile(target, "utf8")).toBe(ORIGINAL)
      expect(await isSymlink(join(project, "settings.json"))).toBe(true)
    })
  },
)

// ───────────────────────────────────────────────────────────────────────────
// READ-jail (re-pin): a symlinked SOURCE that points at a sensitive file via
// `../../` must not be followed for reading — no outside bytes in the output.
// This exercises the already-present `readImportFile` no-follow on the WRITE-
// adjacent read (`readExistingJson`) path indirectly + the converter read path.
// ───────────────────────────────────────────────────────────────────────────

describe.skipIf(IS_WIN)("config-migration READ-jail — symlinked source is not traversed", () => {
  test("settings source symlinked to ../../<sensitive>: outside bytes never leak into converted output", async () => {
    const sensitive = join(evil, "private.json")
    const SECRET = JSON.stringify({ permissions: { allow: ["LEAKED-FROM-OUTSIDE"] } })
    await writeFile(sensitive, SECRET, "utf8")
    // The competitor source .claude/settings.json is a symlink pointing OUT of
    // the project tree at the sensitive file.
    await symlink(sensitive, join(project, ".claude", "settings.json"))

    const r = await importExternalConfig({ enabled: true, homeDir: home, projectDir: project })
    expect(r.ran).toBe(true)

    // No converted settings item carries the smuggled allow-token. Either the
    // symlinked source is refused (ok:false) OR it is simply absent from the
    // output — in NO case does the outside token surface.
    for (const item of r.converted) {
      if (item.type === "settings" && item.ok) {
        expect(item.value.allow).not.toContain("LEAKED-FROM-OUTSIDE")
      }
    }
    // And if a quanta settings.json was persisted, it must not contain the token.
    if (await exists(join(project, "settings.json"))) {
      const raw = await readFile(join(project, "settings.json"), "utf8")
      expect(raw).not.toContain("LEAKED-FROM-OUTSIDE")
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Regression / over-correction guard: a PLAIN (non-symlink) destination must
// STILL persist normally. The write-jail must be precise — a blanket refusal
// would break the happy path the sibling hellgates rely on.
// ───────────────────────────────────────────────────────────────────────────

describe("config-migration WRITE-jail — plain destination still persists (no over-correction)", () => {
  test("non-symlink settings.json destination is written normally", async () => {
    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      sourceKey: "project:plain-settings",
      converted: [
        {
          type: "settings",
          ok: true,
          value: { allow: ["Read"], deny: ["Bash(rm -rf:*)"], ask: [] },
        },
      ],
    })
    expect(r.writtenTypes).toContain("settings")
    const settings = JSON.parse(await readFile(join(project, "settings.json"), "utf8")) as {
      permissions: { allow: string[]; deny: string[] }
    }
    expect(settings.permissions.allow).toContain("Read")
    expect(settings.permissions.deny).toContain("Bash(rm -rf:*)")
    // No warnings on the clean happy path.
    expect(r.warnings.length).toBe(0)
  })
})
