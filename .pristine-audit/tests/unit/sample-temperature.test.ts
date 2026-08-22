import { describe, expect, test } from "bun:test"
import {
  GREEDY,
  modelSupportsSamplingTemperature,
  sampleTemperatureForCandidate,
  TEMPERATURE_SAMPLE,
} from "@/llm"

describe("sampleTemperatureForCandidate", () => {
  test("index 0 is greedy (undefined) — no temperature override", () => {
    expect(sampleTemperatureForCandidate(0)).toBeUndefined()
    expect(sampleTemperatureForCandidate(0)).toBe(GREEDY)
  })

  test("index >= 1 samples at 0.8 (Agentless repair.py parity)", () => {
    expect(sampleTemperatureForCandidate(1)).toBe(0.8)
    expect(sampleTemperatureForCandidate(1)).toBe(TEMPERATURE_SAMPLE)
    expect(sampleTemperatureForCandidate(2)).toBe(TEMPERATURE_SAMPLE)
    expect(sampleTemperatureForCandidate(7)).toBe(TEMPERATURE_SAMPLE)
  })

  test("named constants pin the exact schedule values", () => {
    expect(GREEDY).toBeUndefined()
    expect(TEMPERATURE_SAMPLE).toBe(0.8)
  })

  test("deterministic — repeated calls return the identical value", () => {
    expect(sampleTemperatureForCandidate(0)).toBe(sampleTemperatureForCandidate(0))
    expect(sampleTemperatureForCandidate(3)).toBe(sampleTemperatureForCandidate(3))
  })

  test("only index 0 is greedy — index 1 is the first sampling slot (boundary)", () => {
    // Mutation guard: a `>= 0` or `> 1` off-by-one would flip one of these.
    expect(sampleTemperatureForCandidate(0)).toBeUndefined()
    expect(sampleTemperatureForCandidate(1)).toBe(TEMPERATURE_SAMPLE)
  })

  test("negative index defensively treated as greedy (not a sampling slot)", () => {
    expect(sampleTemperatureForCandidate(-1)).toBeUndefined()
  })
})

describe("modelSupportsSamplingTemperature — capability guard (reasoning models reject temperature)", () => {
  test("OpenAI reasoning models REJECT temperature (o-series + GPT-5)", () => {
    expect(modelSupportsSamplingTemperature("o1")).toBe(false)
    expect(modelSupportsSamplingTemperature("o1-preview")).toBe(false)
    expect(modelSupportsSamplingTemperature("o3-mini")).toBe(false)
    expect(modelSupportsSamplingTemperature("gpt-5")).toBe(false)
    expect(modelSupportsSamplingTemperature("gpt-5-codex")).toBe(false)
  })

  test("sampling-capable models ACCEPT temperature (Claude incl. reasoning, GPT-4o)", () => {
    expect(modelSupportsSamplingTemperature("claude-opus-4-8")).toBe(true) // reasoning, but temp-OK
    expect(modelSupportsSamplingTemperature("claude-sonnet-4-6")).toBe(true)
    expect(modelSupportsSamplingTemperature("gpt-4o")).toBe(true) // trailing 'o', no o<digit>
    expect(modelSupportsSamplingTemperature("gpt-4o-2024-08-06")).toBe(true)
  })

  test("unknown/empty ⇒ true (assume capable; wire spread + allSettled keep it fail-safe)", () => {
    expect(modelSupportsSamplingTemperature("")).toBe(true)
    expect(modelSupportsSamplingTemperature("some-future-model")).toBe(true)
  })
})
