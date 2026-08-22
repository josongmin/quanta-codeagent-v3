/**
 * Hellgate — plan-writeback bidirectional skill ↔ plan sync (ADR-0259).
 *
 * 15 cases pinning the closed-port writeback contract. Each test seals
 * exactly one invariant; the file uses pure fakes only (no live LLM, no I/O).
 *
 *  - HELL-PW-01  recordFinding returns a PlanUpdate on success
 *  - HELL-PW-02  getUpdates returns recorded entries in record order
 *  - HELL-PW-03  clearUpdates drains to empty
 *  - HELL-PW-04  unknown planId (not in knownPlanIds) → Err("plan-not-found")
 *  - HELL-PW-05  Finding.kind 3-arm exhaustive (discovery / blocker / opportunity)
 *  - HELL-PW-06  Finding.severity 3-arm exhaustive (info / warn / critical)
 *  - HELL-PW-07  empty / whitespace-only text → Err("empty-text")
 *  - HELL-PW-08  default-OFF: barrel import is leaf — no cross-slice imports
 *  - HELL-PW-09  recordedAt monotonic across rapid calls
 *  - HELL-PW-10  1000-finding performance sanity (under 200ms wall)
 *  - HELL-PW-11  getUpdates returns frozen array (Object.isFrozen)
 *  - HELL-PW-12  multi-plan isolation (different planId leaks nothing)
 *  - HELL-PW-13  concurrent (sync-rapid) recordFinding order via recordedAt
 *  - HELL-PW-14  WritebackError 3-arm closed exhaustive switch
 *  - HELL-PW-15  PlanUpdate frozen — mutation attempt fails in strict mode
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createDefaultWriteback,
  type Finding,
  type PlanUpdate,
  type WritebackError,
} from "@/skill/playbook/plan-writeback"

describe("plan-writeback hellgate (ADR-0259)", () => {
  test("HELL-PW-01: recordFinding returns a PlanUpdate envelope", () => {
    const wb = createDefaultWriteback({ planId: "plan-α", knownPlanIds: ["plan-α"] })
    const result = wb.recordFinding("skill-a", {
      kind: "discovery",
      text: "dep X is unset",
      severity: "info",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value.planId).toBe("plan-α")
    expect(result.value.skillId).toBe("skill-a")
    expect(result.value.finding.kind).toBe("discovery")
    expect(result.value.finding.text).toBe("dep X is unset")
    expect(result.value.finding.severity).toBe("info")
    expect(typeof result.value.recordedAt).toBe("number")
  })

  test("HELL-PW-02: getUpdates returns recorded entries in record order", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    wb.recordFinding("skill-a", { kind: "discovery", text: "first", severity: "info" })
    wb.recordFinding("skill-b", { kind: "blocker", text: "second", severity: "warn" })
    wb.recordFinding("skill-c", { kind: "opportunity", text: "third", severity: "critical" })
    const updates = wb.getUpdates("p1")
    expect(updates.length).toBe(3)
    expect(updates[0]?.finding.text).toBe("first")
    expect(updates[1]?.finding.text).toBe("second")
    expect(updates[2]?.finding.text).toBe("third")
    expect(updates[0]?.skillId).toBe("skill-a")
    expect(updates[2]?.skillId).toBe("skill-c")
  })

  test("HELL-PW-03: clearUpdates drains to empty", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    wb.recordFinding("skill-a", { kind: "discovery", text: "x", severity: "info" })
    wb.recordFinding("skill-b", { kind: "blocker", text: "y", severity: "warn" })
    expect(wb.getUpdates("p1").length).toBe(2)
    wb.clearUpdates("p1")
    expect(wb.getUpdates("p1").length).toBe(0)
    // Idempotent — clearing again is a no-op.
    wb.clearUpdates("p1")
    expect(wb.getUpdates("p1").length).toBe(0)
  })

  test("HELL-PW-04: unknown planId (not in knownPlanIds) → Err(plan-not-found)", () => {
    const wb = createDefaultWriteback({
      planId: "ghost-plan",
      knownPlanIds: ["plan-1", "plan-2"],
    })
    const result = wb.recordFinding("skill-a", {
      kind: "discovery",
      text: "irrelevant",
      severity: "info",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.kind).toBe("plan-not-found")

    // Empty-string planId is treated as "no active plan" even without
    // knownPlanIds — same plan-not-found surface.
    const wbEmpty = createDefaultWriteback({ planId: "   " })
    const r2 = wbEmpty.recordFinding("skill-a", {
      kind: "discovery",
      text: "x",
      severity: "info",
    })
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.kind).toBe("plan-not-found")
  })

  test("HELL-PW-05: Finding.kind 3-arm exhaustive", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    const kinds: ReadonlyArray<Finding["kind"]> = ["discovery", "blocker", "opportunity"]
    for (const kind of kinds) {
      const r = wb.recordFinding("s", { kind, text: `t-${kind}`, severity: "info" })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.value.finding.kind).toBe(kind)
    }
    // Exhaustive type-level check — adding a new arm here without updating
    // the kinds array above would surface as a tsc error.
    const allKinds: { [K in Finding["kind"]]: true } = {
      discovery: true,
      blocker: true,
      opportunity: true,
    }
    expect(Object.keys(allKinds).sort()).toEqual(["blocker", "discovery", "opportunity"])
  })

  test("HELL-PW-06: Finding.severity 3-arm exhaustive", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    const sevs: ReadonlyArray<Finding["severity"]> = ["info", "warn", "critical"]
    for (const severity of sevs) {
      const r = wb.recordFinding("s", { kind: "discovery", text: `t-${severity}`, severity })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.value.finding.severity).toBe(severity)
    }
    const allSev: { [K in Finding["severity"]]: true } = {
      info: true,
      warn: true,
      critical: true,
    }
    expect(Object.keys(allSev).sort()).toEqual(["critical", "info", "warn"])
  })

  test("HELL-PW-07: empty / whitespace-only text → Err(empty-text)", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    const cases = ["", "   ", "\t\t", "\n", "  \n\t  "]
    for (const text of cases) {
      const r = wb.recordFinding("s", { kind: "discovery", text, severity: "info" })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error(`unreachable for ${JSON.stringify(text)}`)
      expect(r.error.kind).toBe("empty-text")
    }
    // Empty-string skillId → distinct error.
    const r2 = wb.recordFinding("  ", { kind: "discovery", text: "x", severity: "info" })
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.kind).toBe("skill-id-empty")
  })

  test("HELL-PW-08: default-OFF — barrel is leaf (no cross-slice imports)", () => {
    // Read the source files in the slice and assert none of them import from
    // `@/agent`, `@/tool`, `@/permission`, `@/memory`, `@/scheduler`,
    // `@/observability`, `@/runtime`, or any other src/skill/playbook sibling.
    // The slice MUST be self-contained — host wires it in or it stays dormant.
    const here = dirname(fileURLToPath(import.meta.url))
    const sliceRoot = resolve(here, "../../../../src/skill/playbook/plan-writeback")
    const files = ["types.ts", "port.ts", "default-writeback.ts", "index.ts"]
    const forbidden = [
      "@/agent",
      "@/tool",
      "@/permission",
      "@/memory",
      "@/scheduler",
      "@/observability",
      "@/runtime",
      "@/shared",
      "@/storage",
      "@/llm",
      "@/stream",
    ]
    for (const fname of files) {
      const body = readFileSync(resolve(sliceRoot, fname), "utf8")
      for (const f of forbidden) {
        expect(
          body.includes(`from "${f}"`),
          `${fname} must not import from ${f} (HELL-PW-08 default-OFF)`,
        ).toBe(false)
      }
      // Also reject relative parent imports — slice must stay leaf-only.
      expect(
        body.includes('from "..'),
        `${fname} must not import from a parent directory (HELL-PW-08 leaf invariant)`,
      ).toBe(false)
    }
  })

  test("HELL-PW-09: recordedAt monotonic across rapid calls", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    const ordinals: number[] = []
    for (let i = 0; i < 50; i++) {
      const r = wb.recordFinding("s", {
        kind: "discovery",
        text: `t${i}`,
        severity: "info",
      })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      ordinals.push(r.value.recordedAt)
    }
    for (let i = 1; i < ordinals.length; i++) {
      const prev = ordinals[i - 1]
      const cur = ordinals[i]
      expect(prev !== undefined && cur !== undefined && cur > prev).toBe(true)
    }
  })

  test("HELL-PW-10: 1000-finding performance sanity (< 200ms wall)", () => {
    const wb = createDefaultWriteback({ planId: "perf" })
    const kinds = ["discovery", "blocker", "opportunity"] as const
    const sevs = ["info", "warn", "critical"] as const
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) {
      const slot = i % 3
      wb.recordFinding(`skill-${i % 7}`, {
        kind: kinds[slot] ?? "discovery",
        text: `finding number ${i}`,
        severity: sevs[slot] ?? "info",
      })
    }
    const t1 = performance.now()
    const elapsed = t1 - t0
    expect(elapsed).toBeLessThan(200)
    expect(wb.getUpdates("perf").length).toBe(1000)
  })

  test("HELL-PW-11: getUpdates returns frozen array", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    wb.recordFinding("s", { kind: "discovery", text: "x", severity: "info" })
    const updates = wb.getUpdates("p1")
    expect(Object.isFrozen(updates)).toBe(true)
    // Empty-bucket path also frozen.
    const empty = wb.getUpdates("p1-other")
    expect(Object.isFrozen(empty)).toBe(true)
    // Mutation attempt on frozen array throws in strict mode (test file is
    // a module → strict).
    expect(() => {
      ;(updates as PlanUpdate[]).push({
        planId: "p1",
        skillId: "x",
        finding: { kind: "discovery", text: "y", severity: "info" },
        recordedAt: 999,
      })
    }).toThrow()
  })

  test("HELL-PW-12: multi-plan isolation — different planId leaks nothing", () => {
    const wbA = createDefaultWriteback({ planId: "plan-A" })
    const wbB = createDefaultWriteback({ planId: "plan-B" })
    wbA.recordFinding("s", { kind: "discovery", text: "A1", severity: "info" })
    wbA.recordFinding("s", { kind: "blocker", text: "A2", severity: "warn" })
    wbB.recordFinding("s", { kind: "opportunity", text: "B1", severity: "info" })

    expect(wbA.getUpdates("plan-A").length).toBe(2)
    expect(wbB.getUpdates("plan-B").length).toBe(1)
    // Cross-instance queries leak nothing.
    expect(wbA.getUpdates("plan-B").length).toBe(0)
    expect(wbB.getUpdates("plan-A").length).toBe(0)
    // Clearing the wrong plan id on an instance is a no-op.
    wbA.clearUpdates("plan-B")
    expect(wbA.getUpdates("plan-A").length).toBe(2)
    wbB.clearUpdates("plan-A")
    expect(wbB.getUpdates("plan-B").length).toBe(1)
  })

  test("HELL-PW-13: concurrent (sync-rapid) recordFinding order via recordedAt", () => {
    const wb = createDefaultWriteback({ planId: "race" })
    // Burst 20 calls "synchronously" — wall clock may collapse to the same
    // millisecond, but the monotonic ordinal ensures strict-increase order.
    for (let i = 0; i < 20; i++) {
      wb.recordFinding("s", {
        kind: "discovery",
        text: `t-${i}`,
        severity: "info",
      })
    }
    const updates = wb.getUpdates("race")
    expect(updates.length).toBe(20)
    for (let i = 0; i < updates.length; i++) {
      expect(updates[i]?.finding.text).toBe(`t-${i}`)
    }
    for (let i = 1; i < updates.length; i++) {
      const prev = updates[i - 1]?.recordedAt ?? -1
      const cur = updates[i]?.recordedAt ?? -1
      expect(cur > prev).toBe(true)
    }
  })

  test("HELL-PW-14: WritebackError 3-arm closed exhaustive switch", () => {
    // Build one instance of each error kind so the exhaustive `switch` below
    // type-checks. Adding a new arm to WritebackError without updating this
    // test would fire a tsc `never` error on `_exhaustive`.
    const errs: ReadonlyArray<WritebackError> = [
      { kind: "plan-not-found" },
      { kind: "empty-text" },
      { kind: "skill-id-empty" },
    ]
    const labels: string[] = []
    for (const e of errs) {
      switch (e.kind) {
        case "plan-not-found":
          labels.push("pnf")
          break
        case "empty-text":
          labels.push("et")
          break
        case "skill-id-empty":
          labels.push("sie")
          break
        default: {
          const _exhaustive: never = e
          throw new Error(`non-exhaustive: ${String(_exhaustive)}`)
        }
      }
    }
    expect(labels).toEqual(["pnf", "et", "sie"])
  })

  test("HELL-PW-15: PlanUpdate frozen — mutation attempts fail", () => {
    const wb = createDefaultWriteback({ planId: "p1" })
    const r = wb.recordFinding("s", {
      kind: "discovery",
      text: "frozen me",
      severity: "info",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const update = r.value
    expect(Object.isFrozen(update)).toBe(true)
    expect(Object.isFrozen(update.finding)).toBe(true)
    // Strict mode (module scope) → assignment to frozen property throws.
    expect(() => {
      ;(update as { skillId: string }).skillId = "tampered"
    }).toThrow()
    expect(() => {
      ;(update.finding as { text: string }).text = "tampered"
    }).toThrow()
    // Re-read after mutation attempts — values unchanged.
    const stored = wb.getUpdates("p1")[0]
    expect(stored?.skillId).toBe("s")
    expect(stored?.finding.text).toBe("frozen me")
  })
})
