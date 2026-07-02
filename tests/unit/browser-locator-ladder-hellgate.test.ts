/**
 * Hellgate — locator-stability ladder (S1 strengthen: collect + snapshot).
 *
 * A stable locator hint (data-testid > whitelisted data-* > href) lets the model
 * target an element by an author-provided stable id rather than a positional
 * ref, surviving re-renders. Two layers, both chrome-free:
 *   1. `parseDomModel` trust boundary — data-* keys are attacker-controlled, so
 *      only a WHITELIST survives, capped in count + value length, no DOM mutation;
 *   2. `buildSnapshot` renders the ladder in priority order as a `loc=` hint.
 *
 *  HELL-LADDER-01: parseDomModel keeps testid + whitelisted data-* only
 *  HELL-LADDER-02: a non-whitelisted data-* key is dropped (attacker key)
 *  HELL-LADDER-03: locators are count-capped + value-capped (DoS guard)
 *  HELL-LADDER-04: snapshot renders the ladder highest-priority-first
 *  HELL-LADDER-05: COLLECT_SCRIPT emits data-testid + whitelist, no mutation
 *  HELL-LADDER-06: byte-identical render without any locators (default path)
 */

import { describe, expect, test } from "bun:test"
import { buildSnapshot, createRefMap, type DomModel } from "@/browser"
import {
  COLLECT_SCRIPT,
  LOCATOR_DATA_WHITELIST,
  LOCATOR_MAX,
  parseDomModel,
} from "@/browser/cdp/collect"

const wrap = (rootExtra: Record<string, unknown>): unknown => ({
  title: "T",
  root: { backendPath: "/", role: "document", name: "R", ...rootExtra },
})

describe("HELLGATE locator ladder — parse trust boundary", () => {
  test("HELL-LADDER-01: testid + whitelisted data-* survive parse", () => {
    const r = parseDomModel(
      wrap({
        locators: [
          { key: "data-testid", value: "submit-btn" },
          { key: "data-test", value: "login" },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.root.locators).toEqual([
      { key: "data-testid", value: "submit-btn" },
      { key: "data-test", value: "login" },
    ])
  })

  test("HELL-LADDER-02: a non-whitelisted data-* key is dropped", () => {
    // data-secret is NOT on the whitelist ⇒ attacker cannot smuggle arbitrary
    // page attributes (which could carry tokens/PII) into model context.
    const r = parseDomModel(
      wrap({
        locators: [
          { key: "data-secret", value: "leak-me" },
          { key: "data-testid", value: "ok" },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.root.locators).toEqual([{ key: "data-testid", value: "ok" }])
    expect(JSON.stringify(r.value)).not.toContain("leak-me")
  })

  test("HELL-LADDER-03: locators are count-capped + value-capped", () => {
    const many = Array.from({ length: LOCATOR_MAX + 20 }, () => ({
      key: "data-testid",
      value: "v".repeat(1000),
    }))
    const r = parseDomModel(wrap({ locators: many }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const locs = r.value.root.locators ?? []
    expect(locs.length).toBeLessThanOrEqual(LOCATOR_MAX)
    for (const l of locs) expect(l.value.length).toBeLessThanOrEqual(200)
  })

  test("HELL-LADDER-03b: malformed locator entries are dropped, not throwing", () => {
    const r = parseDomModel(
      wrap({ locators: [null, 42, { key: "data-testid" }, { value: "x" }, "str"] }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.root.locators).toBeUndefined()
  })
})

describe("HELLGATE locator ladder — snapshot render", () => {
  const model = (locators: readonly { key: string; value: string }[]): DomModel => ({
    title: "T",
    root: {
      backendPath: "/",
      role: "document",
      name: "R",
      children: [{ backendPath: "/0", role: "button", name: "Go", locators }],
    },
  })

  test("HELL-LADDER-04: ladder rendered highest-priority-first (testid before data-test)", () => {
    const yaml = buildSnapshot(
      model([
        { key: "data-test", value: "second" },
        { key: "data-testid", value: "first" },
      ]),
      createRefMap(),
    )
    const line = yaml.split("\n").find((l) => l.includes("button")) ?? ""
    expect(line).toContain("loc=")
    // data-testid outranks data-test regardless of source order
    expect(line.indexOf("data-testid=first")).toBeGreaterThanOrEqual(0)
    expect(line.indexOf("data-testid=first")).toBeLessThan(line.indexOf("data-test=second"))
  })

  test("HELL-LADDER-06: no locators ⇒ render omits loc= (byte-identical default path)", () => {
    const a = buildSnapshot(model([]), createRefMap())
    expect(a).not.toContain("loc=")
  })
})

describe("HELLGATE locator ladder — in-page collect script", () => {
  test("HELL-LADDER-05: COLLECT_SCRIPT reads data-testid + the whitelist, no DOM write", () => {
    // The whitelist is embedded in the serialized in-page script so the walk
    // emits exactly the audited keys.
    for (const key of LOCATOR_DATA_WHITELIST) expect(COLLECT_SCRIPT).toContain(key)
    // no DOM mutation: the collector never sets attributes / writes refs into the
    // page (the whole point vs Cursor's data-cursor-ref).
    expect(COLLECT_SCRIPT).not.toContain("setAttribute")
    expect(COLLECT_SCRIPT).toContain("getAttribute")
    // it emits a `locators` array on the node
    expect(COLLECT_SCRIPT).toContain("locators")
  })
})
