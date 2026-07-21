/**
 * DOF-40 — vendor-detector ↔ glob-rules fail-closed hellgate.
 *
 * The multi-source vendor detector is production-wired into prompt assembly
 * under `QUANTA_VENDOR_RULES`. When its enabled arm drops a candidate vendor
 * rule, that drop MUST be explicit — never a silent swallow.
 *
 * Pre-hardening, `loadGlobRulesWithVendors` did `detected = result.rules`
 * and discarded `DetectionResult.errors` entirely, plus every compose-time
 * filter/collision/cap drop vanished with zero signal.
 *
 * These tests pin:
 *   - EVERY drop reason (parse_error, empty_or_no_trigger, vendor_filtered,
 *     max_files_cap, collision_lost) reaches the `onUnconsumed` sink.
 *   - The returned GlobRule[] is IDENTICAL whether or not a sink is passed
 *     (the sink observes; it never changes composition).
 *   - OFF arm (`vendorDetectorEnabled !== true`) never calls the detector
 *     and never fires the sink — byte-identical legacy output.
 *   - A throwing sink cannot derail rule loading (fail-closed).
 *
 * Source under test: src/agent/glob-rules.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  composeGlobRulesWithDetected,
  type GlobRule,
  loadGlobRules,
  loadGlobRulesWithVendors,
  type VendorRuleUnconsumed,
} from "@/agent/glob-rules"
import type {
  DetectedRule,
  DetectionResult,
  DetectorError,
  VendorDetectorPort,
  VendorId,
} from "@/rules"

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vd-failclosed-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const mkRepo = async (name: string): Promise<string> => {
  const cwd = join(root, name)
  await mkdir(cwd, { recursive: true })
  return cwd
}

/** A detected rule with a real body + glob → survives detectedToGlobRule. */
const okRule = (vendor: VendorId, sourcePath: string, body = "real body"): DetectedRule => ({
  vendor,
  sourcePath,
  description: "",
  body,
  trigger: { alwaysApply: false, globs: ["**/*.ts"] },
  scope: "repo",
  metadata: {},
})

/** A detected rule with an empty body → detectedToGlobRule rejects it. */
const emptyBodyRule = (vendor: VendorId, sourcePath: string): DetectedRule => ({
  vendor,
  sourcePath,
  description: "",
  body: "   ",
  trigger: { alwaysApply: false, globs: ["**/*.ts"] },
  scope: "repo",
  metadata: {},
})

const stubDetector = (result: DetectionResult): VendorDetectorPort => ({
  detectAll: async (): Promise<DetectionResult> => result,
})

