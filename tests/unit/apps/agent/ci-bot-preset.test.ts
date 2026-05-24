/**
 * ci-bot preset wiring — RFC may-22 Phase 5 contract test.
 *
 * Pins the bundle that the apps/agent assembler hands to runAgent when
 * mode = "ci-bot":
 *   - tool list contains git + gh
 *   - protected-branch + network-allowlist defaults are present
 *   - propositional gitWrite check rejects pushes to main
 *   - env allowlist excludes user secrets (OPENAI_API_KEY etc)
 */
import { describe, expect, test } from "bun:test"
import {
  buildCiBotWiring,
  CI_ENV_ALLOWLIST,
} from "@/../src/apps/agent/mode-presets/ci-bot-policy"

describe("buildCiBotWiring — tool surface", () => {
  test("includes git + gh tools", () => {
    const w = buildCiBotWiring()
    const names = w.tools.map((t) => t.name)
    // git
    expect(names).toContain("git_commit")
    expect(names).toContain("git_branch_switch")
    expect(names).toContain("git_status")
    // gh
    expect(names).toContain("gh_pr_view")
    expect(names).toContain("gh_pr_comment")
    expect(names).toContain("gh_pr_create")
  })

  test("does NOT include host-leak tools (no `bash` in ci-bot tool set)", () => {
    const w = buildCiBotWiring()
    const names = w.tools.map((t) => t.name)
    expect(names).not.toContain("bash")
    expect(names).not.toContain("write")
  })
})

describe("buildCiBotWiring — defaults", () => {
  test("network allowlist contains api.github.com + npm registry", () => {
    const w = buildCiBotWiring()
    expect(w.networkAllowlist).toContain("api.github.com")
    expect(w.networkAllowlist).toContain("registry.npmjs.org")
  })

  test("protected branches contain main/master/develop/production", () => {
    const w = buildCiBotWiring()
    expect(w.protectedBranches).toContain("main")
    expect(w.protectedBranches).toContain("master")
    expect(w.protectedBranches).toContain("develop")
    expect(w.protectedBranches).toContain("production")
  })

  test("CI_ENV_ALLOWLIST membership: GH_TOKEN + PATH present, user secrets absent", () => {
    // NOTE: this is a static-data membership check on the exported constant,
    // NOT a runtime env-isolation test. Runtime scrubbing using this list is
    // tested by sandbox.test.ts (parent-var scrub) and the spawner suites.
    expect(CI_ENV_ALLOWLIST).toContain("GH_TOKEN")
    expect(CI_ENV_ALLOWLIST).toContain("GITHUB_TOKEN")
    expect(CI_ENV_ALLOWLIST).toContain("PATH")
    expect(CI_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY")
    expect(CI_ENV_ALLOWLIST).not.toContain("ANTHROPIC_API_KEY")
    expect(CI_ENV_ALLOWLIST).not.toContain("CLAUDE_API_KEY")
  })
})

describe("buildCiBotWiring — gitWrite propositional helper", () => {
  test("isGitWriteAllowed rejects git push to main", () => {
    const w = buildCiBotWiring()
    expect(w.isGitWriteAllowed("git push origin main")).toBe(false)
    expect(w.isGitWriteAllowed("git push origin feature/x")).toBe(true)
  })

  test("branchOnlyReason returns a string when denied, undefined when allowed", () => {
    const w = buildCiBotWiring()
    const denied = w.branchOnlyReason("git push origin main")
    expect(denied).toBeDefined()
    if (denied) expect(denied).toContain("main")
    expect(w.branchOnlyReason("git status")).toBeUndefined()
  })

  test("currentBranch=main + bare `git push` is rejected", () => {
    const w = buildCiBotWiring()
    expect(w.isGitWriteAllowed("git push", "main")).toBe(false)
    expect(w.isGitWriteAllowed("git push", "feature/x")).toBe(true)
  })
})

describe("buildCiBotWiring — operator extensions", () => {
  test("extraAllowedHosts append (dedupe with defaults)", () => {
    const w = buildCiBotWiring({ extraAllowedHosts: ["my-internal.example.com", "api.github.com"] })
    expect(w.networkAllowlist).toContain("my-internal.example.com")
    expect(w.networkAllowlist).toContain("api.github.com")
    // dedupe: api.github.com appears once
    expect(w.networkAllowlist.filter((h) => h === "api.github.com").length).toBe(1)
  })

  test("extraProtectedBranches append", () => {
    const w = buildCiBotWiring({ extraProtectedBranches: ["release-1.0"] })
    expect(w.protectedBranches).toContain("release-1.0")
    expect(w.isGitWriteAllowed("git push origin release-1.0")).toBe(false)
  })
})
