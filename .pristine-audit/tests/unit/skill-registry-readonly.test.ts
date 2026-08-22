/**
 * ADR-0330 — Read-only `SkillRegistry` view adapter.
 *
 * The adapter is consumed by `@/agent/mention-runner`'s skill resolver.
 * Coverage:
 *
 *  1. Empty registry (no entries) ⇒ lookup returns null
 *  2. Registered skill ⇒ lookup returns `{ name, description }`
 *  3. Unregistered name ⇒ null
 *  4. Empty / undefined name input ⇒ null (no throw, no call-through)
 *  5. Hostile underlying registry (throws) ⇒ null (NO-THROW)
 *  6. Malformed entry (missing `skill`) ⇒ null
 *  7. Malformed entry (non-string description) ⇒ null
 *  8. `emptyReadOnlySkillRegistry` ⇒ always null
 *  9. Case sensitivity — lookup is exact-match (no canonicalization)
 *
 * Total = 9 cases (>= the required 4).
 */
import { describe, expect, test } from "bun:test"
import type { SkillRegistry, SkillRegistryEntry } from "@/skill"
import { createReadOnlySkillRegistry, emptyReadOnlySkillRegistry } from "@/skill/registry-readonly"

/** Build a minimal `SkillRegistry`-shaped stub that only implements `lookup`. */
const stubRegistry = (
  table: Readonly<Record<string, SkillRegistryEntry>>,
): Pick<SkillRegistry, "lookup"> => ({
  lookup(name: string) {
    return table[name]
  },
})

/** Minimal `SkillRegistryEntry` shape for tests. The adapter only reads
 *  `entry.skill.name` + `entry.skill.description`; everything else is
 *  filler. We mark `as unknown as SkillRegistryEntry` so the test file
 *  doesn't need to repeat the full ADR-0134 envelope. */
const entry = (name: string, description: string): SkillRegistryEntry =>
  ({
    skill: {
      name,
      description,
      body: "",
      sourcePath: `/tmp/${name}/SKILL.md`,
      scope: "user",
    },
    winnerScope: "user",
    overriddenScopes: [],
  }) as unknown as SkillRegistryEntry

describe("createReadOnlySkillRegistry — ADR-0330", () => {
  test("1 — empty registry ⇒ lookup returns null", () => {
    const view = createReadOnlySkillRegistry(stubRegistry({}))
    expect(view.lookup("any")).toBeNull()
  })

  test("2 — registered skill ⇒ lookup returns { name, description }", () => {
    const view = createReadOnlySkillRegistry(
      stubRegistry({ "code-review": entry("code-review", "Review the diff") }),
    )
    expect(view.lookup("code-review")).toEqual({
      name: "code-review",
      description: "Review the diff",
    })
  })

  test("3 — unregistered name ⇒ null", () => {
    const view = createReadOnlySkillRegistry(stubRegistry({ alpha: entry("alpha", "A") }))
    expect(view.lookup("beta")).toBeNull()
  })

  test("4 — empty / undefined name input ⇒ null (no throw, no call-through)", () => {
    let called = 0
    const view = createReadOnlySkillRegistry({
      lookup(_name: string) {
        called += 1
        return undefined
      },
    })
    expect(view.lookup("")).toBeNull()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile-input cast
    expect(view.lookup(undefined as any)).toBeNull()
    expect(called).toBe(0)
  })

  test("5 — hostile registry (lookup throws) ⇒ null, no escape", () => {
    const view = createReadOnlySkillRegistry({
      lookup() {
        throw new Error("boom")
      },
    })
    expect(view.lookup("anything")).toBeNull()
  })

  test("6 — malformed entry: missing skill field ⇒ null", () => {
    // Cast through unknown to bypass the static type — the adapter MUST
    // tolerate a registry that returns a shape failing the boundary check.
    const malformedNoSkill = { winnerScope: "user", overriddenScopes: [] } as unknown as
      | SkillRegistryEntry
      | undefined
    const view = createReadOnlySkillRegistry({
      lookup: () => malformedNoSkill,
    })
    expect(view.lookup("x")).toBeNull()
  })

  test("7 — malformed entry: non-string description ⇒ null", () => {
    const malformedDesc = {
      skill: { name: "x", description: 42 },
      winnerScope: "user",
      overriddenScopes: [],
    } as unknown as SkillRegistryEntry
    const view = createReadOnlySkillRegistry({
      lookup: () => malformedDesc,
    })
    expect(view.lookup("x")).toBeNull()
  })

  test("8 — emptyReadOnlySkillRegistry ⇒ always null", () => {
    expect(emptyReadOnlySkillRegistry.lookup("x")).toBeNull()
    expect(emptyReadOnlySkillRegistry.lookup("")).toBeNull()
  })

  test("9 — case sensitivity: lookup is exact-match (no canonicalization)", () => {
    const view = createReadOnlySkillRegistry(stubRegistry({ alpha: entry("alpha", "A") }))
    // The mention parser only emits lowercase targets; uppercase lookup
    // is a no-op pass-through (returns null since the registry has no
    // "Alpha" key). Documented as a limitation, not a TODO.
    expect(view.lookup("Alpha")).toBeNull()
    expect(view.lookup("alpha")).toEqual({ name: "alpha", description: "A" })
  })
})
