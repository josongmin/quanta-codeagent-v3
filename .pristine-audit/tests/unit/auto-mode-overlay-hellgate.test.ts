/**
 * HELLGATE — jun-7-misc 04 (a): auto-mode user-rule overlay.
 *
 * Defect class
 * ------------
 * The auto-mode classifier system prompt (`CLASSIFIER_SYSTEM_PROMPT`) is a
 * frozen constant with NO operator-tunable boundary. This slice adds a pure,
 * default-OFF overlay composer (`withUserRuleOverlay`) + a fenced `@/rules →
 * AutoModeOverlay` adapter (`buildAutoModeOverlay`). The bugs this battery pins:
 *
 *  1. OFF byte-identity — `withUserRuleOverlay(base, undefined)` MUST return
 *     `base` UNCHANGED (===). If the composer ever mutates / re-templates the
 *     prompt absent an overlay, every auto-mode classification silently drifts.
 *  2. `$defaults` sentinel — a user list `["$defaults", "- X"]` ⇒ baseline THEN
 *     X (spliced once); a list WITHOUT `$defaults` ⇒ FULL REPLACE; empty ⇒
 *     baseline verbatim. (Differential against Claude's `YG_` semantics.)
 *  3. Precedence — operator `hard_deny` composes as an UNCONDITIONAL block line
 *     (no User-Intent clearing path); `soft_deny` is User-Intent-clearable.
 *  4. UNTRUSTED-SOURCE FENCE (security) — a `project`-layer (repo-controllable)
 *     `allow`/`hard_deny` is DROPPED (a repo cannot LOOSEN the AFK boundary);
 *     a `project`-layer `soft_deny` (tightening) IS applied. RED-ON-INJECTION:
 *     remove the fence and the project `allow` leaks into the prompt.
 *
 * Source under test:
 *   src/permission/classifier.ts — withUserRuleOverlay / mergeOverlayCategory
 *   src/permission/circumvention.ts — buildAutoModeOverlay (the fence)
 */
import { describe, expect, test } from "bun:test"
import {
  AUTO_MODE_BASELINES,
  AUTO_MODE_DEFAULTS_SENTINEL,
  type AutoModeOverlay,
  buildAutoModeOverlay,
  CLASSIFIER_SYSTEM_PROMPT,
  type LayeredRule,
  mergeOverlayCategory,
  withExfilScoutingTaxonomy,
  withUserRuleOverlay,
} from "@/permission"

describe("withUserRuleOverlay — OFF byte-identity (the ratchet)", () => {
  test("overlay === undefined ⇒ returns base UNCHANGED (===)", () => {
    const out = withUserRuleOverlay(CLASSIFIER_SYSTEM_PROMPT, undefined)
    // Same reference — not a re-composed copy.
    expect(out).toBe(CLASSIFIER_SYSTEM_PROMPT)
  })

  test("OFF is byte-identical to the scout-overlaid prompt too", () => {
    const scout = withExfilScoutingTaxonomy(CLASSIFIER_SYSTEM_PROMPT, true)
    expect(withUserRuleOverlay(scout, undefined)).toBe(scout)
  })

  test("present overlay GROWS the prompt (the four slots appear)", () => {
    const out = withUserRuleOverlay(CLASSIFIER_SYSTEM_PROMPT, { allow: ["- ok"] })
    expect(out.length).toBeGreaterThan(CLASSIFIER_SYSTEM_PROMPT.length)
    expect(out.startsWith(CLASSIFIER_SYSTEM_PROMPT)).toBe(true)
    expect(out).toContain("Operator Rules")
    expect(out).toContain("- ok")
    // The raw slot placeholders must be SUBSTITUTED, never left in the prompt.
    expect(out).not.toContain("<user_allow_rules_to_replace>")
    expect(out).not.toContain("<user_soft_deny_rules_to_replace>")
    expect(out).not.toContain("<user_hard_deny_rules_to_replace>")
    expect(out).not.toContain("<user_environment_to_replace>")
  })
})

describe("mergeOverlayCategory — $defaults sentinel (YG_ semantics)", () => {
  const baseline = ["- B1", "- B2"]

  test("empty / absent user list ⇒ baseline verbatim", () => {
    expect(mergeOverlayCategory(undefined, baseline)).toEqual(baseline)
    expect(mergeOverlayCategory([], baseline)).toEqual(baseline)
  })

  test("$defaults THEN extra ⇒ baseline spliced in, then extra", () => {
    const out = mergeOverlayCategory([AUTO_MODE_DEFAULTS_SENTINEL, "- X"], baseline)
    expect(out).toEqual(["- B1", "- B2", "- X"])
  })

  test("extra THEN $defaults ⇒ extra, then baseline (splice at position)", () => {
    const out = mergeOverlayCategory(["- X", AUTO_MODE_DEFAULTS_SENTINEL], baseline)
    expect(out).toEqual(["- X", "- B1", "- B2"])
  })

  test("$defaults spliced AT MOST ONCE", () => {
    const out = mergeOverlayCategory(
      [AUTO_MODE_DEFAULTS_SENTINEL, "- X", AUTO_MODE_DEFAULTS_SENTINEL],
      baseline,
    )
    // Second sentinel is a no-op — baseline appears once.
    expect(out).toEqual(["- B1", "- B2", "- X"])
  })

  test("list WITHOUT $defaults ⇒ FULL REPLACE (baseline dropped)", () => {
    const out = mergeOverlayCategory(["- only-mine"], baseline)
    expect(out).toEqual(["- only-mine"])
    expect(out).not.toContain("- B1")
  })
})

