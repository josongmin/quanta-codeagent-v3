/**
 * B1 hellgate — product-onboarding system skill (jul-03 competitor UX absorption).
 *
 * A prompt-only system skill for FIRST-USER onboarding (get-started flow),
 * distinct from the existing repo-recon `onboard` skill (cold-start repomap of
 * an unfamiliar codebase). The two have INVERTED semantics:
 *
 *   - `onboard`          → developer meets an unfamiliar REPO (read-only recon)
 *   - `product-onboard`  → new USER meets the PRODUCT (guided first task via update_plan)
 *
 * THE risk this hellgate pins is name/trigger COLLISION: the model must be able
 * to pick the right skill. So `product-onboard` carries a DISTINCT kebab name
 * (≠ `onboard`) and sharp, non-overlapping triggers ("onboard me" / "get
 * started" / "first task" / "new user"), and its body is a 5-step `update_plan`
 * contract (role-picker → connect-context → first-task → first-artifact → recap)
 * reusing the existing plan seam — NO onboarding-specific plan tool.
 *
 * Cases:
 *   HELL-PO-1  strict schema (`parseSkillMarkdown`) parses the SKILL.md AND the
 *              frontmatter is exactly the 6-field SSOT shape; name is kebab and
 *              NOT `onboard`; allowedTools includes `update_plan`; userInvocable;
 *              category=skill; stability=experimental.
 *   HELL-PO-2  discoverable via `discoverSystemSkills()` with scope=system,
 *              tools carry `update_plan`, and system-skills win on name collision
 *              (the discovered `product-onboard` is the bundled one).
 *   HELL-PO-3  body is the 5-step update_plan contract (all five phases named +
 *              cites `update_plan`), and triggers are non-overlapping with the
 *              repo-recon `onboard` skill (no "낯선 레포"/"repo 파악"/"explain this
 *              codebase" leakage; the `onboard` skill does not steal the new
 *              product-onboarding triggers).
 *   HELL-PO-4  IdentityMode `onboarding` is reachable from the CLI token table:
 *              VALID_IDENTITY_MODES includes 'onboarding' and the type guard
 *              accepts it — parity with DEFAULT_IDENTITIES / IDENTITY_MODES.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { discoverSystemSkills } from "@/skill"
import { parseSkillMarkdown } from "@/skill/skill-frontmatter"

const SKILL_ROOT = join(import.meta.dir, "..", "..", "src", "skill", "system-skills")
const PO_DIR = "product-onboard"
const PO_PATH = join(SKILL_ROOT, PO_DIR, "SKILL.md")

const readRaw = (): string => {
  expect(existsSync(PO_PATH), `expected SKILL.md at ${PO_PATH}`).toBe(true)
  return readFileSync(PO_PATH, "utf8")
}

describe("B1 — product-onboard system skill (hellgate)", () => {
  test("HELL-PO-1: strict schema parses; 6-field SSOT; name is kebab and != onboard; allowedTools includes update_plan", () => {
    const raw = readRaw()
    const parsed = parseSkillMarkdown(raw)
    // Loud-failure strict schema MUST accept the SKILL.md verbatim.
    expect(
      parsed.ok,
      parsed.ok ? "" : `strict parse failed: ${parsed.error.message}`,
    ).toBe(true)
    if (!parsed.ok) return
    const fm = parsed.value.frontmatter

    // Distinct kebab name — NOT the repo-recon `onboard` skill.
    expect(fm.name).toBe(PO_DIR)
    expect(fm.name).not.toBe("onboard")
    expect(/^[a-z0-9][a-z0-9-]*$/.test(fm.name), "name must be kebab-case").toBe(true)

    // 6-field SSOT contract.
    expect(fm.userInvocable).toBe(true)
    expect(fm.category).toBe("skill")
    expect(fm.stability).toBe("experimental")
    expect(fm.description.length).toBeGreaterThan(40)

    // allowedTools MUST include the shared plan seam.
    expect(Array.isArray(fm.allowedTools)).toBe(true)
    expect(fm.allowedTools).toContain("update_plan")
  })

  test("HELL-PO-2: discoverable via discoverSystemSkills() with scope=system + update_plan in tools (system wins on collision)", async () => {
    const all = await discoverSystemSkills()
    const found = all.filter((s) => s.name === PO_DIR)
    // Exactly one bundled product-onboard (system-skills win on name collision).
    expect(found.length, "product-onboard must be discovered exactly once").toBe(1)
    const skill = found[0]
    expect(skill?.scope).toBe("system")
    expect(skill?.tools ?? [], "discovered tools must carry update_plan").toContain("update_plan")
    expect((skill?.body ?? "").length).toBeGreaterThan(0)

    // The distinct repo-recon `onboard` skill still exists SEPARATELY (no
    // shadowing / rename collision).
    expect(all.some((s) => s.name === "onboard"), "repo-recon onboard must remain").toBe(true)
  })

  test("HELL-PO-3: body is the 5-step update_plan contract; triggers do NOT overlap the repo-recon onboard skill", () => {
    const raw = readRaw()
    const parsed = parseSkillMarkdown(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const body = parsed.value.body
    const fm = parsed.value.frontmatter

    // 5-step contract: every phase named in the body.
    for (const phase of [
      "role-picker",
      "connect-context",
      "first-task",
      "first-artifact",
      "recap",
    ]) {
      expect(body.includes(phase), `body must name the "${phase}" step`).toBe(true)
    }
    // The body must drive the shared plan seam by name.
    expect(body.includes("update_plan"), "body must cite update_plan").toBe(true)

    // Non-overlapping triggers: the product-onboarding surface (name +
    // description) must carry its OWN sharp triggers and must NOT reuse the
    // repo-recon onboard skill's cold-start-repo trigger phrases. This is THE
    // collision guard — if these leak, the model can't disambiguate.
    const surface = `${fm.name} ${fm.description}`.toLowerCase()
    for (const productTrigger of ["get started", "first task", "new user"]) {
      expect(surface.includes(productTrigger), `must own trigger "${productTrigger}"`).toBe(true)
    }
    for (const repoReconTrigger of ["낯선 레포", "repo 파악", "explain this codebase", "구조 파악"]) {
      expect(
        surface.includes(repoReconTrigger.toLowerCase()),
        `must NOT steal repo-recon trigger "${repoReconTrigger}"`,
      ).toBe(false)
    }

    // Conversely: the repo-recon onboard skill must NOT have absorbed the new
    // product-onboarding triggers (guards the inverse-collision direction).
    const onboardRaw = readFileSync(join(SKILL_ROOT, "onboard", "SKILL.md"), "utf8")
    const onboardParsed = parseSkillMarkdown(onboardRaw)
    expect(onboardParsed.ok).toBe(true)
    if (onboardParsed.ok) {
      const onboardSurface = onboardParsed.value.frontmatter.description.toLowerCase()
      expect(
        onboardSurface.includes("first task"),
        "repo-recon onboard must not claim 'first task'",
      ).toBe(false)
    }
  })

  test("HELL-PO-4: IdentityMode 'onboarding' is reachable from the CLI token table (VALID_IDENTITY_MODES parity)", async () => {
    // agent-args is the CLI token SSOT; assert onboarding is now a valid
    // --identity-mode token (was in DEFAULT_IDENTITIES/IDENTITY_MODES but
    // omitted from the CLI-facing set).
    // Ground-truth: parse a full CLI invocation with --identity-mode onboarding.
    // (`--mode interactive` is required by the parser; it is orthogonal to the
    // identity-mode axis under test.)
    const { parseAgentArgs } = await import("@/host/runtime/agent-args")
    const parsed = parseAgentArgs(["--mode", "interactive", "--identity-mode", "onboarding"])
    expect(parsed.identityMode).toBe("onboarding")

    // A bogus identity-mode still fails loudly (guard did not go wide-open).
    expect(() =>
      parseAgentArgs(["--mode", "interactive", "--identity-mode", "definitely-not-a-mode"]),
    ).toThrow()
  })

  test("HELL-PO-5: --identity-mode onboarding resolves to a LIVE non-empty onboarding prompt, NOT the unknown-mode fallback (red if arg-builder branch removed)", async () => {
    // THE inert-config guard. HELL-PO-4 only proves the CLI TOKEN parses. It
    // does NOT prove the token resolves to the real onboarding identity: because
    // `onboarding` is not a `ModeVariantKey`, if the dedicated arg-builder branch
    // is deleted the token silently falls through to the mode-variant registry,
    // whose `variantFor("onboarding")` returns the UNKNOWN_MODE_VARIANT fallback
    // — a wrong-but-non-empty prompt. This test drives the real resolver seam and
    // discriminates the LIVE onboarding line from the unknown-mode line, so the
    // mutation (remove the branch) goes RED here.
    const { resolveIdentitySystemPrompt } = await import("@/host/runtime/agent-arg-builder")
    const { DEFAULT_IDENTITIES, UNKNOWN_MODE_IDENTITY } = await import("@/agent/identity")

    const onboardingLine = DEFAULT_IDENTITIES.onboarding[0]
    expect(onboardingLine, "fixture: onboarding identity must be non-empty").toBeTruthy()
    // Fixture sanity: the LIVE line and the fallback line MUST differ, else the
    // discriminator below is vacuous.
    expect(onboardingLine).not.toBe(UNKNOWN_MODE_IDENTITY[0])

    const resolved = resolveIdentitySystemPrompt("onboarding", {})
    // LIVE prompt: non-empty AND carries the real onboarding identity verbatim.
    expect(resolved.system.length).toBeGreaterThan(0)
    expect(
      resolved.system.includes(onboardingLine as string),
      "onboarding prompt must splice the real onboarding identity line",
    ).toBe(true)
    // Must NOT be the unknown-mode fall-through (the mutation's symptom).
    expect(
      resolved.system.includes(UNKNOWN_MODE_IDENTITY[0] as string),
      "onboarding must NOT fall through to the unknown-mode posture",
    ).toBe(false)
    // onboarding is identity-only: no mode-variant registry is published for it
    // (unlike a real ModeVariantKey), so `/identity` never targets it.
    expect(resolved.identityModeVariant).toBeUndefined()

    // Paired control: a REAL ModeVariantKey (`plan`) DOES publish the registry —
    // proves the onboarding-branch's registry omission is a deliberate divergence,
    // not a broken resolver.
    const planResolved = resolveIdentitySystemPrompt("plan", {})
    expect(planResolved.identityModeVariant).toBeDefined()
  })

  test("HELL-PO-6: VALID_IDENTITY_MODES ↔ IDENTITY_MODES bidirectional parity through the real parser (no drift)", async () => {
    // Parity guard for the CLI token set vs the identity SSOT. If a mode is added
    // to one side only, this drifts. Assert BOTH directions through the real
    // `parseAgentArgs` boundary (no private-const import).
    const { parseAgentArgs } = await import("@/host/runtime/agent-args")
    const { IDENTITY_MODES } = await import("@/agent/identity")

    // Direction 1: every IdentityMode SSOT entry is an accepted --identity-mode token.
    for (const mode of IDENTITY_MODES) {
      const parsed = parseAgentArgs(["--mode", "interactive", "--identity-mode", mode])
      expect(parsed.identityMode, `IDENTITY_MODES entry '${mode}' must be a valid CLI token`).toBe(
        mode,
      )
    }
    // 'onboarding' specifically must be present in the SSOT (guards its removal).
    expect(IDENTITY_MODES.includes("onboarding")).toBe(true)

    // Direction 2: a token NOT in IDENTITY_MODES is rejected (the accepted set is
    // not wider than the SSOT). Uses a value known to be outside IDENTITY_MODES.
    expect(IDENTITY_MODES.includes("onboarding-XYZ" as never)).toBe(false)
    expect(() =>
      parseAgentArgs(["--mode", "interactive", "--identity-mode", "onboarding-XYZ"]),
    ).toThrow()
  })
})
