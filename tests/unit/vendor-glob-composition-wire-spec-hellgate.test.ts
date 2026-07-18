/**
 * jul-18 — Composition-wire SPEC for the multi-source vendor-detector.
 *
 * PROBLEM (investigated + confirmed): the vendor detector slice
 * (`@/rules/vendor-detector`, `createDefaultVendorDetector`/`detectAll`) is
 * fully built and its GlobRule composition (`loadGlobRulesWithVendors`) is
 * fully built + unit-proven — BUT NO composition root ever populates
 * `AgentConfig.globRules`. Neither the legacy `loadGlobRules` NOR the
 * vendor-composed `loadGlobRulesWithVendors` is called to feed the real
 * prompt: the only live `loadGlobRules` caller is `src/apps/cli/rule-indicator.ts`
 * (a READ-ONLY CLI `/rules` display mirror — "No LLM call — surface-only"),
 * and `agent-config-assembler.ts` wires `repoRules` but never `globRules`.
 * So the entire glob-rules subsystem — legacy AND vendor — is dormant on the
 * agent loop.
 *
 * The natural production wire is a mode-gated resolver that mirrors
 * `resolveModePresetRepoRules` (jul-12 OmO WS4): call
 * `loadGlobRulesWithVendors(cwd, { vendorDetectorEnabled })` and populate
 * `cfg.globRules.rules` — BUT ONLY for TRUSTED modes (the OmO security matrix:
 * batch / ci-bot / daemon stay rule-less so an untrusted repo's `.windsurfrules`
 * cannot smuggle authoritative text into the system prompt). That resolver
 * CANNOT live in the `@/rules` slice (fence = `@/rules → @/shared` only; it
 * would need `@/agent` for `loadGlobRulesWithVendors` + `modeLoadsRepoRules`),
 * so the wire is a COMPOSITION-ROOT edit in `src/apps/agent/mode-presets/`
 * (unowned by this ticket — returned as text in the report).
 *
 * This suite is the EXECUTABLE SPECIFICATION of that recommended wire. It pins,
 * against the REAL production functions (`modeLoadsRepoRules`,
 * `loadGlobRulesWithVendors`, the REAL `createDefaultVendorDetector`), the four
 * invariants the composition edit MUST satisfy:
 *
 *   §1 ON  — a TRUSTED mode + gate-on ⇒ a real `.windsurfrules` / `.clinerules`
 *            body (paths the LEGACY loader NEVER scans) reaches the composed
 *            `GlobRule[]` that would feed `cfg.globRules.rules`.
 *   §2 OFF — gate-off ⇒ the composed result is BYTE-IDENTICAL to the legacy
 *            `loadGlobRules(cwd)` output (the vendor body is ABSENT). Paired
 *            control: same fixture, gate-on ⇒ body present.
 *   §3 SECURITY — UNTRUSTED / hermetic modes (ci-bot, daemon, batch) resolve
 *            rule-less EVEN with the gate on + on-disk vendor files: the OmO
 *            trust matrix (`modeLoadsRepoRules`) gates the vendor wire exactly
 *            as it gates repo-rules. red-on-injection: a wire that skips the
 *            trust gate ⇒ RED.
 *   §4 DRIFT GUARD — the resolver honors `MODE_REPO_RULES_POLICY` for EVERY
 *            mode (a newly-added AgentMode is auto-exercised).
 *
 * The `resolveVendorGlobRules` helper below is the REFERENCE IMPLEMENTATION of
 * the recommended composition edit — kept in-test because the production home
 * (`src/apps/agent/mode-presets/system.ts`) is unowned. It composes only REAL
 * production functions; the test asserts each invariant + red-on-injection so
 * the recommended edit is drop-in + spec-locked. When the real wire lands
 * (report §e), this file re-points its import at the production resolver
 * verbatim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GlobRule,
  loadGlobRules,
  loadGlobRulesWithVendors,
} from "@/agent/glob-rules"
import { type AgentMode, MODE_REPO_RULES_POLICY, modeLoadsRepoRules } from "@/agent/run-mode"

// ─── REFERENCE composition resolver (recommended production edit) ─────────────
//
// Mirrors `resolveModePresetRepoRules`: (1) TRUST GATE via `modeLoadsRepoRules`
// — untrusted/hermetic modes get NOTHING; (2) FEATURE GATE default-OFF via the
// `enabled` flag (the production edit resolves this from a `QUANTA_VENDOR_RULES`
// env in the composition root); (3) composes via the REAL
// `loadGlobRulesWithVendors`. Fail-open: a broken load never crashes session
// start (returns []). Returns the `GlobRule[]` the wire assigns to
// `cfg.globRules.rules`.
const resolveVendorGlobRules = async (
  mode: AgentMode,
  cwd: string,
  enabled: boolean,
): Promise<GlobRule[]> => {
  // TRUST GATE — batch/ci-bot/daemon stay rule-less (OmO security matrix). This
  // is the load-bearing security line; removing it is the injection §3 targets.
  if (!modeLoadsRepoRules(mode)) return []
  // FEATURE GATE — default-OFF: gate-off ⇒ byte-identical legacy output.
  return loadGlobRulesWithVendors(cwd, { vendorDetectorEnabled: enabled }).catch(() => [])
}

// Bodies that CANNOT appear in any legacy `.cursor/rules` / `.quanta/rules`
// output — they live only in vendor files the legacy loader never reads. Their
// presence in the composed GlobRule[] is proof the detector drove them.
const WINDSURF_MARKER = "WINDSURF-BODY-c7e2-composition-wire-spec"
const CLINE_MARKER = "CLINE-BODY-9a41-composition-wire-spec"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vendor-glob-wire-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const mkRepoWithVendorFiles = async (name: string): Promise<string> => {
  const cwd = join(root, name)
  await mkdir(cwd, { recursive: true })
  // A flat `.windsurfrules` (implicitly-always) — legacy loader never scans it.
  await writeFile(join(cwd, ".windsurfrules"), `# house style\n${WINDSURF_MARKER}\n`)
  // A flat `.clinerules` (implicitly-always) — likewise invisible to legacy.
  await writeFile(join(cwd, ".clinerules"), `# cline\n${CLINE_MARKER}\n`)
  return cwd
}

const bodies = (rules: GlobRule[]): string[] => rules.map((r) => r.body)

// ══════════════════════════════════════════════════════════════════════
//  §1 ON — trusted mode + gate-on ⇒ vendor bodies reach the composed set
// ══════════════════════════════════════════════════════════════════════
describe("§1 ON — trusted mode + gate-on surfaces real vendor rules", () => {
  test("interactive + enabled ⇒ .windsurfrules AND .clinerules bodies reach cfg.globRules.rules", async () => {
    const cwd = await mkRepoWithVendorFiles("on")

    // Baseline sanity: the LEGACY loader sees NEITHER vendor file.
    const legacy = await loadGlobRules(cwd)
    expect(legacy.some((r) => r.body.includes(WINDSURF_MARKER))).toBe(false)
    expect(legacy.some((r) => r.body.includes(CLINE_MARKER))).toBe(false)

    const resolved = await resolveVendorGlobRules("interactive", cwd, /*enabled*/ true)

    const windsurf = resolved.find((r) => r.body.includes(WINDSURF_MARKER))
    const cline = resolved.find((r) => r.body.includes(CLINE_MARKER))
    expect(windsurf, "windsurf rule must surface").toBeDefined()
    expect(cline, "cline rule must surface").toBeDefined()
    // Both are implicitly-always ⇒ they ride EVERY turn (alwaysApply arm), so
    // they are always injected regardless of changedPaths.
    expect((windsurf as GlobRule).alwaysApply).toBe(true)
    expect((cline as GlobRule).alwaysApply).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════
