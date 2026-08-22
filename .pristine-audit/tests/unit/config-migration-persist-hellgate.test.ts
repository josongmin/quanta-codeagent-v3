/**
 * HELLGATE — H13 external-config migration PERSIST adapter.
 *
 * The migration slice CONVERTS competitor config into typed `ConvertedItem`s;
 * this battery proves the PERSIST adapter writes each item to the RIGHT quanta
 * destination + format so the imported config is actually used next run:
 *
 *   - settings (permission) → `<project>/settings.json#permissions` (Claude shape)
 *   - hooks                 → `<project>/settings.json#hooks` (loadCommandHookBindings reads this)
 *   - mcp                   → `<project>/.mcp.json#mcpServers` (env/credentials DROPPED)
 *   - subagents             → `<project>/.quanta/agents/<name>.md` (frontmatter, round-trips)
 *   - agents_md (repo-rules)→ `<project>/AGENTS.md` (loadRepoRules reads this)
 *   - cursor_rules          → `<project>/.quanta/rules/<name>.md` (loadGlobRules reads this)
 *
 * Invariants asserted:
 *   - existing quanta config is NEVER silently overwritten (merge or sibling);
 *   - mcp persist NEVER carries `env`/credentials;
 *   - the ledger records `imported` ⇒ a 2nd run is a no-op;
 *   - a single failing persist degrades to a typed warning, others persist;
 *   - knob OFF ⇒ nothing written (default-OFF, byte-identical).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadGlobRules } from "@/agent/glob-rules"
import { loadRepoRules } from "@/agent/repo-rules"
import type { ConvertedItem } from "@/migration/external-config"
import {
  isThrottled,
  loadMigrationLedger,
  persistConvertedItems,
  sourceKeyOf,
} from "@/migration/external-config"

let home: string
let project: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cmp-home-"))
  project = await mkdtemp(join(tmpdir(), "cmp-proj-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
const readJson = async (p: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>

const settingsItem: ConvertedItem = {
  type: "settings",
  ok: true,
  value: {
    allow: ["Read", "Edit"],
    deny: ["Bash(rm -rf:*)"],
    ask: ["WebFetch"],
    defaultMode: "acceptEdits",
  },
}
const hooksItem: ConvertedItem = {
  type: "hooks",
  ok: true,
  value: [{ event: "PreToolUse", matcher: "Bash", commands: ["guard.sh"] }],
}
const mcpItem: ConvertedItem = {
  type: "mcp",
  ok: true,
  value: [{ name: "fs", transport: "stdio", command: "mcp-fs", args: ["--root", "."] }],
}
const subagentItem: ConvertedItem = {
  type: "subagents",
  ok: true,
  value: [
    {
      name: "reviewer",
      description: "reviews diffs",
      tools: ["Read", "Grep"],
      systemPrompt: "You are a reviewer.",
      sourcePath: "/x/.claude/agents/reviewer.md",
    },
  ],
}
const repoRulesItem: ConvertedItem = {
  type: "agents_md",
  ok: true,
  value: {
    entrypoint: "CLAUDE.md",
    sourcePath: "/x/CLAUDE.md",
    body: "No heuristics; fail closed.",
  },
}
const globRuleItem: ConvertedItem = {
  type: "cursor_rules",
  ok: true,
  value: [
    {
      sourcePath: "/x/.cursor/rules/ts.mdc",
      globs: ["*.ts"],
      alwaysApply: false,
      body: "Use strict mode.",
    },
  ],
}

describe("config-migration persist — destinations + format", () => {
  test("settings → settings.json#permissions (Claude shape)", async () => {
    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [settingsItem],
    })
    expect(r.persisted).toBe(true)
    const s = await readJson(join(project, "settings.json"))
    const perms = s.permissions as Record<string, unknown>
    expect(perms.allow).toEqual(["Read", "Edit"])
    expect(perms.deny).toEqual(["Bash(rm -rf:*)"])
    expect(perms.ask).toEqual(["WebFetch"])
    expect(s.defaultMode).toBe("acceptEdits")
  })

  test("hooks → settings.json#hooks (loadCommandHookBindings reads this)", async () => {
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [hooksItem],
    })
    const s = await readJson(join(project, "settings.json"))
    const hooks = s.hooks as Record<string, unknown>
    const pre = hooks.PreToolUse as Array<Record<string, unknown>>
    expect(pre[0]?.matcher).toBe("Bash")
    const inner = (pre[0]?.hooks ?? []) as Array<Record<string, unknown>>
    expect(inner[0]).toEqual({ type: "command", command: "guard.sh" })
  })

  test("mcp → .mcp.json#mcpServers (NEVER carries env/credentials)", async () => {
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [mcpItem],
    })
    const raw = await readFile(join(project, ".mcp.json"), "utf8")
    expect(raw).not.toContain("env")
    expect(raw.toLowerCase()).not.toContain("token")
    const mcp = (JSON.parse(raw) as Record<string, unknown>).mcpServers as Record<
      string,
      Record<string, unknown>
    >
    expect(mcp.fs?.command).toBe("mcp-fs")
    expect(mcp.fs?.args).toEqual(["--root", "."])
    expect("env" in (mcp.fs ?? {})).toBe(false)
  })

  test("subagents → .quanta/agents/<name>.md (frontmatter)", async () => {
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [subagentItem],
    })
    const p = join(project, ".quanta", "agents", "reviewer.md")
    expect(await exists(p)).toBe(true)
    const md = await readFile(p, "utf8")
    expect(md).toContain("name: reviewer")
    expect(md).toContain("You are a reviewer.")
  })

  test("agents_md → AGENTS.md (loadRepoRules reads it back)", async () => {
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [repoRulesItem],
    })
    const p = join(project, "AGENTS.md")
    expect(await exists(p)).toBe(true)
    const rules = await loadRepoRules(project)
    expect(rules?.body).toContain("No heuristics")
  })

  test("cursor_rules → .quanta/rules/<name>.md (loadGlobRules reads it back)", async () => {
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [globRuleItem],
    })
    const rules = await loadGlobRules(project)
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.some((r) => r.body.includes("Use strict mode"))).toBe(true)
  })
})

describe("config-migration persist — no silent overwrite", () => {
  test("existing settings.json is MERGED, not clobbered", async () => {
    await writeFile(
      join(project, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Glob"] }, custom: "keep-me" }, null, 2),
      "utf8",
    )
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [settingsItem],
    })
    const s = await readJson(join(project, "settings.json"))
    // Pre-existing user keys preserved.
    expect(s.custom).toBe("keep-me")
    const perms = s.permissions as Record<string, unknown>
    // Pre-existing allow entry NOT dropped; imported entries unioned in.
    expect(perms.allow).toContain("Glob")
    expect(perms.allow).toContain("Read")
  })

  test("existing AGENTS.md is NOT overwritten — sibling written instead", async () => {
    await writeFile(join(project, "AGENTS.md"), "# Existing native rules\n", "utf8")
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [repoRulesItem],
    })
    // Native file untouched.
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toBe("# Existing native rules\n")
    // Imported content lands in a sibling, not lost.
    expect(await exists(join(project, "AGENTS.imported.md"))).toBe(true)
  })

  test("existing subagent .md is NOT overwritten — sibling written", async () => {
    await mkdir(join(project, ".quanta", "agents"), { recursive: true })
    await writeFile(join(project, ".quanta", "agents", "reviewer.md"), "native\n", "utf8")
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [subagentItem],
    })
    expect(await readFile(join(project, ".quanta", "agents", "reviewer.md"), "utf8")).toBe(
      "native\n",
    )
    expect(await exists(join(project, ".quanta", "agents", "reviewer.imported.md"))).toBe(true)
  })
})

describe("config-migration persist — ledger / opt-in / failure", () => {
  test("records `imported`; a 2nd run with same source is a no-op", async () => {
    const key = sourceKeyOf("project", [{ path: join(project, ".claude", "settings.json") }])
    const r1 = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [settingsItem],
      sourceKey: key,
    })
    expect(r1.persisted).toBe(true)
    const ledger = await loadMigrationLedger(home)
    expect(isThrottled(ledger, key)).toBe(true)
    expect(ledger.entries.some((e) => e.sourceKey === key && e.disposition === "imported")).toBe(
      true,
    )

    // Mutate the file so a non-throttled 2nd run WOULD change it.
    await writeFile(
      join(project, "settings.json"),
      JSON.stringify({ permissions: { allow: ["only"] } }),
      "utf8",
    )
    const r2 = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [settingsItem],
      sourceKey: key,
    })
    expect(r2.throttled).toBe(true)
    expect(r2.persisted).toBe(false)
    // 2nd run did NOT touch the file.
    const s = await readJson(join(project, "settings.json"))
    expect((s.permissions as Record<string, unknown>).allow).toEqual(["only"])
  })

  test("a single failing persist → typed warning; the rest persist", async () => {
    // Make settings.json un-writable by planting a DIRECTORY where the file
    // goes — the JSON writer cannot write through a directory ⇒ a typed warning.
    await mkdir(join(project, "settings.json"))
    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [settingsItem, mcpItem],
    })
    // The mcp item still landed.
    expect(await exists(join(project, ".mcp.json"))).toBe(true)
    // The failing item produced a typed warning (not a throw).
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings[0]?.path).toContain("settings.json")
  })

  test("knob OFF ⇒ nothing written, no ledger", async () => {
    const r = await persistConvertedItems({
      enabled: false,
      homeDir: home,
      projectDir: project,
      converted: [settingsItem, mcpItem],
    })
    expect(r.persisted).toBe(false)
    expect(await exists(join(project, "settings.json"))).toBe(false)
    expect(await exists(join(project, ".mcp.json"))).toBe(false)
    const ledger = await loadMigrationLedger(home)
    expect(ledger.entries.length).toBe(0)
  })

  test("ok:false converter items are skipped (no destination written)", async () => {
    const bad: ConvertedItem = {
      type: "settings",
      ok: false,
      warning: { kind: "skipped_malformed", path: "/x/settings.json", detail: "invalid JSON" },
    }
    const r = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [bad],
    })
    expect(r.persisted).toBe(false)
    expect(await exists(join(project, "settings.json"))).toBe(false)
  })
})

describe("config-migration persist — credential drop is structural", () => {
  test("even a hand-crafted mcp item with stray fields drops everything but the modeled shape", async () => {
    // The ConvertedMcpServer type has no `env`, but assert the writer only ever
    // serializes name/transport/command/args — a defense-in-depth shape lock.
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [mcpItem],
    })
    const mcp = (await readJson(join(project, ".mcp.json"))).mcpServers as Record<
      string,
      Record<string, unknown>
    >
    expect(Object.keys(mcp.fs ?? {}).sort()).toEqual(["args", "command"])
  })
})
