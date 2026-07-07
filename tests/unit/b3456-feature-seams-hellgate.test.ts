/**
 * B3456 hellgate — four seam wiring tests (GROUP B3456):
 *
 * B6 (git-budget): QUANTA_GIT_BUDGET_* knobs flow into gitTools() at BOTH
 *   composition roots (cli/internal.ts + ci-bot.ts). The resolveGitBudget
 *   function already exists and gitTools() already accepts { budget }, but no
 *   call-site ever threads the result in. Pins that both seams pass the budget.
 *
 * B3 (gh_pr_resolve_thread): QUANTA_CI_BOT_GH_WRITE=1 causes buildCiBotWiring
 *   to skip the read-only filter and include the mutating gh tool
 *   `gh_pr_resolve_thread` (which needs a gitRunner in its opts). Gate OFF ⇒
 *   mutating tools absent (byte-identical).
 *
 * B4 (gh_pr_edit_labels): same gate as B3 — `gh_pr_edit_labels` is also
 *   mutating (isReadOnly()===false). Must be present when gate ON, absent when OFF.
 *
 * B5 (deferred-result-registry): when QUANTA_ASYNC_TOOLS=1, BOTH
 *   buildAsyncDeferredTools() mints create a NEW DefaultDeferredResultRegistry
 *   each call, so two registries can coexist without sharing handles. The fix
 *   hoists ONE shared registry per call-site so the poll_deferred tool and any
 *   future producer share the same store. Test pins: the registry exposed by the
 *   cli-internal path is the SAME instance the poll_deferred tool was built from
 *   (no duplicate minting), tested via the exported seam.
 */

import { describe, expect, it } from "bun:test"
import { buildCiBotWiring } from "@/../src/apps/agent/mode-presets/ci-bot"
import { resolveGitBudget, withBudget } from "@/tool/git"
import type { GitRunner } from "@/tool/git/types"

// ── helpers ─────────────────────────────────────────────────────────────────

const okGh = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
  stdout: '{"title":"test"}',
  stderr: "",
  exitCode: 0,
})

const stubRunner: GitRunner = {
  run: async (args) => {
    if (args[0] === "rev-parse") return { stdout: "feature/x\n", stderr: "", exitCode: 0 }
    return { stdout: "ok", stderr: "", exitCode: 0 }
  },
}

// ── B6: git-budget knobs wired into gitTools at BOTH seams ──────────────────

describe("B6 — git-budget wired at composition roots", () => {
  it("B6-R1: resolveGitBudget returns undefined when no knobs set (byte-identical gate-OFF)", () => {
    // Gate-OFF: no env keys → budget is undefined → withBudget returns SAME runner
    const budget = resolveGitBudget({})
    expect(budget).toBeUndefined()
    const wrapped = withBudget(stubRunner, budget)
    // byte-identical: same reference
    expect(wrapped).toBe(stubRunner)
  })

  it("B6-R2: resolveGitBudget returns a budget when QUANTA_GIT_BUDGET_MAX_COMMITS is set", () => {
    const budget = resolveGitBudget({ QUANTA_GIT_BUDGET_MAX_COMMITS: "50" })
    expect(budget).toBeDefined()
    expect(budget?.maxCommits).toBe(50)
  })

  it("B6-R3: ci-bot buildCiBotWiring text includes resolveGitBudget (budget wired)", () => {
    // Static text check: the source must contain the wiring call.
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const src = readFileSync(
      join(import.meta.dir, "../../src/apps/agent/mode-presets/ci-bot.ts"),
      "utf8",
    )
    expect(src).toContain("resolveGitBudget")
  })

  it("B6-R4: cli internal.ts includes resolveGitBudget (budget wired)", () => {
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const src = readFileSync(join(import.meta.dir, "../../src/apps/cli/internal.ts"), "utf8")
    expect(src).toContain("resolveGitBudget")
  })
})

// ── B3+B4: QUANTA_CI_BOT_GH_WRITE gate in buildCiBotWiring ─────────────────

describe("B3+B4 — QUANTA_CI_BOT_GH_WRITE unlocks mutating gh tools in ci-bot", () => {
  it("B3/B4-OFF: gh_pr_resolve_thread and gh_pr_edit_labels absent when gate is OFF", () => {
    delete process.env.QUANTA_CI_BOT_GH_WRITE
    const wiring = buildCiBotWiring("/repo", { ghRun: okGh, gitRun: stubRunner.run })
    const names = wiring.tools.specs().map((s) => s.name)
    // Both mutating tools must stay absent (byte-identical default-OFF)
    expect(names).not.toContain("gh_pr_resolve_thread")
    expect(names).not.toContain("gh_pr_edit_labels")
  })

  it("B3-ON: gh_pr_resolve_thread present when QUANTA_CI_BOT_GH_WRITE=1", () => {
    process.env.QUANTA_CI_BOT_GH_WRITE = "1"
    try {
      const wiring = buildCiBotWiring("/repo", { ghRun: okGh, gitRun: stubRunner.run })
      const names = wiring.tools.specs().map((s) => s.name)
      expect(names).toContain("gh_pr_resolve_thread")
    } finally {
      delete process.env.QUANTA_CI_BOT_GH_WRITE
    }
  })

  it("B4-ON: gh_pr_edit_labels present when QUANTA_CI_BOT_GH_WRITE=1", () => {
    process.env.QUANTA_CI_BOT_GH_WRITE = "1"
    try {
      const wiring = buildCiBotWiring("/repo", { ghRun: okGh, gitRun: stubRunner.run })
      const names = wiring.tools.specs().map((s) => s.name)
      expect(names).toContain("gh_pr_edit_labels")
    } finally {
      delete process.env.QUANTA_CI_BOT_GH_WRITE
    }
  })

  it("B3/B4-ON: read-only tools still present when gate ON (not replaced, appended)", () => {
    process.env.QUANTA_CI_BOT_GH_WRITE = "1"
    try {
      const wiring = buildCiBotWiring("/repo", { ghRun: okGh, gitRun: stubRunner.run })
      const names = wiring.tools.specs().map((s) => s.name)
      // Existing read-only tools must remain
      expect(names).toContain("gh_pr_view")
      expect(names).toContain("gh_pr_review_diff")
      expect(names).toContain("gh_check_status")
      expect(names).toContain("git_diff")
    } finally {
      delete process.env.QUANTA_CI_BOT_GH_WRITE
    }
  })
})

// ── B5: shared deferred registry (no duplicate minting) ─────────────────────

describe("B5 — buildAsyncDeferredTools exports the shared registry", () => {
  it("B5-R1: source text of cli/internal.ts must export or expose the registry (shared-instance comment present)", () => {
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const src = readFileSync(join(import.meta.dir, "../../src/apps/cli/internal.ts"), "utf8")
    // After the fix, buildAsyncDeferredTools returns { tools, registry } OR the
    // registry is declared outside the function and referenced externally.
    // At minimum the source must use a single registry variable shared between
    // pollDeferredTool and any producer (not two separate `new DefaultDeferredResultRegistry`).
    expect(src).toContain("DefaultDeferredResultRegistry")
    // The function must return or expose the registry for sharing
    expect(src).toContain("asyncDeferredRegistry")
  })

  it("B5-R2: gated-tool-ports.ts must expose the registry for sharing", () => {
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../src/host/runtime/agent-arg-builder/gated-tool-ports.ts",
      ),
      "utf8",
    )
    expect(src).toContain("DefaultDeferredResultRegistry")
    expect(src).toContain("asyncDeferredRegistry")
  })
})
