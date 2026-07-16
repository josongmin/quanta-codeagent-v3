/**
 * Hellgate — web-daemon read-only readouts (jun-9-cli-web-parity ticket 05).
 *
 * Pins the PURE `renderReadout(name, snapshot)` core that the out-of-band
 * `GET /readout/:name` route serves. Teeth (not vacuous):
 *   RO-01..03  served readouts render the LIVE snapshot fields (a renderer that
 *              drops a field / returns empty FAILS — asserts specific content)
 *   RO-04      recognized-but-pending ⇒ graceful (wired:false, isError:false,
 *              non-empty) — NEVER a crash mid-look
 *   RO-05      unknown name ⇒ isError (typo ≠ "not here yet")
 *   RO-06 TEETH every SERVED_READOUTS name yields wired+non-error+non-empty
 *              (red-on-injection: a served name that errored/emptied fails)
 *   RO-07 TOTAL renderReadout never throws on a degenerate snapshot
 */
import { describe, expect, test } from "bun:test"
import { renderReadout, SERVED_READOUTS } from "@/apps/web-daemon/readout"
import type { CapabilityManifest, SessionSnapshotLite, SessionStateView } from "@/protocol/session"

const CAPS: CapabilityManifest = {
  approvals: "operator",
  tools: true,
  memory: false,
  artifacts: true,
  subagents: true,
  automation: false,
  shellSnapshot: true,
  serverAutoContinues: false,
  transport: "websocket",
}

const STATE: SessionStateView = {
  status: "running",
  draftInput: "",
  permissionMode: "default",
  identityMode: "build",
  toolProfile: "full",
  modelSlug: "gpt-5",
  messageCount: 7,
  lastOutcomeReason: "refusal",
}

const snap = (over?: Partial<SessionSnapshotLite>): SessionSnapshotLite => ({
  sessionId: "s1",
  revision: 3,
  seq: 9,
  state: STATE,
  capabilities: CAPS,
  pendingApproval: null,
  openArtifacts: [],
  ...over,
})

describe("renderReadout — served readouts", () => {
  test("RO-01: /capabilities renders every manifest field's value", () => {
    const r = renderReadout("capabilities", snap())
    expect(r.wired).toBe(true)
    expect(r.isError).toBe(false)
    // each of the 8 fields surfaces its rendered value (drop one ⇒ fail)
    expect(r.output).toContain("websocket") // transport
    expect(r.output).toContain("operator") // approvals
    expect(r.output).toMatch(/tools\s+yes/)
    expect(r.output).toMatch(/subagents\s+yes/)
    expect(r.output).toMatch(/memory\s+no/)
    expect(r.output).toMatch(/artifacts\s+yes/)
    expect(r.output).toMatch(/automation\s+no/)
    expect(r.output).toMatch(/shell snapshot\s+yes/)
  })

  test("RO-02: /caps aliases to capabilities", () => {
    const r = renderReadout("caps", snap())
    expect(r.name).toBe("capabilities")
    expect(r.wired).toBe(true)
    expect(r.output).toContain("websocket")
  })

  test("RO-03: /state renders status + mode + the present optional fields", () => {
    const r = renderReadout("state", snap())
    expect(r.wired).toBe(true)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("running")
    expect(r.output).toContain("build") // identity
    expect(r.output).toContain("full") // tool profile
    expect(r.output).toContain("gpt-5") // model
    expect(r.output).toMatch(/messages\s+7/)
    expect(r.output).toContain("refusal") // last outcome
  })

  test("RO-03b: /state omits absent optional fields (no 'undefined' leak)", () => {
    const r = renderReadout(
      "state",
      snap({ state: { status: "idle", draftInput: "", permissionMode: "plan", messageCount: 0 } }),
    )
    expect(r.output).toContain("idle")
    expect(r.output).not.toContain("undefined")
    expect(r.output).not.toMatch(/identity/) // absent ⇒ no row
  })
})

describe("renderReadout — graceful degrade & errors", () => {
  test("RO-04: recognized readouts WITHOUT a composed source degrade gracefully with copy naming the gap", () => {
    // UUX-1-11 — the pure renderer is the sources-absent projection: every
    // recognized non-snapshot name stays graceful (wired:false, isError:false)
    // and its copy NAMES the missing piece (see readout-sources-hellgate for
    // the wired paths + exact copy pins).
    for (const name of [
      "agents",
      "plan",
      "branches",
      "skills",
      "mcp",
      "memory",
      "why",
      "cost",
      "context",
    ]) {
      const r = renderReadout(name, snap())
      expect(r.wired, `${name} source absent`).toBe(false)
      expect(r.isError, `${name} not an error`).toBe(false) // graceful, NEVER a crash
      expect(r.output.length, `${name} non-empty`).toBeGreaterThan(20) // real copy, not a stub token
      expect(r.output, `${name} copy names itself`).toContain(name)
    }
  })

  test("RO-05: an UNKNOWN readout name is an error (typo ≠ pending)", () => {
    const r = renderReadout("doesnotexist", snap())
    expect(r.isError).toBe(true)
    expect(r.wired).toBe(false)
    expect(r.output).toContain("unknown")
  })
})

describe("renderReadout — invariants (teeth)", () => {
  test("RO-06 TEETH: every SERVED_READOUTS name serves live, non-empty, non-error output", () => {
    for (const name of SERVED_READOUTS) {
      const r = renderReadout(name, snap())
      expect(r.wired, `${name} wired`).toBe(true)
      expect(r.isError, `${name} no error`).toBe(false)
      expect(r.output.trim().length, `${name} non-empty`).toBeGreaterThan(0)
    }
  })

  test("RO-07 TOTAL: never throws on a degenerate/partial snapshot", () => {
    const degenerate = {
      sessionId: "",
      revision: 0,
      seq: 0,
      state: { status: "idle", draftInput: "", permissionMode: "", messageCount: 0 },
      capabilities: CAPS,
      pendingApproval: null,
      openArtifacts: [],
    } as SessionSnapshotLite
    for (const name of ["capabilities", "state", "agents", "", "??"]) {
      expect(() => renderReadout(name, degenerate)).not.toThrow()
    }
  })
})
