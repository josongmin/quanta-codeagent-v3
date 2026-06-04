/**
 * HELLGATE e2e — H13 external-config migration full flow.
 *
 * Plants a realistic `.claude/` + `.cursor/` tree in a tmp dir, runs the
 * detect+import flow with the knob ON, and asserts:
 *   - the quanta-format outputs are produced (settings/hooks/mcp/subagents/
 *     repo-rules/glob-rules),
 *   - the throttle marker is written,
 *   - a SECOND run is throttled (no re-offer),
 *   - knob OFF ⇒ nothing happens (no detect, no ledger write — byte-identical).
 *
 * `runConfigMigration` is the pure orchestration seam (no process.env, no
 * homedir() — every path is injected) so the e2e is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runConfigMigration } from "@/migration/external-config"

let home: string
let project: string

const plantRealisticTree = async (): Promise<void> => {
  // Project Claude Code config.
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
    JSON.stringify({ mcpServers: { fs: { command: "mcp-fs", args: ["--root", "."] } } }),
    "utf8",
  )
  await writeFile(
    join(project, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews diffs\ntools: Read, Grep\n---\nYou are a reviewer.",
    "utf8",
  )
  // Cursor rules.
  await mkdir(join(project, ".cursor", "rules"), { recursive: true })
  await writeFile(
    join(project, ".cursor", "rules", "ts.mdc"),
    "---\nglobs: '*.ts'\n---\nUse strict mode.",
    "utf8",
  )
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "h13-e2e-home-"))
  project = await mkdtemp(join(tmpdir(), "h13-e2e-proj-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe("runConfigMigration — knob ON", () => {
  test("detects + converts every planted type, records 'offered', throttles 2nd run", async () => {
    await plantRealisticTree()

    const r1 = await runConfigMigration({ enabled: true, homeDir: home, projectDir: project })
    expect(r1.ran).toBe(true)
    expect(r1.throttled).toBe(false)
    expect(r1.inventory.items.length).toBeGreaterThanOrEqual(6)

    // Quanta-format outputs produced for each kind.
    const byType = new Map(r1.converted.map((c) => [c.type, c]))
    expect(byType.get("settings")?.ok).toBe(true)
    expect(byType.get("hooks")?.ok).toBe(true)
    expect(byType.get("mcp")?.ok).toBe(true)
    expect(byType.get("subagents")?.ok).toBe(true)
    expect(byType.get("agents_md")?.ok).toBe(true)
    expect(byType.get("cursor_rules")?.ok).toBe(true)

    // Throttle marker written under ~/.quanta.
    const quantaDir = await readdir(join(home, ".quanta"))
    expect(quantaDir.some((f) => f.includes("config_migration"))).toBe(true)

    // 2nd run: throttled, no re-offer.
    const r2 = await runConfigMigration({ enabled: true, homeDir: home, projectDir: project })
    expect(r2.ran).toBe(true)
    expect(r2.throttled).toBe(true)
    // When throttled we still report what WOULD be there, but mark it suppressed.
    expect(r2.converted.length).toBe(0)
  })

  test("nothing planted ⇒ ran but empty inventory, no ledger row", async () => {
    const r = await runConfigMigration({ enabled: true, homeDir: home, projectDir: project })
    expect(r.ran).toBe(true)
    expect(r.inventory.items).toEqual([])
    expect(r.throttled).toBe(false)
    // No prompt-worthy items ⇒ no ledger write.
    const dir = await readdir(join(home, ".quanta")).catch(() => [] as string[])
    expect(dir.some((f) => f.includes("config_migration"))).toBe(false)
  })
})

describe("runConfigMigration — knob OFF (default)", () => {
  test("nothing happens: no detect, no ledger, byte-identical no-op", async () => {
    await plantRealisticTree()
    const r = await runConfigMigration({ enabled: false, homeDir: home, projectDir: project })
    expect(r.ran).toBe(false)
    expect(r.inventory.items).toEqual([])
    expect(r.converted).toEqual([])
    expect(r.throttled).toBe(false)
    // No ~/.quanta dir created.
    const exists = await readdir(join(home, ".quanta")).then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)
  })
})
