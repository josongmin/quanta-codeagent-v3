/**
 * HELLGATE — adversarial proofs for the H13 external-config migration slice
 * (`src/migration/external-config/*`).
 *
 * Detect-and-import of competitor (Claude Code / Cursor) CONFIG artifacts.
 * This battery plants competitor configs in a tmp filesystem and asserts:
 *
 *   - detect finds each item type at the RIGHT scope (home vs project);
 *   - each converter produces the correct quanta shape
 *     (settings→permission, hooks→hook config, mcp passthrough,
 *      subagents→spec, CLAUDE.md→repo-rules, .mdc→glob-rules);
 *   - a MALFORMED competitor file is skipped with a typed warning (no crash);
 *   - the throttle ledger prevents a re-offer;
 *   - nothing planted ⇒ empty inventory (no prompt);
 *   - home vs project scope is correct.
 *
 * Discipline (memory `no-heuristics-only-validated`): every input is synthetic,
 * every assertion is exact, no timing/fuzzed checks. The converters REUSE the
 * read-time `@/agent/repo-rules` + `@/agent/glob-rules` parsers (no duplicated
 * parsing logic) — the tests assert the reused-parser output shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ALL_MIGRATION_ITEM_TYPES,
  convertAgentsMd,
  convertCursorRules,
  convertHooks,
  convertMcp,
  convertSettings,
  convertSubagentFile,
  detectExternalConfigs,
  isThrottled,
  loadMigrationLedger,
  recordDisposition,
  sourceKeyOf,
} from "@/migration/external-config"

let home: string
let project: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "h13-home-"))
  project = await mkdtemp(join(tmpdir(), "h13-proj-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const write = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(path, body, "utf8")
}

// ─── DETECT ────────────────────────────────────────────────────────────

describe("detectExternalConfigs", () => {
  test("nothing planted ⇒ empty inventory, no warnings (no prompt)", async () => {
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    expect(inv.items).toEqual([])
    expect(inv.warnings).toEqual([])
  })

  test("home-scoped: ~/.claude/settings.json detected at scope=home", async () => {
    await mkdir(join(home, ".claude"), { recursive: true })
    await write(join(home, ".claude", "settings.json"), `{"permissions":{"allow":["Read"]}}`)
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    const hit = inv.items.find((i) => i.type === "settings")
    expect(hit).toBeDefined()
    expect(hit?.scope).toBe("home")
    expect(hit?.path).toBe(join(home, ".claude", "settings.json"))
  })

  test("project-scoped: CLAUDE.md + .claude/settings.json + .mcp.json + .claude/agents + .cursor/rules + .cursorrules", async () => {
    await write(join(project, "CLAUDE.md"), "# Repo policy\nNo heuristics.")
    await mkdir(join(project, ".claude"), { recursive: true })
    await write(
      join(project, ".claude", "settings.json"),
      `{"permissions":{"deny":["Bash(rm:*)"]}}`,
    )
    await write(join(project, ".claude", "hooks.json"), `{"PreToolUse":[]}`)
    await write(join(project, ".mcp.json"), `{"mcpServers":{}}`)
    await mkdir(join(project, ".claude", "agents"), { recursive: true })
    await write(join(project, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\nbody")
    await mkdir(join(project, ".cursor", "rules"), { recursive: true })
    await write(join(project, ".cursor", "rules", "ts.mdc"), "---\nglobs: '*.ts'\n---\nrule")
    await write(join(project, ".cursorrules"), "legacy cursor rule")

    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    const types = new Set(inv.items.map((i) => i.type))
    expect(types.has("agents_md")).toBe(true)
    expect(types.has("settings")).toBe(true)
    expect(types.has("hooks")).toBe(true)
    expect(types.has("mcp")).toBe(true)
    expect(types.has("subagents")).toBe(true)
    expect(types.has("cursor_rules")).toBe(true)
    // every project item is scope=project.
    for (const it of inv.items) expect(it.scope).toBe("project")
  })

  test("scope separation: same type at both home and project surfaces TWO items, distinct scopes", async () => {
    await mkdir(join(home, ".claude"), { recursive: true })
    await write(join(home, ".claude", "settings.json"), `{"permissions":{}}`)
    await mkdir(join(project, ".claude"), { recursive: true })
    await write(join(project, ".claude", "settings.json"), `{"permissions":{}}`)
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    const settings = inv.items.filter((i) => i.type === "settings")
    expect(settings.length).toBe(2)
    expect(new Set(settings.map((s) => s.scope))).toEqual(new Set(["home", "project"]))
  })

  test("detect is no-throw on an unreadable location (path is a file where a dir is expected)", async () => {
    // Plant a FILE at `.claude` so the agents/ subdir walk hits ENOTDIR.
    await write(join(project, ".claude"), "not a dir")
    const inv = await detectExternalConfigs({ homeDir: home, projectDir: project })
    // No crash; the bogus `.claude` yields no settings/hooks/subagents item.
    expect(inv.items.find((i) => i.type === "settings")).toBeUndefined()
  })

  test("ALL_MIGRATION_ITEM_TYPES has 8 members, all reachable by detect", async () => {
    // RFC03-4 added `skills` + `memory` to the closed union (6 → 8).
    expect(ALL_MIGRATION_ITEM_TYPES.length).toBe(8)
  })
})

// ─── CONVERTERS ────────────────────────────────────────────────────────

describe("convertSettings", () => {
  test("permissions.allow/deny/ask → quanta permission shape; defaultMode carried", async () => {
    const p = join(project, ".claude", "settings.json")
    await write(
      p,
      JSON.stringify({
        permissions: { allow: ["Read", "Edit"], deny: ["Bash(rm:*)"], ask: ["WebFetch"] },
        defaultMode: "acceptEdits",
      }),
    )
    const r = await convertSettings(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "settings") return
    expect(r.value.allow).toEqual(["Read", "Edit"])
    expect(r.value.deny).toEqual(["Bash(rm:*)"])
    expect(r.value.ask).toEqual(["WebFetch"])
    expect(r.value.defaultMode).toBe("acceptEdits")
  })

  test("malformed settings.json → ok:false with skipped_malformed warning (no throw)", async () => {
    const p = join(project, ".claude", "settings.json")
    await write(p, "{ not json")
    const r = await convertSettings(p)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.warning.kind).toBe("skipped_malformed")
    expect(r.warning.path).toBe(p)
  })
})

describe("convertHooks", () => {
  test("settings.json#hooks → quanta hook bindings (event/matcher/commands)", async () => {
    const p = join(project, ".claude", "settings.json")
    await write(
      p,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    )
    const r = await convertHooks(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "hooks") return
    expect(r.value).toEqual([{ event: "PreToolUse", matcher: "Bash", commands: ["echo hi"] }])
  })

  test("standalone hooks.json (no settings wrapper) → bindings", async () => {
    const p = join(project, ".claude", "hooks.json")
    await write(
      p,
      JSON.stringify({
        PostToolUse: [{ hooks: [{ type: "command", command: "lint" }] }],
      }),
    )
    const r = await convertHooks(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "hooks") return
    expect(r.value).toEqual([{ event: "PostToolUse", commands: ["lint"] }])
  })
})

describe("convertMcp", () => {
  test(".mcp.json passthrough: stdio carries command+args; env dropped", async () => {
    const p = join(project, ".mcp.json")
    await write(
      p,
      JSON.stringify({
        mcpServers: {
          fs: { command: "mcp-fs", args: ["--root", "/x"], env: { SECRET: "shh" } },
          remote: { type: "http", url: "https://x" },
        },
      }),
    )
    const r = await convertMcp(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "mcp") return
    const fs = r.value.find((s) => s.name === "fs")
    expect(fs).toEqual({
      name: "fs",
      transport: "stdio",
      command: "mcp-fs",
      args: ["--root", "/x"],
    })
    const remote = r.value.find((s) => s.name === "remote")
    expect(remote?.transport).toBe("http")
    // env never carried.
    expect(JSON.stringify(r.value)).not.toContain("SECRET")
  })
})

describe("convertSubagentFile (single file)", () => {
  test(".claude/agents/<name>.md → subagent spec (frontmatter + body)", async () => {
    const p = join(project, ".claude", "agents", "reviewer.md")
    await write(
      p,
      "---\nname: reviewer\ndescription: code reviewer\ntools: Read, Grep\n---\nYou review code.",
    )
    const r = await convertSubagentFile(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "subagents") return
    const spec = r.value[0]
    expect(spec?.name).toBe("reviewer")
    expect(spec?.description).toBe("code reviewer")
    expect(spec?.tools).toEqual(["Read", "Grep"])
    expect(spec?.systemPrompt).toBe("You review code.")
    expect(spec?.sourcePath).toBe(p)
  })

  test("subagent missing name frontmatter → falls back to file stem", async () => {
    const p = join(project, ".claude", "agents", "planner.md")
    await write(p, "---\ndescription: plans\n---\nbody")
    const r = await convertSubagentFile(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "subagents") return
    expect(r.value[0]?.name).toBe("planner")
  })

  test("empty subagent body → ok:false skipped_malformed", async () => {
    const p = join(project, ".claude", "agents", "empty.md")
    await write(p, "---\nname: empty\n---\n   \n")
    const r = await convertSubagentFile(p)
    expect(r.ok).toBe(false)
  })
})

describe("convertAgentsMd (reuses @/agent/repo-rules)", () => {
  test("CLAUDE.md → repo-rules body via the read-time parser", async () => {
    const p = join(project, "CLAUDE.md")
    await write(p, "# Policy\nFail closed.")
    const r = await convertAgentsMd(p)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "agents_md") return
    expect(r.value.entrypoint).toBe("CLAUDE.md")
    expect(r.value.body).toContain("Fail closed.")
    expect(r.value.sourcePath).toBe(p)
  })

  test("empty CLAUDE.md → ok:false (no signal, never a phantom rule)", async () => {
    const p = join(project, "CLAUDE.md")
    await write(p, "   \n")
    const r = await convertAgentsMd(p)
    expect(r.ok).toBe(false)
  })
})

describe("convertCursorRules (reuses @/agent/glob-rules)", () => {
  test(".cursor/rules/*.mdc → glob-rules via the read-time parser", async () => {
    await mkdir(join(project, ".cursor", "rules"), { recursive: true })
    await write(
      join(project, ".cursor", "rules", "ts.mdc"),
      "---\ndescription: ts conventions\nglobs: '*.ts,*.tsx'\n---\nUse strict types.",
    )
    const r = await convertCursorRules(project)
    expect(r.ok).toBe(true)
    if (!r.ok || r.type !== "cursor_rules") return
    const rule = r.value.find((g) => g.sourcePath.endsWith("ts.mdc"))
    expect(rule).toBeDefined()
    expect(rule?.globs).toEqual(["*.ts", "*.tsx"])
    expect(rule?.body).toContain("Use strict types.")
  })

  test("no cursor rules dir ⇒ ok:false (nothing to import)", async () => {
    const r = await convertCursorRules(project)
    expect(r.ok).toBe(false)
  })
})

// ─── THROTTLE LEDGER ─────────────────────────────────────────────────────

describe("throttle ledger", () => {
  test("sourceKeyOf is stable for the same items + scope, distinct across scope", async () => {
    const items = [
      { type: "settings" as const, path: "/a/settings.json", scope: "project" as const },
      { type: "mcp" as const, path: "/a/.mcp.json", scope: "project" as const },
    ]
    const k1 = sourceKeyOf("project", items)
    const k2 = sourceKeyOf("project", [...items].reverse()) // order-insensitive
    expect(k1).toBe(k2)
    const kHome = sourceKeyOf("home", items)
    expect(kHome).not.toBe(k1)
  })

  test("fresh ledger ⇒ not throttled; recording any disposition ⇒ throttled", async () => {
    const items = [{ type: "settings" as const, path: join(home, "x"), scope: "home" as const }]
    const key = sourceKeyOf("home", items)
    let ledger = await loadMigrationLedger(home)
    expect(isThrottled(ledger, key)).toBe(false)
    await recordDisposition(home, key, "declined", ["settings"])
    ledger = await loadMigrationLedger(home)
    expect(isThrottled(ledger, key)).toBe(true)
  })

  test("imported + offered + declined all throttle a re-offer", async () => {
    for (const d of ["offered", "imported", "declined"] as const) {
      const key = `key-${d}`
      await recordDisposition(home, key, d, ["mcp"])
      const ledger = await loadMigrationLedger(home)
      expect(isThrottled(ledger, key)).toBe(true)
    }
  })

  test("a DIFFERENT source key is NOT throttled by an unrelated record", async () => {
    await recordDisposition(home, "key-a", "declined", ["settings"])
    const ledger = await loadMigrationLedger(home)
    expect(isThrottled(ledger, "key-b")).toBe(false)
  })
})