//  §2 OFF — gate-off ⇒ byte-identical legacy (vendor bodies ABSENT)
// ══════════════════════════════════════════════════════════════════════
describe("§2 OFF — gate-off is byte-identical legacy", () => {
  test("interactive + disabled ⇒ composed set == legacy, no vendor body (paired: enabled adds it)", async () => {
    const cwd = await mkRepoWithVendorFiles("off")
    // Add a legacy rule so BOTH arms are non-empty — proves the ABSENCE of the
    // vendor body is real, not just an empty render.
    await mkdir(join(cwd, ".cursor", "rules"), { recursive: true })
    await writeFile(
      join(cwd, ".cursor", "rules", "base.mdc"),
      "---\nalwaysApply: true\n---\nLEGACY-CURSOR-BODY-always\n",
    )

    const off = await resolveVendorGlobRules("interactive", cwd, /*enabled*/ false)
    const legacy = await loadGlobRules(cwd)

    // OFF arm IS the legacy array — same bodies, same order (byte-identical).
    expect(bodies(off)).toEqual(bodies(legacy))
    expect(off.some((r) => r.body.includes(WINDSURF_MARKER))).toBe(false)
    expect(off.some((r) => r.body.includes(CLINE_MARKER))).toBe(false)
    // Non-empty guard: the legacy rule IS present on the OFF arm.
    expect(off.some((r) => r.body.includes("LEGACY-CURSOR-BODY-always"))).toBe(true)

    // PAIRED CONTROL: enabling on the SAME fixture DOES add the vendor bodies.
    const on = await resolveVendorGlobRules("interactive", cwd, /*enabled*/ true)
    expect(on.some((r) => r.body.includes(WINDSURF_MARKER))).toBe(true)
    expect(on.some((r) => r.body.includes(CLINE_MARKER))).toBe(true)
    // …and the legacy rule is STILL there (compose, not replace).
    expect(on.some((r) => r.body.includes("LEGACY-CURSOR-BODY-always"))).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════
//  §3 SECURITY — untrusted/hermetic modes stay rule-less (OmO matrix)
// ══════════════════════════════════════════════════════════════════════
describe("§3 SECURITY — untrusted/hermetic modes never load vendor rules", () => {
  test("ci-bot / daemon / batch resolve rule-less EVEN with gate-on + on-disk vendor files", async () => {
    const cwd = await mkRepoWithVendorFiles("untrusted")
    for (const mode of ["ci-bot", "daemon", "batch"] as AgentMode[]) {
      const resolved = await resolveVendorGlobRules(mode, cwd, /*enabled*/ true)
      // The untrusted-tree modes MUST get NOTHING: a malicious PR's
      // `.windsurfrules` would otherwise ride into the trusted system prompt as
      // authoritative rules (self-approve vector). Same posture as repo-rules.
      expect(resolved, `${mode} must be rule-less`).toEqual([])
    }
  })

  test("red-on-injection: a wire that SKIPS the trust gate leaks the vendor body into ci-bot", async () => {
    const cwd = await mkRepoWithVendorFiles("inject")
    // The BROKEN wire — omits `modeLoadsRepoRules`. This is exactly the bug the
    // §3 guard prevents: the composed set now leaks the untrusted vendor body.
    // NB: `loadGlobRulesWithVendors` has ZERO mode/trust awareness (verified:
    // no `mode`/`ci-bot`/`daemon` reference in glob-rules.ts) — so the trust
    // gate is ENTIRELY the caller's job. Omitting `modeLoadsRepoRules` is the
    // exact bug §3 prevents.
    const leaky = async (dir: string, enabled: boolean): Promise<GlobRule[]> =>
      loadGlobRulesWithVendors(dir, { vendorDetectorEnabled: enabled }).catch(() => [])

    const leaked = await leaky(cwd, true)
    // Proof the injection is REAL (the guarded resolver returns [] here):
    expect(leaked.some((r) => r.body.includes(WINDSURF_MARKER))).toBe(true)
    // …and the guarded resolver on the SAME input does NOT leak.
    const guarded = await resolveVendorGlobRules("ci-bot", cwd, true)
    expect(guarded).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════
//  §4 DRIFT GUARD — resolver honors MODE_REPO_RULES_POLICY for EVERY mode
// ══════════════════════════════════════════════════════════════════════
describe("§4 DRIFT GUARD — every mode's vendor-wire behavior matches its policy", () => {
  test("load-modes surface vendor rules; rule-less modes stay empty (gate-on)", async () => {
    const cwd = await mkRepoWithVendorFiles("drift")
    const modes = Object.keys(MODE_REPO_RULES_POLICY) as AgentMode[]
    expect(modes.length).toBeGreaterThanOrEqual(6) // all AgentMode values present
    for (const mode of modes) {
      const resolved = await resolveVendorGlobRules(mode, cwd, /*enabled*/ true)
      if (MODE_REPO_RULES_POLICY[mode] === "load") {
        expect(
          resolved.some((r) => r.body.includes(WINDSURF_MARKER)),
          `${mode} must LOAD vendor rules`,
        ).toBe(true)
      } else {
        expect(resolved, `${mode} must be RULE-LESS`).toEqual([])
      }
    }
  })
})
