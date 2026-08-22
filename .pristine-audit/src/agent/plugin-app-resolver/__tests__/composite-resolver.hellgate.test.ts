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

describe("createCompositeMentionResolver — ADR-0336/0418 async hellgate", () => {
  // -------- A. empty deps ----------------------------------------

  test("A1 — empty deps ⇒ all three kinds return null", async () => {
    const port = createCompositeMentionResolver()
    expect(await port.resolveSkill?.("any")).toBeNull()
    expect(await port.resolvePlugin?.("any")).toBeNull()
    expect(await port.resolveApp?.("any")).toBeNull()
  })

  // -------- B. skill-only ----------------------------------------

  test("B1 — skill-only deps ⇒ plugin/app still null, skill works", async () => {
    const port = createCompositeMentionResolver({
      skills: fakeSkills({ "code-review": "Review the diff" }),
    })
    expect(await port.resolveSkill?.("code-review")).toEqual({ bodyText: "Review the diff" })
    expect(await port.resolvePlugin?.("code-review")).toBeNull()
    expect(await port.resolveApp?.("code-review")).toBeNull()
  })

  // -------- C. plugin-only ---------------------------------------

  test("C1 — plugin-only deps ⇒ skill/app null, plugin works", async () => {
    const port = createCompositeMentionResolver({
      plugins: createInMemoryPluginRegistry([
        { id: "gh", name: "GitHub", capabilities: ["Read"], description: "GH desc" },
      ]),
    })
    expect(await port.resolveSkill?.("gh")).toBeNull()
    expect(await port.resolvePlugin?.("gh")).toEqual({ bodyText: "GH desc" })
    expect(await port.resolveApp?.("gh")).toBeNull()
  })

  // -------- D. app-only ------------------------------------------

  test("D1 — app-only deps ⇒ skill/plugin null, app works", async () => {
    const port = createCompositeMentionResolver({
      apps: createInMemoryAppCatalog([
        { id: "browser", surface: "cli-browser", description: "the browser" },
      ]),
    })
    expect(await port.resolveSkill?.("browser")).toBeNull()
    expect(await port.resolvePlugin?.("browser")).toBeNull()
    expect(await port.resolveApp?.("browser")).toEqual({
      bodyText: "surface: cli-browser — the browser",
    })
  })

  // -------- E. all three wired -----------------------------------

  test("E1 — all three deps wired ⇒ each kind resolves independently", async () => {
    const port = createCompositeMentionResolver({
      skills: fakeSkills({ s: "skill body" }),
      plugins: createInMemoryPluginRegistry([
        { id: "p", name: "Plug", capabilities: [], description: "plug body" },
      ]),
      apps: createInMemoryAppCatalog([{ id: "a", surface: "cli", description: "app body" }]),
    })
    expect(await port.resolveSkill?.("s")).toEqual({ bodyText: "skill body" })
    expect(await port.resolvePlugin?.("p")).toEqual({ bodyText: "plug body" })
    expect(await port.resolveApp?.("a")).toEqual({ bodyText: "surface: cli — app body" })
  })

  // -------- F. kind-dispatch isolation ---------------------------

  test("F1 — same target across kinds resolves independently (no fallthrough)", async () => {
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
    expect((await port.resolveSkill?.("shared"))?.bodyText).toBe("skill-shared")
    expect((await port.resolvePlugin?.("shared"))?.bodyText).toBe("plugin-shared")
    expect((await port.resolveApp?.("shared"))?.bodyText).toBe("surface: cli-browser — app-shared")
  })

  // -------- G. NO-THROW across all three -------------------------

  test("G1 — hostile dep throws on every kind ⇒ all three return null", async () => {
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
    expect(await port.resolveSkill?.("x")).toBeNull()
    expect(await port.resolvePlugin?.("x")).toBeNull()
    expect(await port.resolveApp?.("x")).toBeNull()
  })
})
