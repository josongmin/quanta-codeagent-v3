import { describe, expect, test } from "bun:test"
import type { RepoRules } from "@/agent/repo-rules"
import { resolveModePresetRepoRules } from "@/apps/agent/mode-presets/system"

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
})
