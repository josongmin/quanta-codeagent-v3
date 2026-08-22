/**
 * CLUSTER D #5 — `permission_propose_pattern` TOOL hellgate (the model-facing
 * RECORDING surface, mirror of the pure-layer hellgate in
 * `permission-propose-pattern-hellgate.test.ts`).
 *
 * Proves the LLM-callable tool routes EXCLUSIVELY through the no-widen
 * `recordProposedPattern` core and cannot self-grant / widen:
 *
 *   1. uncovered proposal ⇒ `would_widen` rejected + store UNCHANGED.
 *   2. covered refinement ⇒ recorded + the pattern now covers a future action.
 *   3. chain-widen (propose A covered, then B "covered by" recorded-A) ⇒ rejected.
 *   4. dangerous self-flag ⇒ gated (`dangerous_blocked`) when the port closes
 *      `allowDangerous:false`.
 *   5. default-OFF ⇒ tool absent (byte-identical menu).
 *   6. NO-THROW: a throwing port → typed `error` result (never an unhandled throw).
 *   7. schema bounds: empty / over-cap proposed array ⇒ rejected `bad_input`.
 */

import { describe, expect, test } from "bun:test"
import { autoPassByPatterns, PatternGrantStore, recordProposedPattern } from "@/permission"
import {
  buildDefaultTools,
  type PermissionPatternProposePort,
  PROPOSE_PATTERN_MAX,
  permissionProposeTools,
  type ToolContext,
  type ToolResult,
} from "@/tool"

/** Adapter mirroring the production host wiring: the port closes over a real
 *  PatternGrantStore + `recordProposedPattern` (the no-widen core), so the tool
 *  cannot bypass the invariant. `allowDangerous` defaults false (the safe host
 *  posture). */
const portOver = (
  store: PatternGrantStore,
  allowDangerous = false,
): PermissionPatternProposePort => ({
  recordProposed: (input) =>
    recordProposedPattern(
      store,
      {
        proposed: input.proposed,
        ...(input.isMaybeDangerous !== undefined
          ? { isMaybeDangerous: input.isMaybeDangerous }
          : {}),
      },
      { allowDangerous },
    ),
})

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
})

const runTool = async (port: PermissionPatternProposePort, input: unknown): Promise<ToolResult> => {
  const [tool] = permissionProposeTools(port)
  if (tool === undefined) throw new Error("no tool built")
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no result event")
  return last
}

describe("permission_propose_pattern tool — NO-WIDEN / NO-SELF-GRANT", () => {
  test("uncovered proposal ⇒ would_widen rejected + store UNCHANGED", async () => {
    const store = new PatternGrantStore(["read:src/**"]) // baseline
    const r = await runTool(portOver(store), { proposed: ["read:secret/**"] })
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
    // Store unchanged: the uncovered pattern was NOT recorded into `allowed`.
    expect(store.isCovered(["read:secret/**"])).toBe(false)
    expect(store.granted().has("read:secret/**")).toBe(false)
  })

  test("covered refinement ⇒ recorded + future action auto-passes", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const r = await runTool(portOver(store), { proposed: ["read:src/**"] })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("read:src/**")
    // The recorded pattern now backs an auto-pass for a structurally-equiv action.
    const pass = autoPassByPatterns(store, { rememberPatterns: ["read:src/**"] })
    expect(pass.kind).toBe("auto_pass")
  })

  test("chain-widen blocked: propose A (covered) then B 'covered by' recorded-A ⇒ rejected", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const port = portOver(store)
    // 1) record A (baseline-covered) — recorded into `allowed`, NOT baseline.
    expect((await runTool(port, { proposed: ["read:src/**"] })).ok).toBe(true)
    // 2) B is "covered" only by the just-recorded A (never in the baseline) ⇒ widen.
    const r2 = await runTool(port, { proposed: ["read:other/**"] })
    expect(r2.ok).toBe(false)
    expect(r2.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
    expect(store.granted().has("read:other/**")).toBe(false)
  })

  test("atomic batch: ONE uncovered pattern rejects the WHOLE batch (no laundering)", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const r = await runTool(portOver(store), {
      proposed: ["read:src/**", "bash:rm -rf /"], // first covered, second NOT
    })
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
    // Nothing recorded — not even the covered member.
    expect(store.granted().has("bash:rm -rf /")).toBe(false)
  })

  test("dangerous self-flag ⇒ dangerous_blocked when host allowDangerous:false", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const r = await runTool(portOver(store, false), {
      proposed: ["read:src/**"],
      is_maybe_dangerous: true,
    })
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({ mode: "rejected", reason: "dangerous_blocked" })
  })

  test("empty baseline ⇒ EVERY proposal rejected would_widen (safe-but-inert)", async () => {
    const store = new PatternGrantStore() // empty baseline = production residual posture
    const r = await runTool(portOver(store), { proposed: ["read:src/**"] })
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
  })
})

describe("permission_propose_pattern tool — schema + no-throw + default-OFF", () => {
  test("empty proposed array ⇒ bad_input", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const r = await runTool(portOver(store), { proposed: [] })
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({ mode: "rejected", reason: "bad_input" })
  })

  test("over-cap proposed array ⇒ bad_input", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const tooMany = Array.from({ length: PROPOSE_PATTERN_MAX + 1 }, (_, i) => `read:p${i}/**`)
    const r = await runTool(portOver(store), { proposed: tooMany })
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({ mode: "rejected", reason: "bad_input" })
  })

  test("throwing port ⇒ typed error result (NO unhandled throw)", async () => {
    const throwingPort: PermissionPatternProposePort = {
      recordProposed: () => {
        throw new Error("boom")
      },
    }
    const r = await runTool(throwingPort, { proposed: ["read:src/**"] })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })

  test("default-OFF: no port ⇒ tool absent (byte-identical menu)", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("permission_propose_pattern")
  })

  test("port wired ⇒ exactly one permission_propose_pattern tool appears", () => {
    const store = new PatternGrantStore(["read:src/**"])
    const names = buildDefaultTools({ permissionPatternPropose: portOver(store) }).map(
      (t) => t.name,
    )
    expect(names.filter((n) => n === "permission_propose_pattern")).toHaveLength(1)
  })

  test("the tool is NOT read-only (mutates the pattern store)", () => {
    const store = new PatternGrantStore(["read:src/**"])
    const [tool] = permissionProposeTools(portOver(store))
    expect(tool?.isReadOnly()).toBe(false)
  })
})
