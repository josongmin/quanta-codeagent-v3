/**
 * RulesStore tests — locks the 3-layer precedence contract
 * (project > user > system) and the atomic load / clear semantics.
 *
 * The single most important invariant: a higher-precedence layer ALWAYS
 * wins, even when its match is a SHORTER prefix than a lower layer's
 * match. This makes project overrides predictable.
 */
import { describe, expect, test } from "bun:test"
import { RuleParseError, RulesStore } from "@/rules"

describe("RulesStore — empty / default state", () => {
  test("empty store returns no_match for any command", () => {
    const store = new RulesStore()
    expect(store.match("git status").kind).toBe("no_match")
    expect(store.match("anything at all").kind).toBe("no_match")
  })

  test("empty store snapshot has empty arrays for all three layers", () => {
    const store = new RulesStore()
    const snap = store.snapshot()
    expect(snap.system).toEqual([])
    expect(snap.user).toEqual([])
    expect(snap.project).toEqual([])
  })
})

describe("RulesStore — single-layer behaviour", () => {
  test("system-layer rule fires when no other layer is loaded", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow git status", "system.rules")
    const outcome = store.match("git status --short")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("system")
    }
  })

  test("user-layer rule fires when no other layer is loaded", () => {
    const store = new RulesStore()
    store.loadLayer("user", "deny rm -rf", "user.rules")
    const outcome = store.match("rm -rf /")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("user")
      expect(outcome.rule.action).toBe("deny")
    }
  })

  test("project-layer rule fires when no other layer is loaded", () => {
    const store = new RulesStore()
    store.loadLayer("project", "ask git push", "project.rules")
    const outcome = store.match("git push origin main")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("project")
      expect(outcome.rule.action).toBe("ask")
    }
  })
})

describe("RulesStore — layer precedence (project > user > system)", () => {
  test("project rule overrides a matching user rule on the same prefix", () => {
    const store = new RulesStore()
    store.loadLayer("user", "deny git push", "user.rules")
    store.loadLayer("project", "allow git push", "project.rules")
    const outcome = store.match("git push origin main")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("project")
      expect(outcome.rule.action).toBe("allow")
    }
  })

  test("user rule overrides a matching system rule on the same prefix", () => {
    const store = new RulesStore()
    store.loadLayer("system", "deny git push", "system.rules")
    store.loadLayer("user", "allow git push", "user.rules")
    const outcome = store.match("git push origin main")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("user")
    }
  })

  test("project SHORT prefix wins over a lower-layer LONGER prefix", () => {
    // This is the load-bearing invariant — layer precedence beats
    // longest-prefix-match. A project override must be authoritative.
    const store = new RulesStore()
    store.loadLayer("system", "allow git push --force", "system.rules")
    store.loadLayer("project", "deny git push", "project.rules")
    const outcome = store.match("git push --force origin")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("project")
      expect(outcome.rule.action).toBe("deny")
      expect(outcome.rule.prefix).toBe("git push")
    }
  })

  test("user SHORT prefix wins over a system LONGER prefix", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow git push --force", "system.rules")
    store.loadLayer("user", "ask git push", "user.rules")
    const outcome = store.match("git push --force origin")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("user")
      expect(outcome.rule.action).toBe("ask")
    }
  })

  test("longest-prefix-match still applies WITHIN a layer", () => {
    const store = new RulesStore()
    store.loadLayer("system", ["allow git", "deny git push --force"].join("\n"), "system.rules")
    const outcome = store.match("git push --force origin")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.action).toBe("deny")
    }
  })

  test("lower-layer rule fires when higher layers have no match", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow ls", "system.rules")
    store.loadLayer("user", "allow git status", "user.rules")
    store.loadLayer("project", "allow npm test", "project.rules")
    const outcome = store.match("ls -la")
    expect(outcome.kind).toBe("matched")
    if (outcome.kind === "matched") {
      expect(outcome.rule.layer).toBe("system")
    }
  })
})

describe("RulesStore — clear / replace semantics", () => {
  test("clear() removes only the targeted layer", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow a", "s.rules")
    store.loadLayer("user", "allow b", "u.rules")
    store.loadLayer("project", "allow c", "p.rules")
    store.clear("user")
    expect(store.match("a").kind).toBe("matched")
    expect(store.match("b").kind).toBe("no_match")
    expect(store.match("c").kind).toBe("matched")
  })

  test("loadLayer() REPLACES the previous contents of that layer (no merge)", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow a", "s.rules")
    store.loadLayer("system", "allow b", "s.rules")
    expect(store.match("a").kind).toBe("no_match")
    expect(store.match("b").kind).toBe("matched")
  })

  test("loadLayer() is atomic: a parse error leaves the layer untouched", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow a", "s.rules")
    expect(() => store.loadLayer("system", "bogus c", "bad.rules")).toThrow(RuleParseError)
    // Pre-existing rule still fires — the failed load did NOT clobber it.
    expect(store.match("a").kind).toBe("matched")
  })
})

describe("RulesStore — snapshot immutability", () => {
  test("snapshot() is a frozen object", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow a", "s.rules")
    const snap = store.snapshot()
    expect(Object.isFrozen(snap)).toBe(true)
  })

  test("snapshot arrays are frozen (cannot be mutated by callers)", () => {
    const store = new RulesStore()
    store.loadLayer("project", "allow a", "p.rules")
    const snap = store.snapshot()
    expect(Object.isFrozen(snap.project)).toBe(true)
  })

  test("snapshot reflects subsequent loads via NEW snapshots only", () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow a", "s.rules")
    const snapBefore = store.snapshot()
    expect(snapBefore.system).toHaveLength(1)

    store.loadLayer("system", "allow a\nallow b", "s.rules")
    const snapAfter = store.snapshot()

    // The earlier snapshot is NOT mutated (loadLayer installs a new array).
    expect(snapBefore.system).toHaveLength(1)
    expect(snapAfter.system).toHaveLength(2)
  })
})

describe("RulesStore — composite end-to-end", () => {
  test("realistic 3-layer policy: system allows, user asks, project denies", () => {
    const store = new RulesStore()
    store.loadLayer(
      "system",
      ["allow git status", "allow git diff", "allow ls", "allow npm test"].join("\n"),
      "system.rules",
    )
    store.loadLayer("user", "ask git push", "user.rules")
    store.loadLayer("project", "deny git push --force", "project.rules")

    // 1. Pure system allow.
    expect(store.match("git status --short").kind).toBe("matched")

    // 2. User ask wins for plain git push (project has no general rule).
    const ask = store.match("git push origin main")
    expect(ask.kind).toBe("matched")
    if (ask.kind === "matched") expect(ask.rule.action).toBe("ask")

    // 3. Project deny wins for force push (layer beats specificity).
    const denied = store.match("git push --force origin main")
    expect(denied.kind).toBe("matched")
    if (denied.kind === "matched") {
      expect(denied.rule.action).toBe("deny")
      expect(denied.rule.layer).toBe("project")
    }

    // 4. Unknown command falls through to no_match.
    expect(store.match("curl https://example.com").kind).toBe("no_match")
  })
})
