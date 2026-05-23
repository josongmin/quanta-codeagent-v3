import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, loadRepoRules, runAgent } from "@/agent"
import type { Message } from "@/llm"
import { FakeLLM, baseConfig as harnessBaseConfig, NullStream } from "./_harness"

/**
 * ADR-0098 (AGENTS.md tree scoping + deeper-wins) — end-to-end wiring check.
 *
 * Verifies the §18.1 verbatim contract surfaces all the way into the per-turn
 * reminder block that the model actually sees:
 *   1. A 3-level monorepo (root + packages + packages/foo) has all THREE
 *      AGENTS.md bodies rendered into the prompt.
 *   2. Render order is root → cwd so deeper-wins via LLM positional bias.
 *   3. The header explicitly states "rules from deeper directories override
 *      shallower ones" (not just inferred from order — verbatim notice so
 *      models that don't read positional priority still see the rule).
 *   4. Per-layer `### From <relativePath>` subheaders ride with each body so
 *      a human auditor (or the model itself) can attribute a rule to the
 *      file it came from.
 *
 * Slice: `@/agent` only — the loader walks the user-provided cwd directly and
 * `runAgent` consumes the loaded `RepoRules` through `config.repoRules` exactly
 * like sota-codex-full does. fs-jail is unaffected because the walk is read-
 * only and bounded by `.git` / MAX_DEPTH.
 */

const reminderText = (messages: Message[]): string => {
  const tail = messages[messages.length - 1]
  if (!tail || tail.role !== "user") return ""
  const block = tail.content[0]
  return block?.type === "text" ? block.text : ""
}

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  harnessBaseConfig({
    llm: overrides.llm ?? new FakeLLM(),
    stream: new NullStream(),
    permission: { mode: "bypass" },
    messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    system: "TEST_SYSTEM",
    cwd: overrides.cwd ?? "/repo",
    maxTurns: 1,
    ...overrides,
  })

describe("ADR-0098 AGENTS.md tree scoping — end-to-end prompt wiring", () => {
  let base: string

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "qct-agents-md-e2e-"))
    // `.git` boundary so the walk halts here. Without it the loader would
    // climb out of the tmpdir and a stray AGENTS.md on the test host could
    // bleed in.
    await mkdir(join(base, ".git"))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  test("3-level monorepo: all three AGENTS.md bodies appear in the per-turn reminder, shallow → deep", async () => {
    await writeFile(join(base, "AGENTS.md"), "ROOT_RULE_root", "utf8")
    await mkdir(join(base, "packages"))
    await writeFile(join(base, "packages/AGENTS.md"), "PKG_RULE_packages", "utf8")
    await mkdir(join(base, "packages/foo"))
    await writeFile(join(base, "packages/foo/AGENTS.md"), "FOO_RULE_foo", "utf8")

    const cwd = join(base, "packages/foo")
    const rules = await loadRepoRules(cwd)
    if (!rules) throw new Error("expected 3-layer AGENTS.md to load")
    expect(rules.layers).toHaveLength(3)

    const llm = new FakeLLM()
    const out = await runAgent(baseConfig({ llm, cwd, repoRules: rules }))
    expect(out.reason).toBe("completed")

    const reminder = reminderText(llm.seenMessages[0] ?? [])

    // All three bodies appear, shallow → deep (deeper-wins via positional bias).
    const rootIdx = reminder.indexOf("ROOT_RULE_root")
    const pkgsIdx = reminder.indexOf("PKG_RULE_packages")
    const fooIdx = reminder.indexOf("FOO_RULE_foo")
    expect(rootIdx).toBeGreaterThan(-1)
    expect(pkgsIdx).toBeGreaterThan(rootIdx)
    expect(fooIdx).toBeGreaterThan(pkgsIdx)

    // Per-layer attribution subheaders so the model can cite the source file
    // and a human auditor can trace any rule back to its origin.
    expect(reminder).toContain("### From ../../AGENTS.md")
    expect(reminder).toContain("### From ../AGENTS.md")
    expect(reminder).toContain("### From ./AGENTS.md")

    // The §18.1 verbatim deeper-wins notice rides in the header — models that
    // don't read positional priority still see the rule explicitly.
    expect(reminder).toContain("rules from deeper directories override shallower ones")
  })

  test("mixed entrypoints (root AGENTS.md + sub CLAUDE.md) both ride into the reminder with the deeper-wins notice", async () => {
    await writeFile(join(base, "AGENTS.md"), "ROOT_AGENTS_BODY", "utf8")
    await mkdir(join(base, "sub"))
    await writeFile(join(base, "sub/CLAUDE.md"), "SUB_CLAUDE_BODY", "utf8")

    const cwd = join(base, "sub")
    const rules = await loadRepoRules(cwd)
    if (!rules) throw new Error("expected mixed-entrypoint layers to load")
    expect(rules.layers).toHaveLength(2)
    // Top-level entrypoint citation reflects the DEEPEST layer (cwd-closest).
    expect(rules.entrypoint).toBe("CLAUDE.md")

    const llm = new FakeLLM()
    await runAgent(baseConfig({ llm, cwd, repoRules: rules }))

    const reminder = reminderText(llm.seenMessages[0] ?? [])
    expect(reminder).toContain("ROOT_AGENTS_BODY")
    expect(reminder).toContain("SUB_CLAUDE_BODY")
    // Root body precedes sub body (deeper-wins via positional bias).
    expect(reminder.indexOf("ROOT_AGENTS_BODY")).toBeLessThan(reminder.indexOf("SUB_CLAUDE_BODY"))
    // The deeper-wins notice is present because >1 layer was loaded.
    expect(reminder).toContain("rules from deeper directories override shallower ones")
    // The header still cites the deepest entrypoint as repo authority.
    expect(reminder).toContain("(from CLAUDE.md;")
  })

  test("single-layer (root only) preserves the legacy header — byte-identical for repos without monorepo scoping", async () => {
    await writeFile(join(base, "AGENTS.md"), "SINGLE_LAYER_BODY", "utf8")
    const rules = await loadRepoRules(base)
    if (!rules) throw new Error("expected single-layer AGENTS.md to load")
    expect(rules.layers).toHaveLength(1)

    const llm = new FakeLLM()
    await runAgent(baseConfig({ llm, cwd: base, repoRules: rules }))

    const reminder = reminderText(llm.seenMessages[0] ?? [])
    expect(reminder).toContain("SINGLE_LAYER_BODY")
    // Legacy header is EXACTLY `(from AGENTS.md)` — no deeper-wins suffix when
    // there's only one layer. Asserted via the trailing close-paren followed by
    // a newline so a future suffix addition would have to flip this case too.
    expect(reminder).toContain("## Repo-local rules (from AGENTS.md)\n")
    expect(reminder).not.toContain("rules from deeper directories override shallower ones")
    // No `### From ./...` subheader either — single layer renders the raw body.
    expect(reminder).not.toContain("### From ")
  })
})
