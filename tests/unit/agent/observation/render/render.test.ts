/**
 * Observation renderer HELLGATE (jul-6 S3). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§4, `<quanta_observations>`
 * schema example, adversarial-audit section).
 *
 * The renderer is a PURE fn: ObservationBundle → the `<quanta_observations>`
 * block. It carries the audit's overtrust antidote in its very structure, so the
 * hard rules are pinned by RED-on-injection tests (flip a field / drop
 * anti_signals / narrow to top-1 ⇒ a test MUST go red):
 *
 *   (1) routing-hint header present (presence-evidence framing, NOT authoritative).
 *   (2) anti_signals ALWAYS present when any owner renders (anchor antidote).
 *   (3) candidates are top-k — NEVER narrowed to 1 when ≥2 exist (top-1 forbidden).
 *   (4) ordinal strength only — NO numeric confidence anywhere in the output.
 *   (5) empty bundle ⇒ empty string.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ObservationBundle, OwnerHint } from "@/agent/observation/fragment"
import { renderObservations } from "@/agent/observation/render/render"

const owner = (o: Partial<OwnerHint> & { file: string }): OwnerHint => ({
  evidence: "def-use edge",
  source: "static-owner",
  ...o,
})

const bundleOf = (
  owners: OwnerHint[],
  extra: Partial<ObservationBundle> = {},
): ObservationBundle => ({
  owners,
  contributors: ["static-owner"],
  ...extra,
})

describe("renderObservations — empty sentinel", () => {
  test("empty bundle ⇒ empty string (byte-identical no-inject sentinel)", () => {
    expect(renderObservations(bundleOf([]))).toBe("")
    expect(renderObservations(bundleOf([], { contributors: [] }))).toBe("")
  })
})

describe("renderObservations — routing-hint framing (overtrust antidote)", () => {
  test("HARD: prefix header frames evidence as presence, verify-before-editing", () => {
    const out = renderObservations(bundleOf([owner({ file: "a.py", symbol: "f" })]))
    // Exact header the audit pins — presence evidence, NOT authoritative.
    expect(out).toContain("# routing hints — verify against source before editing")
    // Must NOT use authoritative-owner language.
    expect(out.toLowerCase()).not.toContain("authoritative")
  })

  test("HARD: block is wrapped in <quanta_observations> tags", () => {
    const out = renderObservations(bundleOf([owner({ file: "a.py" })]))
    expect(out).toContain("<quanta_observations>")
    expect(out).toContain("</quanta_observations>")
  })
})

describe("renderObservations — anti_signals ALWAYS present (anchor antidote)", () => {
  test("HARD: anti_signals block present whenever any owner renders", () => {
    const out = renderObservations(bundleOf([owner({ file: "a.py", symbol: "f" })]))
    expect(out).toContain("anti_signals:")
    // The two audit-mandated antidote lines.
    expect(out).toContain("dynamic dispatch")
    expect(out).toContain("a candidate is a locator, not the owner")
  })

  test("HARD (single-owner too): anti_signals present even with exactly ONE owner", () => {
    // The biggest overtrust risk is a lone owner reading as THE owner.
    const out = renderObservations(bundleOf([owner({ file: "only.py", symbol: "solo" })]))
    expect(out).toContain("anti_signals:")
    expect(out).toContain("dynamic dispatch")
  })
})

describe("renderObservations — top-k, top-1 FORBIDDEN", () => {
  test("HARD: both candidates render when ≥2 owners exist (never narrowed to 1)", () => {
    const out = renderObservations(
      bundleOf([
        owner({ file: "requests/models.py", symbol: "prepare_url" }),
        owner({ file: "requests/exceptions.py", symbol: "InvalidURL" }),
      ]),
    )
    expect(out).toContain("requests/models.py")
    expect(out).toContain("requests/exceptions.py")
    // Count candidate entries — must be ≥2.
    const candidateLines = out.split("\n").filter((l) => /^\s*-\s+file:/.test(l))
    expect(candidateLines.length).toBe(2)
  })

  test("HARD: three owners ⇒ all three render (top-k, not top-1)", () => {
    const out = renderObservations(
      bundleOf([
        owner({ file: "a.py", symbol: "A" }),
        owner({ file: "b.py", symbol: "B" }),
        owner({ file: "c.py", symbol: "C" }),
      ]),
    )
    const candidateLines = out.split("\n").filter((l) => /^\s*-\s+file:/.test(l))
    expect(candidateLines.length).toBe(3)
    expect(out).toContain("a.py")
    expect(out).toContain("b.py")
    expect(out).toContain("c.py")
  })
})

describe("renderObservations — ordinal strength only, NO numeric confidence", () => {
  test("HARD: strength renders as the ordinal enum word", () => {
    const out = renderObservations(
      bundleOf([owner({ file: "a.py", symbol: "f", strength: "high" })]),
    )
    expect(out).toContain("strength: high")
  })

  test("HARD: NO numeric confidence token anywhere in the output", () => {
    const out = renderObservations(
      bundleOf([
        owner({ file: "a.py", symbol: "f", strength: "high" }),
        owner({ file: "b.py", symbol: "g", strength: "medium" }),
        owner({ file: "c.py", symbol: "h", strength: "low" }),
      ]),
    )
    // No "confidence" label and no bare probability/percentage anywhere.
    expect(out.toLowerCase()).not.toContain("confidence")
    expect(out).not.toMatch(/\b0?\.\d+\b/) // 0.87, .9 etc
    expect(out).not.toMatch(/\b\d{1,3}%/) // 87%
  })
})

describe("renderObservations — evidence/source/symbol surfaced", () => {
  test("owner evidence + source + symbol are rendered (routing basis visible)", () => {
    const out = renderObservations(
      bundleOf([
        owner({
          file: "requests/models.py",
          symbol: "PreparedRequest.prepare_url",
          strength: "high",
          evidence: "def-use — idna encode raises UnicodeError uncaught here",
          source: "static-owner",
        }),
      ]),
    )
    expect(out).toContain("PreparedRequest.prepare_url")
    expect(out).toContain("def-use — idna encode raises UnicodeError uncaught here")
    expect(out).toContain("source: static-owner")
  })

  test("file-only owner (no symbol) renders without a symbol line", () => {
    const out = renderObservations(
      bundleOf([owner({ file: "requests/adapters.py", strength: "low" })]),
    )
    expect(out).toContain("requests/adapters.py")
    // The symbol line must not appear for this owner.
    expect(out).not.toContain("symbol:")
  })
})

describe("renderObservations — optional impact/scope surfaces", () => {
  test("impact_surface renders when present", () => {
    const out = renderObservations(
      bundleOf([owner({ file: "a.py", symbol: "f" })], {
        impact: {
          likelyRuntimePaths: ["Session.get → prepare → prepare_url"],
          riskyCallers: ["adapters.HTTPAdapter.send"],
          testsNotToEdit: ["tests/test_requests.py"],
        },
      }),
    )
    expect(out).toContain("impact_surface:")
    expect(out).toContain("Session.get → prepare → prepare_url")
    expect(out).toContain("adapters.HTTPAdapter.send")
    expect(out).toContain("tests/test_requests.py")
  })

  test("recommended_scope renders when present", () => {
    const out = renderObservations(
      bundleOf([owner({ file: "a.py", symbol: "f" })], {
        scope: { allow: ["requests/models.py"], avoid: ["tests/", "docs/"] },
      }),
    )
    expect(out).toContain("recommended_scope:")
    expect(out).toContain("allow:")
    expect(out).toContain("avoid:")
    expect(out).toContain("tests/")
  })

  test("optional surfaces absent ⇒ their labels do not appear", () => {
    const out = renderObservations(bundleOf([owner({ file: "a.py", symbol: "f" })]))
    expect(out).not.toContain("impact_surface:")
    expect(out).not.toContain("recommended_scope:")
  })
})

describe("renderObservations — source-fence (structure cannot silently regress)", () => {
  const src = readFileSync(
    join(import.meta.dir, "../../../../../src/agent/observation/render/render.ts"),
    "utf8",
  )

  test("the anti_signals antidote strings are literals in the source (not derivable-away)", () => {
    expect(src).toContain("a candidate is a locator, not the owner")
    expect(src).toContain("dynamic dispatch")
  })

  test("the routing-hint header is a literal in the source", () => {
    expect(src).toContain("# routing hints — verify against source before editing")
  })
})
