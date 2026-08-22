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
import type { AgentConfig, AgentOutcome, RunMode } from "@/agent"
import { type GlobRule, loadGlobRules, loadGlobRulesWithVendors } from "@/agent/glob-rules"
import { type AgentMode, MODE_REPO_RULES_POLICY } from "@/agent/run-mode"
import { resolveModePresetGlobRules } from "@/apps/agent/mode-presets/system"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import type { AssembleRequest } from "../../src/apps/agent/assemble"
import { runMode as headlessRun } from "../../src/apps/agent/mode-presets/headless"
import { runMode as ideRun } from "../../src/apps/agent/mode-presets/ide"

// WIRE LANDED (jul-19): this suite now verifies the REAL production resolver
// `resolveModePresetGlobRules` (src/apps/agent/mode-presets/system.ts), wired
// into the interactive/headless/ide base-builders behind the default-OFF
// `QUANTA_VENDOR_RULES` gate. It composes the REAL trust gate
// (`modeLoadsRepoRules`, encapsulated in the resolver) + REAL
// `loadGlobRulesWithVendors`. §3's red-on-injection proves the trust gate is
// load-bearing: a wire that skips it leaks untrusted vendor rules into ci-bot.
const resolveVendorGlobRules = (
  mode: AgentMode,
  cwd: string,
  enabled: boolean,
): Promise<GlobRule[]> => resolveModePresetGlobRules(mode, cwd, enabled)

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
describe("§2 OFF — gate-off is byte-identical to the pre-wire dormant state", () => {
  test("interactive + disabled ⇒ EMPTY (no globRules at all), paired: enabled adds legacy+vendor", async () => {
    const cwd = await mkRepoWithVendorFiles("off")
    // Add a legacy `.cursor/rules` so the ON arm is provably non-empty from the
    // legacy source too (proves ON composes legacy+vendor, OFF drops BOTH).
    await mkdir(join(cwd, ".cursor", "rules"), { recursive: true })
    await writeFile(
      join(cwd, ".cursor", "rules", "base.mdc"),
      "---\nalwaysApply: true\n---\nLEGACY-CURSOR-BODY-always\n",
    )

    // DESIGN: `QUANTA_VENDOR_RULES` gates the ENTIRE glob-rules surface (legacy
    // AND vendor). The glob-rules subsystem was DORMANT pre-wire (no producer of
    // `cfg.globRules`), so the ONLY byte-identical OFF is the empty set — loading
    // legacy `.cursor/rules` even when off would be an unmeasured behavior change.
    const off = await resolveVendorGlobRules("interactive", cwd, /*enabled*/ false)
    expect(off).toEqual([]) // OFF ⇒ caller leaves cfg.globRules unset ⇒ byte-identical

    // Sanity: the fixture genuinely HAS loadable rules (so [] is a real gate
    // effect, not an empty repo).
    const legacyRaw = await loadGlobRules(cwd)
    expect(legacyRaw.some((r) => r.body.includes("LEGACY-CURSOR-BODY-always"))).toBe(true)

    // PAIRED CONTROL: enabling on the SAME fixture surfaces legacy + BOTH vendors.
    const on = await resolveVendorGlobRules("interactive", cwd, /*enabled*/ true)
    expect(on.some((r) => r.body.includes(WINDSURF_MARKER))).toBe(true)
    expect(on.some((r) => r.body.includes(CLINE_MARKER))).toBe(true)
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

// ══════════════════════════════════════════════════════════════════════
//  §5 WIRING — the base-builders actually populate cfg.globRules end-to-end
//  (mirrors mode-preset-repo-rules-wire §2; the resolver is proven above, this
//   proves the trusted preset base-builders route through it onto the config).
// ══════════════════════════════════════════════════════════════════════
const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const fakeOutcome: AgentOutcome = { reason: "completed", turns: 1, messages: [] }
const baseFor = (cwd: string): AssembleRequest["base"] => ({
  llm: fakeLlm,
  registry: new ToolRegistry(defaultTools),
  stream: { emit: () => undefined } as StreamPort,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [],
  system: "",
  cwd,
  maxTurns: 3,
  signal: new AbortController().signal,
})

describe("§5 WIRING — trusted preset base-builders populate cfg.globRules", () => {
  const drivers: ReadonlyArray<{
    mode: RunMode
    run: (req: AssembleRequest) => Promise<unknown>
    extra: Partial<AssembleRequest>
  }> = [
    { mode: "headless", run: headlessRun, extra: { headless: { prompt: "go" } } },
    { mode: "ide", run: ideRun, extra: {} },
  ]

  const captureCfg = async (
    d: (typeof drivers)[number],
    cwd: string,
  ): Promise<AgentConfig | undefined> => {
    let cfg: AgentConfig | undefined
    await d.run({
      mode: d.mode,
      base: baseFor(cwd),
      seams: {
        runAgent: async (c: AgentConfig) => {
          cfg = c
          return fakeOutcome
        },
      },
      ...d.extra,
    } as AssembleRequest)
    return cfg
  }

  for (const d of drivers) {
    test(`${d.mode}: QUANTA_VENDOR_RULES=1 ⇒ cfg.globRules carries the vendor rule; unset ⇒ no globRules (byte-identical)`, async () => {
      const cwd = await mkRepoWithVendorFiles(`wire-${d.mode}`)
      const prev = process.env.QUANTA_VENDOR_RULES
      try {
        // ON — the base-builder resolves + attaches cfg.globRules from the wire.
        process.env.QUANTA_VENDOR_RULES = "1"
        const on = await captureCfg(d, cwd)
        expect(
          (on?.globRules?.rules ?? []).some((r) => r.body.includes(WINDSURF_MARKER)),
          `${d.mode} ON must attach the vendor rule to cfg.globRules`,
        ).toBe(true)

        // OFF — unset ⇒ the base-builder leaves cfg.globRules unset (byte-identical
        // to the pre-wire dormant state). red-on-injection: a builder that always
        // attaches would fail this.
        delete process.env.QUANTA_VENDOR_RULES
        const off = await captureCfg(d, cwd)
        expect(off?.globRules, `${d.mode} OFF must leave cfg.globRules unset`).toBeUndefined()
      } finally {
        if (prev === undefined) delete process.env.QUANTA_VENDOR_RULES
        else process.env.QUANTA_VENDOR_RULES = prev
      }
    })
  }
})
