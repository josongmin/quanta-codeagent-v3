/**
 * Hellgate — the tool-surface manifest agrees with what the builders ACTUALLY mint.
 *
 * The manifest's two-way completeness was proven by a SOURCE census
 * (`tools/dev/tool-name-literals.ts`), which cannot see a tool whose `name` is computed.
 * Its docstrings — and two comments in `tool-surface-manifest-hellgate.test.ts` — named
 * THIS file as the assembled-registry authority for exactly that case. It did not exist.
 * An adversarial audit followed the reference and found what the absence hid: seven live
 * LSP tools built by `positionTool` with a computed name, registered on the CLI, absent
 * from the manifest.
 *
 * The assembly is `tests/unit/_shared/assembled-tool-universe.ts`: real builders only,
 * including `buildSessionFeatures` over the `AgentConfig` slots the manifest itself
 * declares.
 */
import { describe, expect, test } from "bun:test"
import { ALL_MANIFEST_TOOL_NAMES } from "@/tool"
import { assembleToolUniverse } from "./_shared/assembled-tool-universe"

const UNIVERSE = await assembleToolUniverse()
const ASSEMBLED = new Set(UNIVERSE.tools.map((t) => t.name))
const MANIFEST = new Set(ALL_MANIFEST_TOOL_NAMES)

const sourceOf = (name: string): string =>
  [...UNIVERSE.bySource].find(([, names]) => names.includes(name))?.[0] ?? "?"

/**
 * Catalogued names no builder in the assembly can mint WITHOUT a live resource at
 * construction — a browser (CDP), an MCP server handshake, a memory store, a spawned
 * subagent's per-child tools, or a composition-root binding this fixture does not model.
 *
 * A LEDGER THAT MAY ONLY SHRINK. It is pinned by name, and both directions are asserted:
 * a catalogued name missing from the assembly and from this list fails, and a name here
 * that the assembly DOES mint fails too ("remove it from the ledger"). Growing it is a
 * visible edit to this file, which is the point.
 *
 * MEASURED at the commit that introduced this gate: 156 distinct names assembled from
 * ten builders, 47 catalogued names outside the assembly.
 */
const NOT_YET_ASSEMBLED: readonly string[] = [
  "ast_grep",
  "browser_cdp",
  "browser_click",
  "browser_console",
  "browser_drag",
  "browser_element_bounds",
  "browser_fill",
  "browser_highlight",
  "browser_mouse_click_xy",
  "browser_navigate",
  "browser_network",
  "browser_press_key",
  "browser_read",
  "browser_screenshot",
  "browser_scroll",
  "browser_select_option",
  "browser_snapshot",
  "browser_tab_close",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_switch",
  "browser_type",
  "browser_wait",
  "cancel_mcp_task",
  "check_secrets",
  "delegate",
  "find_references",
  "followup_task",
  "fork_session",
  "get_mcp_task",
  "git_push",
  "git_stage",
  "list_mcp_tasks",
  "memory_search",
  "memory_update",
  "memory_write",
  "poll_deferred",
  "report_agent_job_result",
  "search_codebase",
  "shadow_verify",
  "skill_create",
  "subagent_await",
  "subagent_force_background",
  "subagent_fork",
  "subagent_poll",
  "update_working_state",
  "web_search",
]

describe("tool-surface manifest — runtime parity with the assembled builders", () => {
  test("the assembly reached the tool population (an empty universe satisfies every loop)", () => {
    expect(ASSEMBLED.size, "the assembly collapsed").toBeGreaterThan(140)
    expect(UNIVERSE.bySource.size).toBeGreaterThanOrEqual(10)
    for (const [label, names] of UNIVERSE.bySource) {
      expect(
        names.length,
        `${label} minted nothing — its stubs no longer satisfy it`,
      ).toBeGreaterThan(0)
    }
  })

  test("every tool a builder mints is catalogued", () => {
    const uncatalogued = [...ASSEMBLED]
      .filter((n) => !MANIFEST.has(n))
      .sort()
      .map((n) => `${n} (from ${sourceOf(n)})`)
    expect(
      uncatalogued,
      "a builder mints a tool the manifest does not list — a computed or constructed name the " +
        "source census cannot see. Add it to its manifest row.",
    ).toEqual([])
  })

  test("every catalogued name is assembled or on the not-yet-assembled ledger", () => {
    const ledger = new Set(NOT_YET_ASSEMBLED)
    const unaccounted = [...MANIFEST].filter((n) => !ASSEMBLED.has(n) && !ledger.has(n)).sort()
    expect(
      unaccounted,
      "a manifest row names a tool no builder in the assembly mints and the ledger does not " +
        "record — a stale row, or a new tool whose builder this fixture should reach",
    ).toEqual([])
  })

  test("the ledger may only shrink: a name the assembly now mints must leave it", () => {
    const nowAssembled = NOT_YET_ASSEMBLED.filter((n) => ASSEMBLED.has(n))
    expect(nowAssembled, "these are assembled now — remove them from NOT_YET_ASSEMBLED").toEqual([])
    const notCatalogued = NOT_YET_ASSEMBLED.filter((n) => !MANIFEST.has(n))
    expect(notCatalogued, "the ledger names tools the manifest no longer lists").toEqual([])
    expect(new Set(NOT_YET_ASSEMBLED).size, "duplicate ledger entry").toBe(NOT_YET_ASSEMBLED.length)
    expect([...NOT_YET_ASSEMBLED], "keep the ledger sorted so diffs stay reviewable").toEqual(
      [...NOT_YET_ASSEMBLED].sort(),
    )
  })

  test("the seven computed-name LSP tools that motivated this gate are catalogued", () => {
    for (const name of [
      "lsp_definition",
      "lsp_hover",
      "lsp_type_definition",
      "lsp_implementation",
      "lsp_rename_preview",
      "lsp_incoming_calls",
      "lsp_outgoing_calls",
    ]) {
      expect(ASSEMBLED.has(name), `${name} is no longer assembled`).toBe(true)
      expect(MANIFEST.has(name), `${name} is uncatalogued again`).toBe(true)
    }
  })
})
