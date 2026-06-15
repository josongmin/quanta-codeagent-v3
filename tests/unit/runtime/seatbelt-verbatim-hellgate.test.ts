/**
 * ADR-0199 — Seatbelt verbatim parity + strict knobs hellgate.
 *
 * Locks four invariants:
 *   1. Codex-baseline byte parity (HELL-SB-01, -02, -10).
 *   2. Workspace path injection defense (HELL-SB-03).
 *   3. Passthrough on off / danger (HELL-SB-04).
 *   4. Strict knobs default-OFF byte-identical + each knob tightens (5-8).
 *   5. Diff helper actionability (HELL-SB-09).
 */
import { describe, expect, test } from "bun:test"
import {
  applyStrictKnobs,
  compileSeatbeltProfile,
  diffProfiles,
  formatDiff,
  isDefaultStrict,
  renderVerbatim,
  type SandboxPolicy,
  type StrictKnobs,
  type VerbatimArm,
} from "@/runtime/os-sandbox"

const WS = "/ws"

describe("ADR-0199 — Seatbelt verbatim parity (HELL-SB-01..04, 10)", () => {
  test("HELL-SB-01: read-only matches Codex verbatim fixture byte-for-byte", () => {
    const actual = compileSeatbeltProfile({ profile: "read-only" }, WS)
    expect(actual).not.toBeNull()
    const expected = renderVerbatim("read-only", WS)
    const diff = diffProfiles(expected, actual as string)
    if (!diff.equal) throw new Error(formatDiff(diff))
    expect(actual).toBe(expected)
  })

  test("HELL-SB-02: workspace-write profile contains workspace write path exactly once", () => {
    const out = compileSeatbeltProfile({ profile: "workspace-write" }, WS) as string
    const occurrences = out.match(/\(subpath "\/ws"\)/g) ?? []
    expect(occurrences.length).toBe(1)
  })

  test("HELL-SB-02b: read-only permits process-exec so the sandboxed shell can start", () => {
    const out = compileSeatbeltProfile({ profile: "read-only" }, WS) as string
    expect(out.includes("(allow process-exec)")).toBe(true)
    expect(out.includes("(deny network*)")).toBe(true)
    expect(out.includes("(allow file-write*")).toBe(false)
  })

  test("HELL-SB-02c: read-only honors explicit scoped extraWritePaths only", () => {
    const out = compileSeatbeltProfile({
      profile: "read-only",
      extraWritePaths: ["/var/quanta-scope"],
    }, WS) as string
    expect(out.includes('(subpath "/ws")')).toBe(false)
    expect(
      out.includes(
        '(allow file-write* (literal "/var/quanta-scope") (subpath "/var/quanta-scope"))',
      ),
    ).toBe(true)
  })

  test("HELL-SB-02d: /tmp extraWritePaths include the /private/tmp Seatbelt alias", () => {
    const out = compileSeatbeltProfile({
      profile: "read-only",
      extraWritePaths: ["/tmp/quanta-scope"],
    }, WS) as string
    const writeLine = out.split("\n").find((l) => l.startsWith("(allow file-write*"))
    expect(writeLine).toContain('(literal "/tmp/quanta-scope")')
    expect(writeLine).toContain('(subpath "/tmp/quanta-scope")')
    expect(writeLine).toContain('(literal "/private/tmp/quanta-scope")')
    expect(writeLine).toContain('(subpath "/private/tmp/quanta-scope")')
  })

  test('HELL-SB-03: workspace path with `"` and `\\` escapes cleanly — no premature sexp close', () => {
    const tricky = `/we"ird\\path`
    const out = compileSeatbeltProfile({ profile: "workspace-write" }, tricky) as string
    // The bare `)` injection attempt cannot escape its string literal:
    // every `"` inside the workspace path is backslash-escaped.
    expect(out.includes('(subpath "/we\\"ird\\\\path")')).toBe(true)
    // Sanity: no raw unescaped quote sequence breaking the sexp.
    const lines = out.split("\n").filter((l) => l.includes("subpath"))
    for (const l of lines) {
      // Each subpath line must close with `))` or `)` and have a matched
      // count of unescaped quote-open / quote-close pairs.
      const unescaped = l.replace(/\\"/g, "").replace(/\\\\/g, "")
      const quotes = (unescaped.match(/"/g) ?? []).length
      expect(quotes % 2).toBe(0)
    }
  })

  test("HELL-SB-04: off / danger-full-access return null (passthrough)", () => {
    expect(compileSeatbeltProfile({ profile: "off" }, WS)).toBeNull()
    expect(compileSeatbeltProfile({ profile: "danger-full-access" }, WS)).toBeNull()
    // strict knobs are inert in passthrough mode
    expect(compileSeatbeltProfile({ profile: "off" }, WS, { denyForkAdditional: true })).toBeNull()
    expect(
      compileSeatbeltProfile({ profile: "danger-full-access" }, WS, { denyNetworkAlways: true }),
    ).toBeNull()
  })

  test("HELL-SB-10: all three arms round-trip against their fixture", () => {
    const arms: ReadonlyArray<{ arm: VerbatimArm; policy: SandboxPolicy }> = [
      { arm: "read-only", policy: { profile: "read-only" } },
      { arm: "workspace-write", policy: { profile: "workspace-write" } },
      { arm: "workspace-write-net", policy: { profile: "workspace-write-net" } },
    ]
    for (const { arm, policy } of arms) {
      const actual = compileSeatbeltProfile(policy, WS) as string
      const expected = renderVerbatim(arm, WS)
      const diff = diffProfiles(expected, actual)
      if (!diff.equal) {
        throw new Error(`arm=${arm}\n${formatDiff(diff)}`)
      }
      expect(actual).toBe(expected)
    }
  })
})

describe("ADR-0199 — strict knob byte-identical default (HELL-SB-05)", () => {
  test("HELL-SB-05: opts omitted vs every knob false → byte-identical to baseline", () => {
    const baseline = compileSeatbeltProfile({ profile: "workspace-write" }, WS)
    const optsAbsent = compileSeatbeltProfile({ profile: "workspace-write" }, WS, undefined)
    const allFalse: StrictKnobs = {
      denyForkAdditional: false,
      denyNetworkAlways: false,
      allowTmpWrite: false,
      denyMetadataReadAbsolute: false,
    }
    const optsFalse = compileSeatbeltProfile({ profile: "workspace-write" }, WS, allFalse)
    expect(baseline).toBe(optsAbsent)
    expect(baseline).toBe(optsFalse)
  })

  test("HELL-SB-05b: isDefaultStrict() recognises undefined and all-false as defaults", () => {
    expect(isDefaultStrict(undefined)).toBe(true)
    expect(isDefaultStrict({})).toBe(true)
    expect(isDefaultStrict({ allowTmpWrite: false })).toBe(true)
    expect(isDefaultStrict({ denyForkAdditional: true })).toBe(false)
  })
})

describe("ADR-0199 — strict knob behavior (HELL-SB-06..08)", () => {
  test("HELL-SB-06: denyForkAdditional adds (deny process-fork) AFTER the allow", () => {
    const out = compileSeatbeltProfile({ profile: "workspace-write" }, WS, {
      denyForkAdditional: true,
    }) as string
    expect(out.includes("(allow process-fork)")).toBe(true)
    expect(out.includes("(deny process-fork)")).toBe(true)
    const lines = out.split("\n")
    const allowIdx = lines.indexOf("(allow process-fork)")
    const denyIdx = lines.indexOf("(deny process-fork)")
    expect(denyIdx).toBeGreaterThan(allowIdx)
  })

  test("HELL-SB-07: denyNetworkAlways forces (deny network*) even when profile allows", () => {
    const out = compileSeatbeltProfile({ profile: "workspace-write-net", allowNetwork: true }, WS, {
      denyNetworkAlways: true,
    }) as string
    expect(out.includes("(deny network*)")).toBe(true)
    expect(out.includes("(allow network*)")).toBe(false)
  })

  test("HELL-SB-08a: allowTmpWrite extends an existing write line", () => {
    const out = compileSeatbeltProfile({ profile: "workspace-write" }, WS, {
      allowTmpWrite: true,
    }) as string
    const writeLine = out.split("\n").find((l) => l.startsWith("(allow file-write*"))
    expect(writeLine).toBeDefined()
    expect((writeLine as string).includes('(subpath "/private/tmp")')).toBe(true)
    expect((writeLine as string).includes(`(subpath "${WS}")`)).toBe(true)
  })

  test("HELL-SB-08b: allowTmpWrite on read-only inserts a new write line before network", () => {
    const out = compileSeatbeltProfile({ profile: "read-only" }, WS, {
      allowTmpWrite: true,
    }) as string
    const lines = out.split("\n")
    const writeIdx = lines.findIndex((l) => l.startsWith("(allow file-write* (subpath"))
    const netIdx = lines.findIndex((l) => l === "(deny network*)" || l === "(allow network*)")
    expect(writeIdx).toBeGreaterThan(-1)
    expect(netIdx).toBeGreaterThan(writeIdx)
    expect(lines[writeIdx]).toBe('(allow file-write* (subpath "/private/tmp"))')
  })

  test("HELL-SB-08c: allowTmpWrite idempotent (does not double-add)", () => {
    const out = compileSeatbeltProfile({ profile: "workspace-write" }, WS, {
      allowTmpWrite: true,
    }) as string
    const occurrences = out.match(/\(subpath "\/private\/tmp"\)/g) ?? []
    expect(occurrences.length).toBe(1)
  })

  test("HELL-SB-07 sanity: denyNetworkAlways=false leaves allow as-is", () => {
    const out = compileSeatbeltProfile({ profile: "workspace-write-net" }, WS, {
      denyNetworkAlways: false,
    }) as string
    expect(out.includes("(allow network*)")).toBe(true)
  })
})

describe("ADR-0199 — profile-diff helper (HELL-SB-09)", () => {
  test("HELL-SB-09: diff reports added/removed/changed entries with line numbers", () => {
    const baseline = "(version 1)\n(deny default)\n(allow process-fork)"
    const mutated = "(version 1)\n(deny default)\n(deny process-fork)\n(allow network*)"
    const d = diffProfiles(baseline, mutated)
    expect(d.equal).toBe(false)
    expect(d.entries.length).toBe(2)
    const e0 = d.entries[0]
    const e1 = d.entries[1]
    expect(e0?.kind).toBe("changed")
    expect(e0?.line).toBe(3)
    expect(e0?.expected).toBe("(allow process-fork)")
    expect(e0?.actual).toBe("(deny process-fork)")
    expect(e1?.kind).toBe("added")
    expect(e1?.line).toBe(4)
    expect(e1?.actual).toBe("(allow network*)")
  })

  test("HELL-SB-09b: equal inputs return equal=true with no entries", () => {
    const a = "x\ny\nz\n"
    const d = diffProfiles(a, a)
    expect(d.equal).toBe(true)
    expect(d.entries.length).toBe(0)
    expect(formatDiff(d)).toBe("(profiles equal)")
  })

  test("HELL-SB-09c: applyStrictKnobs identity on default returns identical baseline", () => {
    const baseline = compileSeatbeltProfile({ profile: "workspace-write" }, WS) as string
    expect(applyStrictKnobs(baseline, {})).toBe(baseline)
    expect(applyStrictKnobs(baseline, { denyForkAdditional: false })).toBe(baseline)
  })
})
