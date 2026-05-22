/**
 * Signal-trust model — measurement primitive tests.
 *
 * Pins the transcription of `docs/reviews-codex-agent/may-20-codex-signal.md`
 * (trust scores §5, banding §1, downgrade rules §4.4/§6.3) and reproduces the
 * 2026-05-22 gpt-5 django-10880 trajectory as the canonical "undefended"
 * shape. No behavior is asserted on the loop — this module is observation-only.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyEvidence,
  SIGNAL_TRUST,
  SignalLedger,
  toolContribution,
  trustBand,
} from "@/observability"

describe("SIGNAL_TRUST — verbatim from review §5", () => {
  test("core source/runtime/diff are strong; rg/topology/naming are weak", () => {
    expect(SIGNAL_TRUST.source_text).toBe(10)
    expect(SIGNAL_TRUST.test_logs).toBe(9)
    expect(SIGNAL_TRUST.git_diff).toBe(9)
    expect(SIGNAL_TRUST.rg_hits).toBe(5) // high use, LOW trust — the headline
    expect(SIGNAL_TRUST.file_topology).toBe(6)
    expect(SIGNAL_TRUST.naming_vibe).toBe(1)
    expect(SIGNAL_TRUST.absence_from_grep).toBe(2)
  })

  test("banding cut points are the review's §1 model (7 / 4)", () => {
    expect(trustBand(10)).toBe("strong")
    expect(trustBand(7)).toBe("strong")
    expect(trustBand(6)).toBe("auxiliary")
    expect(trustBand(4)).toBe("auxiliary")
    expect(trustBand(3)).toBe("hint")
    expect(trustBand(0)).toBe("hint")
  })
})

describe("toolContribution — grounded, conservative mapping", () => {
  test("read=source, grep=rg, edit=mutation, lsp/bash=unclassified", () => {
    expect(toolContribution("read")).toBe("source_text")
    expect(toolContribution("grep")).toBe("rg_hits")
    expect(toolContribution("glob")).toBe("rg_hits")
    expect(toolContribution("file_tree_summary")).toBe("file_topology")
    expect(toolContribution("edit")).toBe("mutation")
    expect(toolContribution("apply_patch")).toBe("mutation")
    expect(toolContribution("lsp_references")).toBe("unclassified") // out of doc scope
    expect(toolContribution("bash")).toBe("unclassified") // ambiguous unless verification
  })

  test("bash promotes to test_logs only when command matched a verification rail", () => {
    expect(toolContribution("bash", { bashIsVerification: true })).toBe("test_logs")
    expect(toolContribution("bash", { bashIsVerification: false })).toBe("unclassified")
  })
})

describe("classifyEvidence — review §4.4/§6.3 downgrade rules", () => {
  test("django-10880 shape: 18 grep + 2 read + 0 edit on a fix task ⇒ undefended", () => {
    // Reproduces the observed trajectory tool histogram.
    const led = new SignalLedger()
    for (let i = 0; i < 18; i++) led.record("grep")
    for (let i = 0; i < 6; i++) led.record("file_tree_summary")
    led.record("glob")
    led.record("glob")
    led.record("read")
    led.record("read")
    // peak trust = source_text(10) because it DID read 2 files...
    expect(led.peakTrust()).toBe(10)
    // ...but a fix task that produced NO patch is still undefended.
    const v = classifyEvidence(led, { requiresEdit: true })
    expect(v.defended).toBe(false)
    expect(v.reasons.some((r) => r.includes("zero mutation"))).toBe(true)
  })

  test("rg/topology-only, no source read, fix task ⇒ undefended (two reasons)", () => {
    const led = new SignalLedger()
    for (let i = 0; i < 12; i++) led.record("grep")
    led.record("file_tree_summary")
    const v = classifyEvidence(led, { requiresEdit: true })
    expect(v.defended).toBe(false)
    expect(v.peakBand).toBe("auxiliary") // peak = rg_hits(5)/topology(6)
    expect(v.reasons.some((r) => r.includes("no strong-band signal"))).toBe(true)
    expect(v.reasons.some((r) => r.includes("zero mutation"))).toBe(true)
  })

  test("read source + edit + verify on a fix task ⇒ defended", () => {
    const led = new SignalLedger()
    led.record("read")
    led.record("grep")
    led.record("edit")
    led.record("test_runner")
    const v = classifyEvidence(led, { requiresEdit: true })
    expect(v.defended).toBe(true)
    expect(v.reasons.length).toBe(0)
  })

  test("patched WITHOUT reading source ⇒ undefended (owner guess on rg only)", () => {
    const led = new SignalLedger()
    led.record("grep")
    led.record("edit") // wrote a patch but never read the owner source
    const v = classifyEvidence(led, { requiresEdit: true })
    expect(v.defended).toBe(false)
    expect(v.reasons.some((r) => r.includes("without reading source"))).toBe(true)
  })

  test("review/audit turn (requiresEdit:false) with a source read ⇒ defended, no edit needed", () => {
    const led = new SignalLedger()
    led.record("read")
    led.record("grep")
    const v = classifyEvidence(led, { requiresEdit: false })
    expect(v.defended).toBe(true)
  })
})
