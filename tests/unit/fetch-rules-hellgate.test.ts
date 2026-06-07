/**
 * Hellgate e2e — fetch_rules tool + loader + CLI wire (GAP 6, ADR-0509).
 *
 * The matcher is fuzz-proven in agent-requested-rules-hellgate; this proves the
 * LIVE wiring:
 *   - loadRequestableRules COLLECTS description-only rules that loadGlobRules DROPS
 *     (and never auto-injects globbed/always rules into the requestable index).
 *   - the tool returns ranked matches over the port; gate OFF ⇒ tool absent.
 *   - default-OFF byte-identity: buildDefaultTools() has no fetch_rules.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadGlobRules, loadRequestableRules } from "@/agent/glob-rules"
import { buildDefaultTools } from "@/tool"
import { fetchRulesTool } from "@/tool/fetch-rules"
import type { FetchRulesPort } from "@/tool/fetch-rules"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import { buildCliFetchRulesTool, fetchRulesPortForCwd } from "@/apps/cli/fetch-rules-wire"

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal }) as ToolContext
const drain = async (tool: ReturnType<typeof fetchRulesTool>, input: unknown): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

describe("fetch_rules — loader collects description-only (not auto-inject)", () => {
  let dir: string
  try {
    dir = mkdtempSync(path.join(tmpdir(), "quanta-fr-"))
  } catch {
    dir = ""
  }
  const setup = () => {
    const rulesDir = path.join(dir, ".quanta", "rules")
    mkdirSync(rulesDir, { recursive: true })
    // description-only ⇒ requestable (dropped by loadGlobRules)
    writeFileSync(
      path.join(rulesDir, "react.md"),
      "---\ndescription: React component conventions and hooks\n---\nUse functional components.",
    )
    // globbed ⇒ auto-inject (NOT requestable)
    writeFileSync(
      path.join(rulesDir, "ts.md"),
      "---\nglobs: '*.ts'\n---\nNo any.",
    )
  }

  test("loadRequestableRules keeps description-only; loadGlobRules drops it", async () => {
    if (dir === "") return // disk-full guard
    setup()
    const requestable = await loadRequestableRules(dir)
    const glob = await loadGlobRules(dir)
    expect(requestable.map((r) => r.name)).toEqual(["react.md"])
    expect(requestable[0]?.description).toContain("React")
    // the globbed rule auto-injects; the description-only one does NOT
    expect(glob.some((r) => r.sourcePath.endsWith("ts.md"))).toBe(true)
    expect(glob.some((r) => r.sourcePath.endsWith("react.md"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("fetch_rules — tool + port", () => {
  const port = (rules: { name: string; description: string; body: string }[]): FetchRulesPort => ({
    fetch: async (q, lim) =>
      rules.filter((r) => r.description.toLowerCase().includes(q.toLowerCase())).slice(0, lim),
  })

  test("returns ranked match bodies", async () => {
    const tool = fetchRulesTool(
      port([{ name: "react.md", description: "React hooks", body: "use hooks" }]),
    )
    const r = await drain(tool, { query: "react" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("react.md")
    expect(r.output).toContain("use hooks")
  })

  test("empty query ⇒ ok:false (no throw)", async () => {
    const r = await drain(fetchRulesTool(port([])), { query: "" })
    expect(r.ok).toBe(false)
  })

  test("no matches ⇒ ok:true with explicit 'no rules' message", async () => {
    const r = await drain(fetchRulesTool(port([])), { query: "anything" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("No matching")
  })

  test("a thrown port ⇒ ok:false (no throw past the loop)", async () => {
    const bad: FetchRulesPort = {
      fetch: async () => {
        throw new Error("boom")
      },
    }
    const r = await drain(fetchRulesTool(bad), { query: "x" })
    expect(r.ok).toBe(false)
  })
})

describe("fetch_rules — registration + CLI gate (default-OFF)", () => {
  test("absent port ⇒ fetch_rules NOT in buildDefaultTools (byte-identical)", () => {
    expect(buildDefaultTools().map((t) => t.name)).not.toContain("fetch_rules")
  })
  test("present port ⇒ registered", () => {
    const p: FetchRulesPort = { fetch: async () => [] }
    expect(buildDefaultTools({ fetchRules: p }).map((t) => t.name)).toContain("fetch_rules")
  })
  test("CLI wire: gate OFF ⇒ null; gate ON ⇒ a tool", () => {
    expect(buildCliFetchRulesTool(".", {})).toBeNull()
    expect(buildCliFetchRulesTool(".", { QUANTA_FETCH_RULES: "1" })?.name).toBe("fetch_rules")
  })
  test("fetchRulesPortForCwd lazily loads (no throw on a missing dir)", async () => {
    const matches = await fetchRulesPortForCwd("/nonexistent-xyz").fetch("q", 5)
    expect(matches).toEqual([])
  })
})