describe("precedence — hard_deny is unconditional, soft_deny is clearable", () => {
  test("hard_deny line composes under the UNCONDITIONAL header", () => {
    const out = withUserRuleOverlay(CLASSIFIER_SYSTEM_PROMPT, {
      hard_deny: ["- never touch prod"],
    })
    // The HARD_DENY section explicitly states User Intent does NOT clear it.
    expect(out).toMatch(/HARD_DENY[\s\S]*UNCONDITIONALLY[\s\S]*User Intent does NOT clear/)
    expect(out).toContain("- never touch prod")
  })

  test("soft_deny line composes under the User-Intent-clearable header", () => {
    const out = withUserRuleOverlay(CLASSIFIER_SYSTEM_PROMPT, {
      soft_deny: ["- prefer caution on rm"],
    })
    expect(out).toMatch(/SOFT_DENY[\s\S]*block unless User Intent clears/)
    expect(out).toContain("- prefer caution on rm")
  })

  test("the soft-deny BASELINE carries the named destructive categories", () => {
    // Sanity: the one-time baseline port is present (Git Destructive etc.).
    expect(AUTO_MODE_BASELINES.soft_deny.some((l) => /Git Destructive/.test(l))).toBe(true)
    expect(AUTO_MODE_BASELINES.soft_deny.some((l) => /Production Deploy/.test(l))).toBe(true)
  })
})

describe("UNTRUSTED-SOURCE FENCE — buildAutoModeOverlay (security, red-on-injection)", () => {
  const userAllow: LayeredRule = { action: "allow", prefix: "terraform apply", layer: "user" }
  const projectAllow: LayeredRule = { action: "allow", prefix: "rm -rf /prod", layer: "project" }
  const projectHard: LayeredRule = {
    action: "deny",
    prefix: "evil",
    layer: "project",
    hard: true,
  }
  const projectSoft: LayeredRule = { action: "deny", prefix: "deploy prod", layer: "project" }

  test("a TRUSTED user-layer allow IS applied", () => {
    const overlay = buildAutoModeOverlay([userAllow])
    expect(overlay?.allow).toEqual(["- terraform apply"])
  })

  test("a project-layer ALLOW is DROPPED (repo cannot LOOSEN the boundary)", () => {
    const overlay = buildAutoModeOverlay([projectAllow])
    // No allow carve-out leaks from the repo-controllable layer.
    expect(overlay).toBeUndefined()
  })

  test("a project-layer ALLOW never reaches the composed prompt", () => {
    const overlay = buildAutoModeOverlay([projectAllow])
    const prompt = withUserRuleOverlay(CLASSIFIER_SYSTEM_PROMPT, overlay)
    // The whole-prompt assertion is the red-on-injection guard: if the fence is
    // removed, `rm -rf /prod` shows up as an auto-approve carve-out.
    expect(prompt).not.toContain("rm -rf /prod")
    expect(prompt).toBe(CLASSIFIER_SYSTEM_PROMPT) // undefined overlay ⇒ byte-identical
  })

  test("a project-layer HARD_DENY is DEMOTED to soft_deny (not dropped, but not unconditional)", () => {
    const overlay = buildAutoModeOverlay([projectHard])
    expect(overlay?.hard_deny ?? []).toEqual([])
    expect(overlay?.soft_deny).toEqual(["- evil"])
  })

  test("a project-layer SOFT_DENY (tightening) IS applied", () => {
    const overlay = buildAutoModeOverlay([projectSoft])
    expect(overlay?.soft_deny).toEqual(["- deploy prod"])
  })

  test("a TRUSTED user-layer tagged hard deny IS an unconditional hard_deny", () => {
    const userHard: LayeredRule = {
      action: "deny",
      prefix: "drop database",
      layer: "user",
      hard: true,
    }
    const overlay = buildAutoModeOverlay([userHard])
    expect(overlay?.hard_deny).toEqual(["- drop database"])
  })

  test("`ask` rules contribute nothing to the overlay", () => {
    const ask: LayeredRule = { action: "ask", prefix: "git push", layer: "user" }
    expect(buildAutoModeOverlay([ask])).toBeUndefined()
  })

  test("no operator rules ⇒ undefined overlay (prompt stays byte-identical)", () => {
    expect(buildAutoModeOverlay([])).toBeUndefined()
  })
})

describe("end-to-end fence ratchet — mixed layers", () => {
  test("only the trusted-allow + both soft-denies survive; project allow/hard are fenced", () => {
    const rules: LayeredRule[] = [
      { action: "allow", prefix: "terraform apply", layer: "user" },
      { action: "allow", prefix: "rm -rf /prod", layer: "project" }, // FENCED
      { action: "deny", prefix: "force push", layer: "user" }, // soft
      { action: "deny", prefix: "deploy prod", layer: "project" }, // soft (tighten ok)
      { action: "deny", prefix: "wipe", layer: "project", hard: true }, // DEMOTED→soft
    ]
    const overlay = buildAutoModeOverlay(rules) as AutoModeOverlay
    expect(overlay.allow).toEqual(["- terraform apply"])
    expect(overlay.hard_deny ?? []).toEqual([])
    expect(overlay.soft_deny).toEqual(["- force push", "- deploy prod", "- wipe"])
    const prompt = withUserRuleOverlay(CLASSIFIER_SYSTEM_PROMPT, overlay)
    expect(prompt).not.toContain("rm -rf /prod")
  })
})
