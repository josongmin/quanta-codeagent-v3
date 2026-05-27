/**
 * ADR-0339 — `resolvePluginSkillsForActivation` hellgate.
 *
 * Coverage (≥14):
 *   A. empty skillNames                                   → []
 *   B. single registry hit                                → 1 descriptor
 *   C. single registry miss                               → drop
 *   D. mixed hit + miss                                   → hit only
 *   E. multiple all-hit                                   → all returned
 *   F. emit hook present                                  → 1 emit / hit, trigger="auto" default
 *   G. emit hook absent                                   → no emit, descriptors fine
 *   H. emit hook throws                                   → swallowed, descriptor returned (NO-THROW)
 *   I. registry.lookup throws                             → drop entry (NO-THROW)
 *   J. opts.trigger="user"                                → event.trigger="user"
 *   K. opts.at=1000                                       → event.at=1000
 *   L. opts.turnId="t-7"                                  → event.turnId="t-7"
 *   M. empty skillNames + emit                            → no emit
 *   N. order preserved through resolve                    → input order kept
 */

import { describe, expect, test } from "bun:test"
import type { SkillRegistryReadOnly } from "@/skill/registry-readonly"
import { resolvePluginSkillsForActivation } from "../extender"
import type { PluginSkillExtensionConfig, SkillActivationEventLike } from "../types"

/** Build a stub read-only registry from a name → description map. */
const makeRegistry = (map: Record<string, string>): SkillRegistryReadOnly => ({
  lookup: (name: string) => {
    const description = map[name]
    return description === undefined ? null : { name, description }
  },
})

/** Throwing registry for NO-THROW coverage. */
const throwingRegistry: SkillRegistryReadOnly = {
  lookup: () => {
    throw new Error("boom")
  },
}

describe("resolvePluginSkillsForActivation — ADR-0339 hellgate", () => {
  test("A. empty skillNames returns empty array", () => {
    const cfg: PluginSkillExtensionConfig = { registry: makeRegistry({}) }
    const out = resolvePluginSkillsForActivation([], cfg)
    expect(out).toEqual([])
  })

  test("B. single registry hit ⇒ one descriptor", () => {
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ "pr-review": "Review pull requests" }),
    }
    const out = resolvePluginSkillsForActivation(["pr-review"], cfg)
    expect(out).toEqual([{ name: "pr-review", description: "Review pull requests" }])
  })

  test("C. registry miss ⇒ entry dropped", () => {
    const cfg: PluginSkillExtensionConfig = { registry: makeRegistry({}) }
    const out = resolvePluginSkillsForActivation(["does-not-exist"], cfg)
    expect(out).toEqual([])
  })

  test("D. mixed hit + miss ⇒ only hit returned", () => {
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ "pr-review": "Review PRs" }),
    }
    const out = resolvePluginSkillsForActivation(["pr-review", "missing", "another-miss"], cfg)
    expect(out).toEqual([{ name: "pr-review", description: "Review PRs" }])
  })

  test("E. multiple all-hit ⇒ all returned", () => {
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({
        "pr-review": "Review PRs",
        "issue-triage": "Triage issues",
        changelog: "Maintain changelog",
      }),
    }
    const out = resolvePluginSkillsForActivation(["pr-review", "issue-triage", "changelog"], cfg)
    expect(out).toEqual([
      { name: "pr-review", description: "Review PRs" },
      { name: "issue-triage", description: "Triage issues" },
      { name: "changelog", description: "Maintain changelog" },
    ])
  })

  test("F. emit hook present ⇒ fires once per hit with trigger='auto'", () => {
    const events: SkillActivationEventLike[] = []
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ a: "A", b: "B" }),
      emit: (e) => {
        events.push(e)
      },
    }
    const out = resolvePluginSkillsForActivation(["a", "b"], cfg, { at: 42 })
    expect(out).toHaveLength(2)
    expect(events).toHaveLength(2)
    expect(events[0]?.kind).toBe("skill_activation")
    expect(events[0]?.skillId).toBe("a")
    expect(events[0]?.trigger).toBe("auto")
    expect(events[1]?.skillId).toBe("b")
    expect(events[1]?.trigger).toBe("auto")
  })

  test("G. emit hook absent ⇒ no throw, descriptor returned", () => {
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ x: "X" }),
    }
    const out = resolvePluginSkillsForActivation(["x"], cfg)
    expect(out).toEqual([{ name: "x", description: "X" }])
  })

  test("H. emit hook throws ⇒ swallowed, descriptor returned (NO-THROW)", () => {
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ x: "X", y: "Y" }),
      emit: () => {
        throw new Error("downstream sink exploded")
      },
    }
    const out = resolvePluginSkillsForActivation(["x", "y"], cfg)
    expect(out).toEqual([
      { name: "x", description: "X" },
      { name: "y", description: "Y" },
    ])
  })

  test("I. registry.lookup throws ⇒ entry dropped (NO-THROW)", () => {
    const cfg: PluginSkillExtensionConfig = { registry: throwingRegistry }
    const out = resolvePluginSkillsForActivation(["any"], cfg)
    expect(out).toEqual([])
  })

  test("J. opts.trigger='user' propagates to emitted event", () => {
    const events: SkillActivationEventLike[] = []
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ s: "S" }),
      emit: (e) => events.push(e),
    }
    resolvePluginSkillsForActivation(["s"], cfg, { trigger: "user", at: 1 })
    expect(events[0]?.trigger).toBe("user")
  })

  test("K. opts.at=1000 stamps event.at", () => {
    const events: SkillActivationEventLike[] = []
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ s: "S" }),
      emit: (e) => events.push(e),
    }
    resolvePluginSkillsForActivation(["s"], cfg, { at: 1000 })
    expect(events[0]?.at).toBe(1000)
  })

  test("L. opts.turnId propagates to event.turnId", () => {
    const events: SkillActivationEventLike[] = []
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ s: "S" }),
      emit: (e) => events.push(e),
    }
    resolvePluginSkillsForActivation(["s"], cfg, { at: 1, turnId: "t-7" })
    expect(events[0]?.turnId).toBe("t-7")
  })

  test("M. empty skillNames + emit ⇒ no emit", () => {
    const events: SkillActivationEventLike[] = []
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ s: "S" }),
      emit: (e) => events.push(e),
    }
    const out = resolvePluginSkillsForActivation([], cfg, { at: 1 })
    expect(out).toEqual([])
    expect(events).toHaveLength(0)
  })

  test("N. order of input skillNames is preserved in result", () => {
    const cfg: PluginSkillExtensionConfig = {
      registry: makeRegistry({ c: "C", b: "B", a: "A" }),
    }
    const out = resolvePluginSkillsForActivation(["c", "b", "a"], cfg)
    expect(out.map((d) => d.name)).toEqual(["c", "b", "a"])
  })
})