describe("DOF-40 fail-closed — no silent partial drop", () => {
  test("parse_error: DetectionResult.errors reach the sink (was silently dropped)", async () => {
    const cwd = await mkRepo("parse-err")
    const err: DetectorError = {
      vendor: "cursor",
      sourcePath: join(cwd, ".cursor/rules/broken.mdc"),
      message: "unterminated frontmatter",
    }
    const seen: VendorRuleUnconsumed[] = []
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stubDetector({ rules: [], errors: [err] }),
      onUnconsumed: (i) => seen.push(i),
    })
    // The unparseable file is surfaced — not swallowed.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.reason).toBe("parse_error")
    expect(seen[0]?.sourcePath).toBe(err.sourcePath)
    expect(seen[0]?.message).toBe("unterminated frontmatter")
    // It contributed no rule (empty rules), so the output is empty here.
    expect(out).toHaveLength(0)
  })

  test("empty_or_no_trigger: a rule detectedToGlobRule rejects is surfaced", async () => {
    const cwd = await mkRepo("empty-body")
    const seen: VendorRuleUnconsumed[] = []
    const p = join(cwd, ".cursor/rules/empty.mdc")
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stubDetector({ rules: [emptyBodyRule("cursor", p)], errors: [] }),
      onUnconsumed: (i) => seen.push(i),
    })
    expect(out).toHaveLength(0)
    expect(seen.map((s) => s.reason)).toContain("empty_or_no_trigger")
    expect(seen.find((s) => s.reason === "empty_or_no_trigger")?.sourcePath).toBe(p)
  })

  test("vendor_filtered: a rule excluded by the vendors subset is surfaced", async () => {
    const cursorPath = join("/x", ".cursor/rules/a.mdc")
    const roopath = join("/x", ".roo/rules-code/b.md")
    const seen: VendorRuleUnconsumed[] = []
    const composed = composeGlobRulesWithDetected(
      [],
      [okRule("cursor", cursorPath), okRule("roo", roopath)],
      { vendors: ["cursor"], onUnconsumed: (i) => seen.push(i) },
    )
    // Only cursor survives the subset filter.
    expect(composed.map((r) => r.sourcePath)).toEqual([cursorPath])
    // roo is surfaced as filtered — not silently dropped.
    const filtered = seen.filter((s) => s.reason === "vendor_filtered")
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.vendor).toBe("roo")
    expect(filtered[0]?.sourcePath).toBe(roopath)
  })

  test("collision_lost: a detected rule that loses a path collision is surfaced", async () => {
    const shared = join("/x", ".quanta/rules/dup.md")
    const seen: VendorRuleUnconsumed[] = []
    // Legacy (quanta bucket) already claims `shared`. A detected cursor rule
    // at the same path has HIGHER priority index (loses) → collision_lost.
    const legacy: GlobRule[] = [
      { sourcePath: shared, globs: ["**/*.ts"], alwaysApply: false, body: "legacy body" },
    ]
    const composed = composeGlobRulesWithDetected(
      legacy,
      [okRule("cursor", shared, "vendor body")],
      {
        onUnconsumed: (i) => seen.push(i),
      },
    )
    // Legacy wins the path; body is the legacy one.
    expect(composed).toHaveLength(1)
    expect(composed[0]?.body).toBe("legacy body")
    const lost = seen.filter((s) => s.reason === "collision_lost")
    expect(lost).toHaveLength(1)
    expect(lost[0]?.sourcePath).toBe(shared)
  })

  test("collision_lost (displaced-detected): a detected rule evicted by a lower-priority winner is surfaced (R1 audit)", async () => {
    const shared = join("/x", ".shared/rule.md")
    const seen: VendorRuleUnconsumed[] = []
    // roo(idx 3) inserted first, then cursor(idx 1) at the SAME path → cursor
    // wins and EVICTS the already-inserted roo rule. The displaced roo rule
    // must be surfaced (pre-R1-fix it was silently overwritten).
    const composed = composeGlobRulesWithDetected(
      [],
      [okRule("roo", shared, "roo body"), okRule("cursor", shared, "cursor body")],
      { onUnconsumed: (i) => seen.push(i) },
    )
    expect(composed).toHaveLength(1)
    expect(composed[0]?.body).toBe("cursor body")
    const lost = seen.filter((s) => s.reason === "collision_lost")
    expect(lost).toHaveLength(1)
    expect(lost[0]?.vendor).toBe("roo")
    expect(lost[0]?.sourcePath).toBe(shared)
  })

  test("legacy displacement is NOT reported as a vendor drop (legacy is native, not a swallowed vendor rule)", async () => {
    const shared = join("/x", ".shared/native.md")
    const seen: VendorRuleUnconsumed[] = []
    // Legacy sits at `shared` (quanta bucket, idx 0). A cursor rule (idx 1)
    // at the same path LOSES (higher idx) → legacy keeps the slot, cursor is
    // the reported drop. No legacy-displacement event (legacy never evicted).
    const legacy: GlobRule[] = [
      { sourcePath: shared, globs: ["**/*.ts"], alwaysApply: false, body: "legacy" },
    ]
    const composed = composeGlobRulesWithDetected(legacy, [okRule("cursor", shared)], {
      onUnconsumed: (i) => seen.push(i),
    })
    expect(composed).toHaveLength(1)
    expect(composed[0]?.body).toBe("legacy")
    // Exactly one drop: the losing cursor rule. Legacy is never a "vendor drop".
    expect(seen).toHaveLength(1)
    expect(seen[0]?.vendor).toBe("cursor")
  })

  test("max_files_cap: rules past MAX_RULE_FILES are surfaced, not swallowed", async () => {
    const seen: VendorRuleUnconsumed[] = []
    // 260 detected rules; cap is 256. The overflow must be reported.
    const many: DetectedRule[] = []
    for (let i = 0; i < 260; i += 1) {
      many.push(okRule("cursor", join("/x", `.cursor/rules/r${i}.mdc`)))
    }
    const composed = composeGlobRulesWithDetected([], many, { onUnconsumed: (i) => seen.push(i) })
    expect(composed).toHaveLength(256)
    const capped = seen.filter((s) => s.reason === "max_files_cap")
    expect(capped).toHaveLength(260 - 256)
  })

  test("RESULT-IDENTITY: passing a sink does NOT change the composed rules", async () => {
    const cwd = await mkRepo("identity")
    const rules: DetectedRule[] = [
      okRule("cursor", join(cwd, ".cursor/rules/a.mdc")),
      emptyBodyRule("cursor", join(cwd, ".cursor/rules/empty.mdc")),
    ]
    const errs: DetectorError[] = [
      { vendor: "roo", sourcePath: join(cwd, ".roo/rules-code/x.md"), message: "bad" },
    ]
    const withSink = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stubDetector({ rules, errors: errs }),
      onUnconsumed: () => {},
    })
    const withoutSink = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stubDetector({ rules, errors: errs }),
    })
    expect(withSink).toEqual(withoutSink)
  })

  test("FAIL-CLOSED: a throwing sink cannot derail rule loading", async () => {
    const cwd = await mkRepo("throwing-sink")
    const rules = [okRule("cursor", join(cwd, ".cursor/rules/a.mdc"))]
    const errs: DetectorError[] = [
      { vendor: "cursor", sourcePath: join(cwd, ".cursor/rules/b.mdc"), message: "boom" },
    ]
    // The good rule must still land even though the sink throws on the error.
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stubDetector({ rules, errors: errs }),
      onUnconsumed: () => {
        throw new Error("sink blew up")
      },
    })
    expect(out.map((r) => r.sourcePath)).toContain(join(cwd, ".cursor/rules/a.mdc"))
  })
})

