/**
 * rule-indicator surface tests — pill rendering + boxed list + env gating.
 *
 * Two layers covered:
 *   1. PURE renderers (`renderRuleBadge` / `renderRuleList`) which take an
 *      inventory literal and return strings. These never touch disk.
 *   2. fs-driven `buildRuleInventory` — uses a per-test temp dir to seed
 *      AGENTS.md / CLAUDE.md / .quanta/rules/*.md fixtures, then asserts the
 *      kind / active / count fields without coupling to any other slice.
 *
 * Slice: imports only from `src/apps/cli/rule-indicator` + node fs. The
 * underlying `@/agent` loaders are exercised transitively but no direct
 * import is required.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRuleInventory,
  EMPTY_RULE_INVENTORY,
  isRuleIndicatorEnabled,
  isRulePillEnabled,
  RULE_INDICATOR_ENV,
  RULE_PILL_ENV,
  type RuleInventory,
  renderRuleBadge,
  renderRuleList,
  simulatePath,
  stripAnsi,
} from "../../../src/apps/cli/rule-indicator"

const cleanEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

const makeInv = (sources: RuleInventory["sources"]): RuleInventory => ({
  sources,
  totalCount: sources.length,
  activeCount: sources.filter((s) => s.active).length,
})

const newRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "quanta-rule-indicator-"))
  await mkdir(join(dir, ".git"), { recursive: true })
  return dir
}

describe("rule-indicator · renderRuleBadge", () => {
  test("empty inventory ⇒ empty badge", () => {
    expect(renderRuleBadge(EMPTY_RULE_INVENTORY)).toBe("")
  })

  test("1 global rule ⇒ [rules: 1/1 matched]", () => {
    const inv = makeInv([{ path: "CLAUDE.md", kind: "global", active: true }])
    expect(stripAnsi(renderRuleBadge(inv))).toBe("[rules: 1/1 matched]")
  })

  test("3 active + 1 inactive ⇒ [rules: 3/4 matched]", () => {
    const inv = makeInv([
      { path: "AGENTS.md", kind: "global", active: true },
      { path: "CLAUDE.md", kind: "global", active: true },
      { path: ".quanta/rules/a.md", kind: "glob", active: true, matchedPattern: "*.ts" },
      { path: ".cursor/rules/b.mdc", kind: "glob", active: false, matchedPattern: "src/**" },
    ])
    expect(stripAnsi(renderRuleBadge(inv))).toBe("[rules: 3/4 matched]")
  })

  test("ANSI escapes are present in the colour form", () => {
    const inv = makeInv([{ path: "CLAUDE.md", kind: "global", active: true }])
    const colored = renderRuleBadge(inv)
    expect(colored).toContain("\x1b[")
    expect(stripAnsi(colored)).toBe("[rules: 1/1 matched]")
  })
})

describe("rule-indicator · renderRuleList", () => {
  test("empty inventory ⇒ explicit 'no rules configured' box", () => {
    const text = stripAnsi(renderRuleList(EMPTY_RULE_INVENTORY))
    expect(text).toContain("Rules")
    expect(text).toContain("(no rules configured)")
  })

  test("kind=global rows show '(global)' scope", () => {
    const inv = makeInv([{ path: "CLAUDE.md", kind: "global", active: true, bytes: 2300 }])
    const text = stripAnsi(renderRuleList(inv))
    expect(text).toContain("CLAUDE.md")
    expect(text).toContain("global")
    expect(text).toContain("2.2 KiB")
  })

  test("kind=glob with matched path count is rendered", () => {
    const inv = makeInv([
      {
        path: ".quanta/rules/style.md",
        kind: "glob",
        active: true,
        matchedPattern: "**/*.test.ts",
        matchedPathCount: 12,
      },
    ])
    const text = stripAnsi(renderRuleList(inv))
    expect(text).toContain("glob: **/*.test.ts")
    expect(text).toContain("matched 12 paths")
  })

  test("inactive glob rule renders 'no match' hint + ◌ marker", () => {
    const inv = makeInv([
      {
        path: ".cursor/rules/perf.mdc",
        kind: "glob",
        active: false,
        matchedPattern: "src/perf/**",
      },
    ])
    const text = stripAnsi(renderRuleList(inv))
    expect(text).toContain("◌")
    expect(text).toContain("perf.mdc")
    expect(text).toContain("no match")
  })

  test("summary line counts active + inactive", () => {
    const inv = makeInv([
      { path: "AGENTS.md", kind: "global", active: true },
      { path: "CLAUDE.md", kind: "global", active: true },
      { path: ".cursor/rules/x.mdc", kind: "glob", active: false, matchedPattern: "x" },
    ])
    const text = stripAnsi(renderRuleList(inv))
    expect(text).toContain("2 active · 1 inactive")
  })
})

