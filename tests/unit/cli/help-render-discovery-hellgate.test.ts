// Hellgate — `/help` discovery surface contracts.
//
// These tests pin three CLI discovery contracts that broke in past audits:
//
//   1. /image visibility: the multi-modal /image command is virtual
//      (intercepted by repl.ts#dispatchReplSlash because the queue is REPL-
//      scoped, not in BUILTINS). It STILL needs to appear in /help output —
//      discoverability of REPL-only surfaces.
//
//   2. Category grouping: SlashCommand.category literal union exists and is
//      set on several BUILTINS rows. The renderer MUST paint section
//      headers per category (not a flat list) so a 20+ row inventory stays
//      scannable.
//
//   3. SSOT-routed env vars: a section auto-derives from the
//      runtimeConfig() SSOT (src/shared/runtime-config.ts). A floor of >= 5
//      known SSOT-routed knobs MUST surface — silently emptying the table
//      is a regression.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { renderHelp } from "../../../src/apps/cli/help-render"
import { BUILTINS } from "../../../src/apps/cli/slash-commands"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

beforeEach(() => {
  setColorPolicy("off")
})

afterEach(() => {
  setColorPolicy(null)
})

describe("hellgate — /image virtual command visibility in /help", () => {
  test("/image appears in /help output (even though it is NOT in BUILTINS)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // Sanity: /image really is virtual (not a BUILTINS entry).
    const inBuiltins = BUILTINS.some((c) => c.name === "/image")
    expect(inBuiltins).toBe(false)
    // But /help MUST still list it.
    expect(out).toContain("/image")
  })

  test("/image entry is marked as virtual (so the surface scope is visible)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // Either the "virtual" header section paints it, OR the row itself
    // carries a "virtual" hint. We accept either contract — both make the
    // surface scope visible. The renderer paints both today.
    const hasVirtualMarker = out.includes("virtual")
    expect(hasVirtualMarker).toBe(true)
  })

  test("/image describe mentions the three subcommands (add|list|clear)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // Discoverability — a user typing /help SHOULD see what /image does
    // without having to type /image to discover its grammar.
    expect(out).toContain("add")
    expect(out).toContain("list")
    expect(out).toContain("clear")
  })
})

describe("hellgate — category section headers (not flat list)", () => {
  test("at least one category header renders as a section divider", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // BUILTINS has `category: "session"` on /cost, /plan, /state etc.,
    // `category: "help"` on /help, and `category: "loop"` on /branches.
    // The renderer paints `── <name> ──` style headers for non-empty groups.
    const hasSessionHeader = /── session ──/.test(out)
    const hasHelpHeader = /── help ──/.test(out)
    expect(hasSessionHeader || hasHelpHeader).toBe(true)
  })

  test("commands with the same category cluster under one header", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // `/cost`, `/plan`, `/state` all have `category: "session"`. They
    // should appear after the "session" header, not scattered through
    // a flat list. Verify all three of them appear AFTER the session
    // header line (proxy for grouping correctness).
    const sessionIdx = out.indexOf("── session ──")
    expect(sessionIdx).toBeGreaterThan(-1)
    const costIdx = out.indexOf("/cost")
    const planIdx = out.indexOf("/plan")
    const stateIdx = out.indexOf("/state")
    expect(costIdx).toBeGreaterThan(sessionIdx)
    expect(planIdx).toBeGreaterThan(sessionIdx)
    expect(stateIdx).toBeGreaterThan(sessionIdx)
  })

  test("commands without category fall into the 'other' bucket", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // Many BUILTINS rows (e.g. /context, /usage, /color) have no
    // `category:` field. They MUST still render — under the "other"
    // section header.
    expect(out).toContain("── other ──")
    // And the un-categorized rows appear (sanity: they didn't get dropped).
    expect(out).toContain("/context")
    expect(out).toContain("/usage")
  })

  test("section headers use ASCII (no emoji per repo convention)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // Permit dim-dashes (── = U+2500 BOX DRAWINGS LIGHT HORIZONTAL), but
    // ban actual emoji codepoints — the convention is opt-in only.
    // U+1F300–U+1FAFF is the emoji block range.
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  })
})

describe("hellgate — SSOT-routed env-var table", () => {
  test("env section header renders", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    expect(out).toContain("Environment variables")
  })

  test("at least 5 SSOT-routed QUANTA_* knobs surface", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // These five are all routed through `runtimeConfig()` (see the
    // `RuntimeConfig` interface in src/shared/runtime-config.ts).
    const ssotKnobs = [
      "QUANTA_LOG_LEVEL",
      "QUANTA_FS_JAIL",
      "QUANTA_COMPACT_TOKENS",
      "QUANTA_HOME",
      "QUANTA_BENCH_HOME",
    ]
    for (const k of ssotKnobs) {
      expect(out).toContain(k)
    }
  })

  test("env rows include a default-value column (not just name)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // QUANTA_LOG_LEVEL has default "info" — the row paints both.
    const line = out.split("\n").find((l) => l.includes("QUANTA_LOG_LEVEL"))
    expect(line).toBeDefined()
    expect(line as string).toContain("info")
  })

  test("renderer mentions docs/ for the long tail of unrouted vars", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // ~120 surface-level QUANTA_* toggles are NOT enumerated here —
    // the renderer points users at docs/ for the long tail.
    expect(out).toContain("docs/")
  })
})
