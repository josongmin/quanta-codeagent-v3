import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRepoRules, REPO_RULE_CANDIDATES, renderRepoRulesBlock } from "@/agent"

describe("loadRepoRules", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "qct-repo-rules-"))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test("returns undefined when no rule file is present (byte-identical default)", async () => {
    const out = await loadRepoRules(cwd)
    expect(out).toBeUndefined()
  })

  test("loads AGENTS.md when present", async () => {
    await writeFile(join(cwd, "AGENTS.md"), "no heuristics\nfail-closed\n", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out).toBeDefined()
    expect(out?.entrypoint).toBe("AGENTS.md")
    expect(out?.sourcePath).toBe(join(cwd, "AGENTS.md"))
    expect(out?.body).toContain("no heuristics")
    expect(out?.loadedAt).toBeGreaterThan(0)
  })

  test("falls back to CLAUDE.md when AGENTS.md absent", async () => {
    await writeFile(join(cwd, "CLAUDE.md"), "claude rules go here", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out?.entrypoint).toBe("CLAUDE.md")
    expect(out?.body).toBe("claude rules go here")
  })

  test("prefers AGENTS.md over CLAUDE.md when both present (SSOT priority)", async () => {
    await writeFile(join(cwd, "AGENTS.md"), "primary", "utf8")
    await writeFile(join(cwd, "CLAUDE.md"), "secondary", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out?.entrypoint).toBe("AGENTS.md")
    expect(out?.body).toBe("primary")
  })

  test("falls back to .codex/CODEX-RULES.md as last resort", async () => {
    await mkdir(join(cwd, ".codex"), { recursive: true })
    await writeFile(join(cwd, ".codex/CODEX-RULES.md"), "codex legacy", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out?.entrypoint).toBe(".codex/CODEX-RULES.md")
    expect(out?.body).toBe("codex legacy")
  })

  test("skips empty (whitespace-only) files and continues to the next candidate", async () => {
    await writeFile(join(cwd, "AGENTS.md"), "   \n  \n", "utf8")
    await writeFile(join(cwd, "CLAUDE.md"), "real content", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out?.entrypoint).toBe("CLAUDE.md")
  })

  test("returns undefined when all candidates are empty", async () => {
    await writeFile(join(cwd, "AGENTS.md"), "", "utf8")
    await writeFile(join(cwd, "CLAUDE.md"), "\n", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out).toBeUndefined()
  })

  test("REPO_RULE_CANDIDATES priority order is stable contract", () => {
    expect(REPO_RULE_CANDIDATES).toEqual(["AGENTS.md", "CLAUDE.md", ".codex/CODEX-RULES.md"])
  })
})

describe("renderRepoRulesBlock", () => {
  test("renders with entrypoint citation header + trimmed body", () => {
    const block = renderRepoRulesBlock({
      sourcePath: "/x/AGENTS.md",
      entrypoint: "AGENTS.md",
      body: "\n\n  rule one\n  rule two\n  \n",
      loadedAt: 0,
    })
    expect(block).toContain("## Repo-local rules (from AGENTS.md)")
    expect(block).toContain("rule one")
    expect(block).toContain("rule two")
    // Trailing/leading whitespace from the body is stripped so the block has a
    // predictable footprint regardless of repo formatting.
    expect(block.endsWith("rule two")).toBe(true)
  })

  test("each entrypoint cites its own name", () => {
    const block = renderRepoRulesBlock({
      sourcePath: "/x/CLAUDE.md",
      entrypoint: "CLAUDE.md",
      body: "body",
      loadedAt: 0,
    })
    expect(block).toContain("(from CLAUDE.md)")
  })
})
