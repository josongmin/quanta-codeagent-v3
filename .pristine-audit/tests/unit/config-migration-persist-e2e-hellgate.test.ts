/**
 * HELLGATE e2e — H13 external-config migration full PERSIST flow.
 *
 * Plants a realistic `.claude/` + `.cursor/` tree, runs detect→convert→persist
 * (opted in) via `importExternalConfig`, then proves the quanta config files
 * EXIST and a fresh config-load reads them back:
 *   - `<project>/settings.json` parses (permissions + hooks),
 *   - `loadCommandHookBindings` reads the imported hooks,
 *   - `loadRepoRules` reads the imported AGENTS.md,
 *   - `loadGlobRules` reads the imported Cursor rules,
 *   - `.mcp.json` exists and carries NO credentials/env,
 *   - a subagent spec `.md` exists under `.quanta/agents`.
 * A SECOND run is throttled (ledger `imported`) ⇒ no re-persist.
 * Knob OFF ⇒ nothing written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCommandHookBindings } from "@/agent/command-hooks"
import { loadGlobRules } from "@/agent/glob-rules"
import { loadRepoRules } from "@/agent/repo-rules"
import { importExternalConfig, loadMigrationLedger } from "@/migration/external-config"

let home: string
let project: string

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const plantTree = async (): Promise<void> => {
  await mkdir(join(project, ".claude", "agents"), { recursive: true })
  await writeFile(
    join(project, "CLAUDE.md"),
    "# Project rules\nNo heuristics; fail closed.",
    "utf8",
  )
  await writeFile(
    join(project, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Read", "Edit"], deny: ["Bash(rm -rf:*)"] },
      defaultMode: "acceptEdits",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    }),
    "utf8",
  )
  await writeFile(
    join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fs: { command: "mcp-fs", args: ["--root", "."], env: { SECRET_TOKEN: "abc123" } },
      },
    }),
    "utf8",
  )
  await writeFile(
    join(project, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews diffs\ntools: Read, Grep\n---\nYou are a reviewer.",
    "utf8",
  )
  await mkdir(join(project, ".cursor", "rules"), { recursive: true })
  await writeFile(
    join(project, ".cursor", "rules", "ts.mdc"),
    "---\nglobs: '*.ts'\n---\nUse strict mode.",
    "utf8",
  )
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cmpe-home-"))
  project = await mkdtemp(join(tmpdir(), "cmpe-proj-"))
  await plantTree()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe("config-migration persist e2e", () => {
  test("detect→convert→persist (opted in) ⇒ quanta config exists + reads back", async () => {
    const r = await importExternalConfig({ enabled: true, homeDir: home, projectDir: project })
    expect(r.ran).toBe(true)
    expect(r.persisted).toBe(true)

    // settings.json exists + parses (permissions + hooks).
    expect(await exists(join(project, "settings.json"))).toBe(true)
    const settings = JSON.parse(await readFile(join(project, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >
    const perms = settings.permissions as Record<string, unknown>
    expect(perms.allow).toContain("Read")
    expect(perms.deny).toContain("Bash(rm -rf:*)")

    // hooks read back via the real loader.
    const bindings = await loadCommandHookBindings(join(project, "settings.json"))
    expect(bindings.some((b) => b.event === "PreToolUse" && b.command === "guard.sh")).toBe(true)

    // repo-rules read back via the real loader.
    const rules = await loadRepoRules(project)
    expect(rules?.body).toContain("No heuristics")

    // glob-rules read back via the real loader.
    const glob = await loadGlobRules(project)
    expect(glob.some((g) => g.body.includes("Use strict mode"))).toBe(true)

    // mcp persisted WITHOUT the secret env.
    const mcpRaw = await readFile(join(project, ".mcp.json"), "utf8")
    expect(mcpRaw).not.toContain("SECRET_TOKEN")
    expect(mcpRaw).not.toContain("abc123")

    // subagent spec exists.
    expect(await exists(join(project, ".quanta", "agents", "reviewer.md"))).toBe(true)
  })

  test("2nd run is throttled — no re-persist (ledger imported)", async () => {
    const r1 = await importExternalConfig({ enabled: true, homeDir: home, projectDir: project })
    expect(r1.persisted).toBe(true)
    const ledger = await loadMigrationLedger(home)
    expect(ledger.entries.some((e) => e.disposition === "imported")).toBe(true)

    // Corrupt the imported settings so a non-throttled re-run would rewrite it.
    await writeFile(join(project, "settings.json"), "{}", "utf8")
    const r2 = await importExternalConfig({ enabled: true, homeDir: home, projectDir: project })
    expect(r2.throttled).toBe(true)
    expect(r2.persisted).toBe(false)
    expect(await readFile(join(project, "settings.json"), "utf8")).toBe("{}")
  })

  test("knob OFF ⇒ no detect, no persist, no ledger (byte-identical)", async () => {
    const r = await importExternalConfig({ enabled: false, homeDir: home, projectDir: project })
    expect(r.ran).toBe(false)
    expect(r.persisted).toBe(false)
    // Native quanta files NOT created (settings.json / AGENTS.md absent).
    expect(await exists(join(project, "settings.json"))).toBe(false)
    expect(await exists(join(project, "AGENTS.md"))).toBe(false)
    const ledger = await loadMigrationLedger(home)
    expect(ledger.entries.length).toBe(0)
  })
})
