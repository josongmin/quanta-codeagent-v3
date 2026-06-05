/**
 * ADR-0306 (CLI-03) hellgate — slash registry split.
 *
 * Pins the SOTA++ contracts of the three-layer split of the historical
 * `src/apps/cli/slash-commands.ts` (763 LOC) into:
 *
 *   - `src/apps/cli/slash/registry-surface.ts` (surface-only commands)
 *   - `src/apps/cli/slash/registry-session.ts`  (session-bound: needs LLM)
 *   - `src/apps/cli/slash/registry-app.ts`      (app/system: mcp/memory/rewind/perm)
 *
 * Each case is one adversarial invariant; if any flips, the file or the
 * fence regressed. Coverage spans (a) source-grep slice fences, (b) LOC
 * budget on the assembly file, (c) functional equality of the assembled
 * `BUILTINS` to the pre-split SET of names, (d) per-layer counts add to
 * total, (e) standalone-importability of each layer.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { APP_SLASH_COMMANDS } from "../../../../src/apps/cli/slash/registry-app"
import { SESSION_SLASH_COMMANDS } from "../../../../src/apps/cli/slash/registry-session"
import { SURFACE_SLASH_COMMANDS } from "../../../../src/apps/cli/slash/registry-surface"
import { BUILTINS } from "../../../../src/apps/cli/slash-commands"

const repoRoot = join(import.meta.dir, "../../../..")
const readSrc = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8")

/** SET of names that BUILTINS must register post-split. The order changed
 *  (now layered), so we assert membership + uniqueness, not absolute slots
 *  — `tests/unit/slash-commands.test.ts` owns the exact ordering pin. */
const EXPECTED_NAMES = new Set<string>([
  // surface
  "/help",
  "/context",
  "/usage",
  "/color",
  "/navigate",
  "/wait",
  "/skills",
  "/reload-skills",
  "/login",
  "/logout",
  "/status",
  "/snooze",
  "/resume",
  "/snapshot",
  "/rules",
  "/cost",
  "/plan",
  "/state",
  "/working-state",
  "/history",
  "/branches",
  "/fork-checkpoint",
  "/queue",
  "/web",
  "/voice-live",
  "/paste",
  "/edit-plan",
  "/edit-message",
  "/profile",
  "/identity",
  "/sticky-model",
  "/focus-chain",
  "/effort",
  "/inspect",
  "/replay",
  "/session",
  // session
  "/retry-with",
  "/side",
  "/debug",
  "/why",
  "/cancel",
  "/summarize-now",
  // app (env-gated `/rewind`+`/fork`+`/memory` enabled by default)
  "/permission",
  "/mcp",
  "/rewind",
  "/fork",
  "/rewind-tool",
  "/memory",
  "/rewind-conv",
  // Pre-existing app-layer commands that the original EXPECTED set omitted
  // (registered in registry-app.ts but never added here at base 783e6145).
  "/knobs",
  "/session-registry",
  // jun-05 wave2 additions — intentional new builtins (the sweep tracks the
  // registered set; these are real commands, not accidental drift).
  "/brief", // registry-surface.ts — turn brief/summary
  "/dream", // dream-cmd.ts — cross-session memory consolidation (auto-dream)
])

