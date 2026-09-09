import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { RepoRules } from "@/agent/repo-rules"
import {
  resolveModePresetRepoRules,
  resolveModePresetSystemPrompt,
} from "@/apps/agent/mode-presets/system"

describe("G-F13 repo-rules load warning", () => {
  test("success does not warn", async () => {
    const seen: unknown[] = []
    const rules = { sourcePath: "/x", entrypoint: "AGENTS.md", body: "hi", loadedAt: 1 }
    const got = await resolveModePresetRepoRules("interactive", undefined, "/tmp", {
      load: async () => rules,
      warn: (info) => {
        seen.push(info)
      },
    })
    expect(got).toBe(rules)
    expect(seen).toEqual([])
  })

  test("load rejection warns once and fail-opens", async () => {
    const seen: { cwd: string; cause: string }[] = []
    const got = await resolveModePresetRepoRules("interactive", undefined, "/work", {
      load: async () => {
        throw new Error(`EACCES ghp_${"A".repeat(36)}`)
      },
      warn: (info) => {
        seen.push(info)
      },
    })
    expect(got).toBeUndefined()
    expect(seen).toEqual([{ cwd: "/work", cause: `EACCES [REDACTED:github_pat_classic]` }])
  })

  test("throwing warning sink still fail-opens", async () => {
    const got = await resolveModePresetRepoRules("interactive", undefined, "/work", {
      load: async () => {
        throw new Error("boom")
      },
      warn: () => {
        throw new Error("sink")
      },
    })
    expect(got).toBeUndefined()
  })

  test("no-file result does not warn", async () => {
    const seen: unknown[] = []
    const got = await resolveModePresetRepoRules("interactive", undefined, "/work", {
      load: async () => undefined,
      warn: (info) => {
        seen.push(info)
      },
    })
    expect(got).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("batch mode skips load and warning", async () => {
    const seen: unknown[] = []
    const got = await resolveModePresetRepoRules("batch", undefined, "/work", {
      load: async () => {
        throw new Error("should not run")
      },
      warn: (info) => {
        seen.push(info)
      },
    })
    expect(got).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("override skips load and warning", async () => {
    const override = { sourcePath: "/o", entrypoint: "AGENTS.md", body: "x", loadedAt: 1 }
    const seen: unknown[] = []
    const got = await resolveModePresetRepoRules("interactive", override as RepoRules, "/work", {
      load: async () => {
        throw new Error("should not run")
      },
      warn: (info) => {
        seen.push(info)
      },
    })
    expect(got).toBe(override)
    expect(seen).toEqual([])
  })

  test("failed load leaves the preset prompt intact and unused by the warning", async () => {
    const secret = `ghp_${"A".repeat(36)}`
    const seen: { cwd: string; cause: string }[] = []
    const rules = await resolveModePresetRepoRules("interactive", undefined, "/work", {
      load: async () => {
        throw new Error(`EACCES ${secret}`)
      },
      warn: (info) => {
        seen.push(info)
      },
    })
    const prompt = resolveModePresetSystemPrompt("interactive", undefined, "/work")
    expect(rules).toBeUndefined()
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).not.toContain(secret)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.cause).not.toContain("ghp_")
  })

  test("web repo-rules catch redacts the cause and warns once", () => {
    const src = readFileSync(
      join(process.cwd(), "src/apps/web-daemon/runtime-factory/agent-config-base.ts"),
      "utf8",
    )
    expect(src).toContain("redactSecrets")
    expect(src).toContain("envelope_jsonl")
    expect(src).toContain("webRepoRulesLoadWarned")
    expect(src).not.toMatch(/error:\s*errMessage\(e\)/)
    expect(src).not.toMatch(/apps\/agent/)
  })
})
