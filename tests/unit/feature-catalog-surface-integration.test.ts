// meta-test: pins the `surface_integration` axis (audited per-surface CLI/web
// integration + evidence) added to the feature catalog. Lives outside src/, so
// no @/ alias — imports the tooling directly like the sibling fc meta-tests.
//
// Why this exists: the 2026-06-09 CLI⇄web audit found `ui_surfaces` to be an
// unreliable integration index (only ~13/933 list web while the web app
// surfaces far more, and several [cli] tags are "accidentally right" because the
// web slash stubs never execute). `surface_integration` replaces that signal
// with an AUDITED, evidence-backed, per-surface status. These ratchets keep the
// new field honest and tie its web claims to the code SSOT that actually
// decides web reachability (the toSessionHostTurnEvent event-bridge whitelist).
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES } from "../../src/host/runtime/internal/session-host-turn-event-bridge"
import { loadFeaturesStrict, SurfaceIntegrationSchema } from "../../tools/feature-catalog/schema"

const REPO = join(import.meta.dir, "..", "..")
const features = await loadFeaturesStrict(join(REPO, "tools/feature-catalog/features"))

const STATUS_NEEDS_EVIDENCE = new Set(["full", "partial", "missing"])
const ev = (
  s: { cli?: string | undefined; web?: string | undefined } | undefined,
  k: "cli" | "web",
): string => (s?.[k] ?? "").trim()

describe("surface_integration — schema", () => {
  test("SI-01: zod schema accepts a fully-specified block", () => {
    const r = SurfaceIntegrationSchema.safeParse({
      cli: "full",
      web: "missing",
      method: "audited",
      verified: "2026-06-09",
      evidence: { cli: "src/apps/cli/x.ts:1", web: "dropped at bridge default" },
    })
    expect(r.success).toBe(true)
  })

  test("SI-02: an absent block defaults to unknown/unverified (byte-identical legacy)", () => {
    const r = SurfaceIntegrationSchema.safeParse(undefined)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.cli).toBe("unknown")
      expect(r.data.web).toBe("unknown")
      expect(r.data.method).toBe("unverified")
    }
  })

  test("SI-03: all 933 catalog features parse with the new field", () => {
    expect(features.length).toBeGreaterThan(900)
    for (const { feature } of features) {
      expect(feature.surface_integration).toBeDefined()
    }
  })
})

describe("surface_integration — invariants (ratchet)", () => {
  // Teeth #1 — an AUDITED/DERIVED entry cannot make a non-trivial status claim
  // (full/partial/missing) without a file:line proof for that surface. Bald
  // claims are exactly what made ui_surfaces untrustworthy.
  test("SI-10: audited/derived status ∈ {full,partial,missing} requires evidence", () => {
    const offenders: string[] = []
    for (const { feature: f } of features) {
      const si = f.surface_integration
      if (si.method === "unverified") continue
      if (STATUS_NEEDS_EVIDENCE.has(si.cli) && ev(si.evidence, "cli").length === 0) {
        offenders.push(`${f.id} (cli=${si.cli}, no cli evidence)`)
      }
      if (STATUS_NEEDS_EVIDENCE.has(si.web) && ev(si.evidence, "web").length === 0) {
        offenders.push(`${f.id} (web=${si.web}, no web evidence)`)
      }
    }
    expect(offenders).toEqual([])
  })

  // Teeth #2 — no POSITIVE contradiction with the legacy ui_surfaces tag on the
  // WEB axis, for AUDITED entries only. Fires on web="missing" (not "na"):
  //   web=missing = "the web app SHOULD render it but doesn't" → genuinely
  //                 contradicts a ui_surfaces tag claiming web/tauri (a real
  //                 overclaim — the teeth this audit exists to keep).
  //   web=na      = "not a web UI feature" (pure backend primitive) →
  //                 compatible with a loose legacy tag; not a contradiction.
  // The CLI axis is intentionally NOT hard-checked here: the legacy [cli] tag
  // means "ships in a command-line surface" broadly (incl. the eval/bench/probe
  // apps), whereas this audit's cli status is specific to the INTERACTIVE CLI
  // (src/apps/cli) — so an eval/bench/probe feature is honestly cli=missing for
  // the interactive CLI yet legitimately tagged [cli]. That definitional gap is
  // surfaced advisorily by `bun fc surface`, not failed in CI. `derived` entries
  // are exempt (mechanical baseline; disagreements are a migration signal).
  test("SI-11: audited web=missing must not be claimed present by ui_surfaces", () => {
    const offenders: string[] = []
    for (const { feature: f } of features) {
      const si = f.surface_integration
      if (si.method !== "audited") continue
      const tags = new Set(f.ui_surfaces)
      if (si.web === "missing" && (tags.has("web") || tags.has("tauri"))) {
        offenders.push(`${f.id}: si.web=missing but ui_surfaces has web/tauri`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("surface_integration — web reachability SSOT anchor", () => {
  // Independent literal anchor (NOT tautological): the ONLY AgentEvent→web
  // bridge is `toSessionHostTurnEvent` in context-binding.ts. Whatever event
  // tags it maps == the events that can possibly reach the browser; the rest
  // hit `default: return undefined` and are dropped. Pin that whitelist so a
  // future widening of the web bridge fails here and forces a re-audit of every
  // web=missing claim that depended on "dropped at the bridge default arm".
  //
  // RE-AUDITED 2026-06-09: ADR-0512 (skill-scope-v2) deliberately added
  // `skill_scope_decision` → `skill.scope.decision` so the web surface sees a
  // hard-`blocked` / silently-declined out-of-scope tool (these never reach the
  // interactive `approval.requested` card). That widening is AUDITED + documented
  // (feature skill-scope-v2-availability-permission web=full, App.tsx:247 →
  // EscalationCard), so it is added to the pinned set here — the ratchet still
  // asserts an EXACT set, so any FUTURE unaudited widening still fires red.
  const KNOWN_BRIDGE_EVENTS = [
    "assistant_text",
    "llm_continuation",
    "llm_request",
    "skill_scope_decision",
    "tool_call",
    "tool_result",
    "usage",
  ].sort()

  test("SI-20: toSessionHostTurnEvent maps exactly the known 7 event tags", () => {
    expect([...AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES].sort()).toEqual(
      KNOWN_BRIDGE_EVENTS,
    )
  })
})

describe("surface_integration — seed corpus is live", () => {
  test("SI-30: the audited seeds carry method=audited + web evidence", () => {
    const seeds = ["turn-diff-event", "plan-stream-mirror", "ask-user-elicitation"]
    for (const id of seeds) {
      const f = features.find((x) => x.feature.id === id)?.feature
      expect(f, `seed ${id} present`).toBeDefined()
      expect(f?.surface_integration.method).toBe("audited")
      expect(ev(f?.surface_integration.evidence, "web").length).toBeGreaterThan(0)
    }
  })
})