describe("ADR-0306 — slash registry split hellgate (CLI-03)", () => {
  test("CASE-1: registry-surface.ts does NOT import @/agent (any subpath)", () => {
    const src = readSrc("src/apps/cli/slash/registry-surface.ts")
    expect(src).not.toMatch(/from\s+["']@\/agent(?:\/[^"']+)?["']/)
  })

  test("CASE-2: registry-surface.ts does NOT import @/llm (any subpath)", () => {
    const src = readSrc("src/apps/cli/slash/registry-surface.ts")
    expect(src).not.toMatch(/from\s+["']@\/llm(?:\/[^"']+)?["']/)
  })

  test("CASE-3: registry-surface.ts does NOT import @/runner (any subpath)", () => {
    const src = readSrc("src/apps/cli/slash/registry-surface.ts")
    expect(src).not.toMatch(/from\s+["']@\/runner(?:\/[^"']+)?["']/)
  })

  test("CASE-4: registry-surface.ts does NOT import @/host (any subpath)", () => {
    const src = readSrc("src/apps/cli/slash/registry-surface.ts")
    expect(src).not.toMatch(/from\s+["']@\/host(?:\/[^"']+)?["']/)
  })

  test("CASE-5: src/apps/cli/slash-commands.ts is < 200 LOC after the split", () => {
    const src = readSrc("src/apps/cli/slash-commands.ts")
    const loc = src.split("\n").length
    expect(loc).toBeLessThan(200)
  })

  test("CASE-6: BUILTINS registers the same SET of names as before (sweep)", () => {
    const names = new Set(BUILTINS.map((c) => c.name))
    expect(names).toEqual(EXPECTED_NAMES)
  })

  test("CASE-7: each layer's count adds to the total (no double-registration)", () => {
    expect(
      SURFACE_SLASH_COMMANDS.length + SESSION_SLASH_COMMANDS.length + APP_SLASH_COMMANDS.length,
    ).toBe(BUILTINS.length)
  })

  test("CASE-8: each layer is standalone-importable + non-empty", () => {
    expect(Array.isArray(SURFACE_SLASH_COMMANDS)).toBe(true)
    expect(SURFACE_SLASH_COMMANDS.length).toBeGreaterThan(0)
    expect(Array.isArray(SESSION_SLASH_COMMANDS)).toBe(true)
    expect(SESSION_SLASH_COMMANDS.length).toBeGreaterThan(0)
    expect(Array.isArray(APP_SLASH_COMMANDS)).toBe(true)
    expect(APP_SLASH_COMMANDS.length).toBeGreaterThan(0)
  })

  test("CASE-9: BUILTINS preserves layered order (surface block, then session, then app)", () => {
    const names = BUILTINS.map((c) => c.name)
    // Pin three anchors — one from each layer.
    const idxHelp = names.indexOf("/help") // surface
    const idxRetry = names.indexOf("/retry-with") // session
    const idxMcp = names.indexOf("/mcp") // app
    expect(idxHelp).toBe(0) // surface starts at the very top
    expect(idxRetry).toBeGreaterThan(idxHelp)
    expect(idxMcp).toBeGreaterThan(idxRetry)
  })

  test("CASE-10: zero duplicate names across the assembled BUILTINS", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("CASE-11: session-bound names live ONLY in registry-session", () => {
    const sessionNames = new Set(SESSION_SLASH_COMMANDS.map((c) => c.name))
    const surfaceNames = new Set(SURFACE_SLASH_COMMANDS.map((c) => c.name))
    const appNames = new Set(APP_SLASH_COMMANDS.map((c) => c.name))
    for (const n of ["/retry-with", "/side", "/why", "/debug"]) {
      expect(sessionNames.has(n)).toBe(true)
      expect(surfaceNames.has(n)).toBe(false)
      expect(appNames.has(n)).toBe(false)
    }
  })

  test("CASE-12: app/system names live ONLY in registry-app", () => {
    const sessionNames = new Set(SESSION_SLASH_COMMANDS.map((c) => c.name))
    const surfaceNames = new Set(SURFACE_SLASH_COMMANDS.map((c) => c.name))
    const appNames = new Set(APP_SLASH_COMMANDS.map((c) => c.name))
    // env-gated `/rewind`+`/fork`+`/memory` are default-ON in the unit-test
    // environment (QUANTA_REWIND / QUANTA_MEMORY_SLASH unset).
    for (const n of [
      "/mcp",
      "/memory",
      "/rewind",
      "/fork",
      "/rewind-tool",
      "/rewind-conv",
      "/permission",
    ]) {
      expect(appNames.has(n)).toBe(true)
      expect(surfaceNames.has(n)).toBe(false)
      expect(sessionNames.has(n)).toBe(false)
    }
  })

  test("CASE-13: surface registry exposes a non-empty static SURFACE_SLASH_COMMANDS const", () => {
    // The closure-built variant lives in `buildSurfaceSlashCommands`; the
    // static export is the snapshot that ships with the layer in isolation.
    expect(SURFACE_SLASH_COMMANDS.every((c) => typeof c.name === "string")).toBe(true)
    expect(SURFACE_SLASH_COMMANDS.every((c) => typeof c.describe === "string")).toBe(true)
    expect(SURFACE_SLASH_COMMANDS.every((c) => typeof c.run === "function")).toBe(true)
  })

  test("CASE-14: slash-commands.ts public surface preserved (the four exports + types)", () => {
    const src = readSrc("src/apps/cli/slash-commands.ts")
    // Functional exports — every downstream caller still imports these
    // names from `./slash-commands`.
    expect(src).toMatch(/export const describeSlashCommand =/)
    expect(src).toMatch(/export const slashCompleter =/)
    expect(src).toMatch(/export const runSlashCommand =/)
    expect(src).toMatch(/export \{ isSlashCommand \}/)
    // BUILTINS continues to ship as a `readonly SlashCommand[]`.
    expect(src).toMatch(/export const BUILTINS:\s*readonly SlashCommand\[\]/)
    // Type re-exports — `declare module "./slash-commands"` extensions in
    // the per-command modules continue to resolve through this re-export.
    expect(src).toContain('from "./slash-contract"')
    expect(src).toContain('from "./slash-engine"')
  })

  test("CASE-15: slash-commands.ts contains NO inline command body (every cmd lives in a layer file)", () => {
    const src = readSrc("src/apps/cli/slash-commands.ts")
    // No `*Cmd: SlashCommand = {` literals leak back into the assembly —
    // every command must come from a layer file via spread.
    expect(src).not.toMatch(/^\s*const\s+\w+Cmd:\s*SlashCommand\s*=/m)
    // The composition is the spread of the three layers — pinned verbatim
    // so a regression that re-inlines a command is caught here.
    expect(src).toContain("...SURFACE_SLASH_COMMANDS")
    expect(src).toContain("...SESSION_SLASH_COMMANDS")
    expect(src).toContain("...APP_SLASH_COMMANDS")
  })
})