describe("rule-indicator · env gating", () => {
  test("isRuleIndicatorEnabled defaults ON when env is empty", () => {
    expect(isRuleIndicatorEnabled(cleanEnv())).toBe(true)
  })

  test(`isRuleIndicatorEnabled flips OFF when ${RULE_INDICATOR_ENV}=0`, () => {
    expect(isRuleIndicatorEnabled(cleanEnv({ [RULE_INDICATOR_ENV]: "0" }))).toBe(false)
    expect(isRuleIndicatorEnabled(cleanEnv({ [RULE_INDICATOR_ENV]: "false" }))).toBe(false)
    expect(isRuleIndicatorEnabled(cleanEnv({ [RULE_INDICATOR_ENV]: "off" }))).toBe(false)
  })

  test(`isRulePillEnabled gated by BOTH ${RULE_INDICATOR_ENV} and ${RULE_PILL_ENV}`, () => {
    expect(isRulePillEnabled(cleanEnv())).toBe(true)
    expect(isRulePillEnabled(cleanEnv({ [RULE_PILL_ENV]: "0" }))).toBe(false)
    // Indicator off ⇒ pill off even when pill knob is unset.
    expect(isRulePillEnabled(cleanEnv({ [RULE_INDICATOR_ENV]: "0" }))).toBe(false)
  })

  test("buildRuleInventory with indicator disabled returns the empty singleton", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# active", "utf8")
    const inv = await buildRuleInventory({
      cwd: dir,
      env: cleanEnv({ [RULE_INDICATOR_ENV]: "0" }),
    })
    expect(inv).toBe(EMPTY_RULE_INVENTORY)
    expect(inv.totalCount).toBe(0)
  })
})

describe("rule-indicator · buildRuleInventory (fs)", () => {
  test("absent repo ⇒ empty inventory", async () => {
    const dir = await newRepo()
    const inv = await buildRuleInventory({ cwd: dir })
    expect(inv.totalCount).toBe(0)
  })

  test("AGENTS.md alone ⇒ 1 global active rule", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "## rules\nbe nice\n", "utf8")
    const inv = await buildRuleInventory({ cwd: dir })
    expect(inv.totalCount).toBe(1)
    expect(inv.activeCount).toBe(1)
    const row = inv.sources[0]
    expect(row).toBeDefined()
    expect(row?.kind).toBe("global")
    // Single-layer paths come through with `./` prefix from the loader's
    // relative-path normalisation. Pattern-match both shapes.
    expect(row?.path).toMatch(/^(\.\/)?AGENTS\.md$/)
    expect(row?.active).toBe(true)
  })

  test("AGENTS.md + .quanta/rules/x.md (alwaysApply) ⇒ both active", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# repo policy\n", "utf8")
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "always.md"),
      "---\nalwaysApply: true\n---\nbe brief\n",
      "utf8",
    )
    const inv = await buildRuleInventory({ cwd: dir })
    expect(inv.totalCount).toBe(2)
    expect(inv.activeCount).toBe(2)
    const kinds = inv.sources.map((s) => s.kind).sort()
    expect(kinds).toContain("global")
    expect(kinds).toContain("glob")
  })

  test("glob rule with no matching changedPaths ⇒ active=false", async () => {
    const dir = await newRepo()
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "tests.md"),
      "---\nglobs: '**/*.test.ts'\n---\nuse describe + test\n",
      "utf8",
    )
    const inv = await buildRuleInventory({ cwd: dir, changedPaths: ["src/foo.ts"] })
    expect(inv.totalCount).toBe(1)
    expect(inv.activeCount).toBe(0)
    expect(inv.sources[0]?.active).toBe(false)
  })

  test("glob rule with matching changedPaths ⇒ active=true + matchedPathCount", async () => {
    const dir = await newRepo()
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "tests.md"),
      "---\nglobs: '**/*.test.ts'\n---\nuse describe + test\n",
      "utf8",
    )
    const inv = await buildRuleInventory({
      cwd: dir,
      changedPaths: ["src/a.test.ts", "src/b.test.ts", "src/c.ts"],
    })
    expect(inv.activeCount).toBe(1)
    expect(inv.sources[0]?.matchedPathCount).toBe(2)
  })

  test("simulatePath returns the rules that would fire for a path", async () => {
    const dir = await newRepo()
    await writeFile(join(dir, "AGENTS.md"), "# policy\n", "utf8")
    await mkdir(join(dir, ".quanta", "rules"), { recursive: true })
    await writeFile(
      join(dir, ".quanta", "rules", "tests.md"),
      "---\nglobs: '**/*.test.ts'\n---\nuse describe + test\n",
      "utf8",
    )
    const inv = await buildRuleInventory({ cwd: dir })
    const hit = await simulatePath(inv, "src/foo.test.ts")
    expect(hit.path).toBe("src/foo.test.ts")
    // global + glob both fire.
    expect(hit.matched.length).toBe(2)
    const miss = await simulatePath(inv, "src/foo.ts")
    // only global fires for non-test path.
    expect(miss.matched.length).toBe(1)
    expect(miss.matched[0]?.kind).toBe("global")
  })
})