describe("DOF-40 OFF-identity — unwired arm is byte-identical + sink never fires", () => {
  test("vendorDetectorEnabled !== true ⇒ legacy output, detector NEVER called, sink NEVER fires", async () => {
    const cwd = await mkRepo("off-arm")
    // Seed one real native quanta rule so legacy output is non-empty.
    await mkdir(join(cwd, ".quanta/rules"), { recursive: true })
    await writeFile(
      join(cwd, ".quanta/rules/native.md"),
      "---\nglobs: ['**/*.ts']\n---\nnative rule body",
    )
    const legacy = await loadGlobRules(cwd)

    let detectorCalls = 0
    let sinkCalls = 0
    const detector: VendorDetectorPort = {
      detectAll: async () => {
        detectorCalls += 1
        return { rules: [okRule("cursor", join(cwd, ".cursor/rules/x.mdc"))], errors: [] }
      },
    }
    const off = await loadGlobRulesWithVendors(cwd, {
      // enabled flag absent → OFF
      detector,
      onUnconsumed: () => {
        sinkCalls += 1
      },
    })
    expect(off).toEqual(legacy)
    expect(detectorCalls).toBe(0)
    expect(sinkCalls).toBe(0)
  })

  test("no opts at all ⇒ identical to bare loadGlobRules", async () => {
    const cwd = await mkRepo("no-opts")
    await mkdir(join(cwd, ".quanta/rules"), { recursive: true })
    await writeFile(join(cwd, ".quanta/rules/n.md"), "---\nalwaysApply: true\n---\nbody")
    const bare = await loadGlobRules(cwd)
    const viaWrapper = await loadGlobRulesWithVendors(cwd)
    expect(viaWrapper).toEqual(bare)
  })
})
