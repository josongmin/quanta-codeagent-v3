import { describe, expect, test } from "bun:test"
import {
  FALLBACK_PRESETS,
  iidFromBody,
  launchSpecFromBody,
  presetsFromCatalog,
} from "./bench-request"

describe("presetsFromCatalog", () => {
  test("projects catalog preset keys into the allowlist", () => {
    const out = presetsFromCatalog({ "agentless-v1": {}, "agentless-v6": {} })
    expect(out.has("agentless-v1")).toBe(true)
    expect(out.has("agentless-v6")).toBe(true)
    expect(out.size).toBe(2)
  })

  test("empty / undefined catalog ⇒ built-in fallback set", () => {
    expect(presetsFromCatalog({})).toBe(FALLBACK_PRESETS)
    expect(presetsFromCatalog(undefined)).toBe(FALLBACK_PRESETS)
    expect(FALLBACK_PRESETS.has("agentless-v1")).toBe(true)
  })
})

describe("launchSpecFromBody — shape coercion only (validation is bench-actions)", () => {
  test("maps every field through", () => {
    const s = launchSpecFromBody({
      family: "pro",
      dataset: "~/d/pro-5.jsonl",
      preset: "agentless-v1",
      model: "gpt-5.5",
      instances: "a,b",
      onDemand: true,
    })
    expect(s).toEqual({
      family: "pro",
      dataset: "~/d/pro-5.jsonl",
      preset: "agentless-v1",
      model: "gpt-5.5",
      instances: "a,b",
      onDemand: true,
    })
  })

  test("model defaults to gpt-5.5; empty instances/onDemand omitted", () => {
    const s = launchSpecFromBody({ family: "verified", dataset: "x.jsonl", preset: "p" })
    expect(s.model).toBe("gpt-5.5")
    expect(s.instances).toBeUndefined()
    expect(s.onDemand).toBeUndefined()
  })

  test("non-string / null fields coerce to empty (bench-actions then rejects)", () => {
    const s = launchSpecFromBody({ family: 7, dataset: null, preset: undefined })
    expect(s.family as string).toBe("")
    expect(s.dataset).toBe("")
    expect(s.preset).toBe("")
  })

  test("missing body ⇒ all-empty spec (no throw here)", () => {
    expect(() => launchSpecFromBody(undefined)).not.toThrow()
    expect(launchSpecFromBody(undefined).dataset).toBe("")
  })
})

describe("iidFromBody", () => {
  test("extracts iid string", () => {
    expect(iidFromBody({ iid: "i-0abc1234" })).toBe("i-0abc1234")
  })
  test("non-string / missing ⇒ empty (bench-actions rejects)", () => {
    expect(iidFromBody({})).toBe("")
    expect(iidFromBody({ iid: 5 })).toBe("")
  })
})
