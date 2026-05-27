/**
 * ADR-0336 — Composite mention resolver hellgate.
 *
 *   A. Empty deps ⇒ every kind returns null    (1)
 *   B. Skill-only deps ⇒ plugin/app frozen     (1)
 *   C. Plugin-only deps ⇒ skill/app frozen     (1)
 *   D. App-only deps ⇒ skill/plugin frozen     (1)
 *   E. All three deps wired ⇒ all three resolve(1)
 *   F. Kind-dispatch isolation (no fallthrough)(1)
 *   G. NO-THROW across all three sub-resolvers (1)
 *
 * Total = 7 cases (>= the required 6).
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryAppCatalog } from "@/agent/app-catalog"
import { createInMemoryPluginRegistry } from "@/agent/plugin-discovery"
import { createCompositeMentionResolver } from "../composite-resolver"
import type { SkillRegistryReadOnly } from "../types"

const fakeSkills = (table: Readonly<Record<string, string>>): SkillRegistryReadOnly => ({
  lookup(name: string) {
    const desc = table[name]
    return desc === undefined ? null : { name, description: desc }
  },
})

describe("createCompositeMentionResolver — ADR-0336 hellgate", () => {
  // -------- A. empty deps ----------------------------------------

  test("A1 — empty deps ⇒ all three kinds return null", () => {
    const port = createCompositeMentionResolver()
    expect(port.resolveSkill?.("any")).toBeNull()
    expect(port.resolvePlugin?.("any")).toBeNull()
    expect(port.resolveApp?.("any")).toBeNull()
  })

  // -------- B. skill-only ----------------------------------------

  test("B1 — skill-only deps ⇒ plugin/app still null, skill works", () => {
    const port = createCompositeMentionResolver({
      skills: fakeSkills({ "code-review": "Review the diff" }),
    })
    expect(port.resolveSkill?.("code-review")).toEqual({ bodyText: "Review the diff" })
    expect(port.resolvePlugin?.("code-review")).toBeNull()
    expect(port.resolveApp?.("code-review")).toBeNull()
  })

  // -------- C. plugin-only ---------------------------------------

  test("C1 — plugin-only deps ⇒ skill/app null, plugin works", () => {
    const port = createCompositeMentionResolver({
      plugins: createInMemoryPluginRegistry([
        { id: "gh", name: "GitHub", capabilities: ["Read"], description: "GH desc" },
      ]),
    })
    expect(port.resolveSkill?.("gh")).toBeNull()
    expect(port.resolvePlugin?.("gh")).toEqual({ bodyText: "GH desc" })
    expect(port.resolveApp?.("gh")).toBeNull()
  })

  // -------- D. app-only ------------------------------------------

  test("D1 — app-only deps ⇒ skill/plugin null, app works", () => {
    const port = createCompositeMentionResolver({
      apps: createInMemoryAppCatalog([
        { id: "browser", surface: "cli-browser", description: "the browser" },
      ]),
    })
    expect(port.resolveSkill?.("browser")).toBeNull()
    expect(port.resolvePlugin?.("browser")).toBeNull()
    expect(port.resolveApp?.("browser")).toEqual({
      bodyText: "surface: cli-browser — the browser",
    })
  })

  // -------- E. all three wired -----------------------------------

  test("E1 — all three deps wired ⇒ each kind resolves independently", () => {
    const port = createCompositeMentionResolver({
      skills: fakeSkills({ s: "skill body" }),
      plugins: createInMemoryPluginRegistry([
        { id: "p", name: "Plug", capabilities: [], description: "plug body" },
      ]),
      apps: createInMemoryAppCatalog([{ id: "a", surface: "cli", description: "app body" }]),
    })
    expect(port.resolveSkill?.("s")).toEqual({ bodyText: "skill body" })
    expect(port.resolvePlugin?.("p")).toEqual({ bodyText: "plug body" })
    expect(port.resolveApp?.("a")).toEqual({ bodyText: "surface: cli — app body" })
  })

  // -------- F. kind-dispatch isolation ---------------------------

  test("F1 — same target across kinds resolves independently (no fallthrough)", () => {
    // Three deps all keyed by "shared" — confirm each method consults
    // ONLY its own registry / catalog (no cross-kind fallback).
    const port = createCompositeMentionResolver({
      skills: fakeSkills({ shared: "skill-shared" }),
      plugins: createInMemoryPluginRegistry([
        { id: "shared", name: "PluginShared", capabilities: [], description: "plugin-shared" },
      ]),
      apps: createInMemoryAppCatalog([
        { id: "shared", surface: "cli-browser", description: "app-shared" },
      ]),
    })
    expect(port.resolveSkill?.("shared")?.bodyText).toBe("skill-shared")
    expect(port.resolvePlugin?.("shared")?.bodyText).toBe("plugin-shared")
    expect(port.resolveApp?.("shared")?.bodyText).toBe("surface: cli-browser — app-shared")
  })

  // -------- G. NO-THROW across all three -------------------------

  test("G1 — hostile dep throws on every kind ⇒ all three return null", () => {
    const throwingSkills: SkillRegistryReadOnly = {
      lookup() {
        throw new Error("skill boom")
      },
    }
    const throwingPlugins = {
      lookup() {
        throw new Error("plugin boom")
      },
      list: () => [],
    }
    const throwingApps = {
      lookup() {
        throw new Error("app boom")
      },
      list: () => [],
    }
    const port = createCompositeMentionResolver({
      skills: throwingSkills,
      plugins: throwingPlugins,
      apps: throwingApps,
    })
    expect(port.resolveSkill?.("x")).toBeNull()
    expect(port.resolvePlugin?.("x")).toBeNull()
    expect(port.resolveApp?.("x")).toBeNull()
  })
})
