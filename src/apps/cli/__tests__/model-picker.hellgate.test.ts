/**
 * Hellgate — `/model` picker PURE core (ticket 14, §11.6).
 *
 * Three pure fns, adversarial coverage each:
 *   formatModelLine — badge/hint/current-marker + graceful degrade when a
 *     metadata field is absent (omit, never placeholder).
 *   pickModel — exact, then case-insensitive, then not-found THROW (typed);
 *     trims input; returns the CANDIDATE's spelling on a CI hit.
 *   clampEffortForModel — unsupported tier → model default + notice; supported
 *     tier → no-op; NO metadata (undefined) → conservative all-supported, never
 *     clamps, never invents a mismatch (the plan's risk-note fallback).
 *
 * Also pins the provider-metadata SSOT (`resolveModelEffortSupport`) the
 * adapter projects from: reasoning vs non-reasoning classification + family
 * fallback + unknown → undefined.
 */
import { describe, expect, test } from "bun:test"
import type { EffortLevel } from "@/agent"
import {
  ALL_REASONING_EFFORTS,
  type ModelEffortSupport,
  resolveModelEffortSupport,
} from "@/llm/provider-metadata"
import {
  clampEffortForModel,
  formatModelLine,
  pickModel,
  UnknownModelError,
} from "../slash/model-picker"

const NON_REASONING: ModelEffortSupport = {
  supportedEfforts: ["default"],
  defaultEffort: "default",
  reasoning: false,
}
const REASONING: ModelEffortSupport = {
  supportedEfforts: ALL_REASONING_EFFORTS,
  defaultEffort: "default",
  reasoning: true,
}

describe("formatModelLine — render + graceful degrade", () => {
  test("full metadata ⇒ id + ctx + out + badge + hint, current-marker `*`", () => {
    const line = formatModelLine(
      {
        id: "gpt-5",
        contextWindow: 400_000,
        maxOutput: 128_000,
        recommended: true,
        hint: "most capable",
      },
      true,
    )
    expect(line.trimStart().startsWith("*")).toBe(true)
    expect(line).toContain("gpt-5")
    expect(line).toContain("400k ctx")
    expect(line).toContain("128k out")
    expect(line).toContain("(recommended)")
    expect(line).toContain("most capable")
    expect(line.endsWith("\n")).toBe(true)
  })

  test("non-current ⇒ no `*` marker (space column)", () => {
    const line = formatModelLine({ id: "gpt-4o", contextWindow: 128_000 }, false)
    expect(line.trimStart().startsWith("*")).toBe(false)
    expect(line).toContain("gpt-4o")
    expect(line).toContain("128k ctx")
  })

  test("absent fields are OMITTED, not placeholdered (degrade)", () => {
    // No window, no output, no badge, no hint ⇒ bare id only.
    const line = formatModelLine({ id: "future-model-xyz" }, false)
    expect(line).toContain("future-model-xyz")
    expect(line).not.toContain("ctx")
    expect(line).not.toContain("out")
    expect(line).not.toContain("recommended")
    expect(line).not.toContain("undefined")
    expect(line).not.toContain("unknown")
    expect(line).not.toContain("·")
  })

  test("partial metadata: window present, output absent ⇒ only ctx segment", () => {
    const line = formatModelLine({ id: "m", contextWindow: 200_000 }, false)
    expect(line).toContain("200k ctx")
    expect(line).not.toContain("out")
  })

  test("recommended:false and empty hint are omitted", () => {
    const line = formatModelLine({ id: "m", recommended: false, hint: "   " }, false)
    expect(line).not.toContain("recommended")
    expect(line).not.toContain("·")
  })

  test("1M window renders compactly as 1M", () => {
    const line = formatModelLine({ id: "claude-sonnet-4-6-1m", contextWindow: 1_000_000 }, false)
    expect(line).toContain("1M ctx")
  })
})

describe("pickModel — exact / case-insensitive / not-found throw", () => {
  const candidates = ["gpt-5", "claude-opus-4-8", "gpt-4o-mini"]

  test("exact match returns the candidate verbatim", () => {
    expect(pickModel("claude-opus-4-8", candidates)).toBe("claude-opus-4-8")
  })

  test("case-insensitive match returns the CANDIDATE's spelling", () => {
    expect(pickModel("GPT-5", candidates)).toBe("gpt-5")
    expect(pickModel("Claude-Opus-4-8", candidates)).toBe("claude-opus-4-8")
  })

  test("whitespace is trimmed", () => {
    expect(pickModel("  gpt-4o-mini  ", candidates)).toBe("gpt-4o-mini")
  })

  test("exact wins over a case-insensitive collision", () => {
    // Two ids differing only in case; exact must win.
    const cs = ["Model-A", "model-a"]
    expect(pickModel("model-a", cs)).toBe("model-a")
    expect(pickModel("Model-A", cs)).toBe("Model-A")
  })

  test("not-found throws a typed UnknownModelError carrying the known list", () => {
    expect(() => pickModel("o3-mini", candidates)).toThrow(UnknownModelError)
    try {
      pickModel("o3-mini", candidates)
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownModelError)
      const err = e as UnknownModelError
      expect(err.requested).toBe("o3-mini")
      expect(err.known).toEqual(candidates)
    }
  })

  test("empty candidate set ⇒ any id throws", () => {
    expect(() => pickModel("gpt-5", [])).toThrow(UnknownModelError)
  })
})

describe("clampEffortForModel — Codex validateEffort mirror (SOTA++ CORE)", () => {
  test("unsupported tier on a non-reasoning model ⇒ clamp to default + notice", () => {
    const res = clampEffortForModel("gpt-4o", "high", NON_REASONING)
    expect(res.clamped).toBe(true)
    expect(res.effort).toBe("default")
    expect(res.notice).toBeDefined()
    expect(res.notice).toContain("gpt-4o")
    expect(res.notice).toContain("high")
    expect(res.notice).toContain("default")
  })

  test("supported tier ⇒ no-op (effort kept, no notice)", () => {
    const res = clampEffortForModel("gpt-5", "high", REASONING)
    expect(res.clamped).toBe(false)
    expect(res.effort).toBe("high")
    expect(res.notice).toBeUndefined()
  })

  test("'default' is always supported by a non-reasoning model ⇒ no clamp", () => {
    const res = clampEffortForModel("gpt-4o", "default", NON_REASONING)
    expect(res.clamped).toBe(false)
    expect(res.effort).toBe("default")
  })

  test("NO metadata (undefined) ⇒ conservative all-supported: never clamp", () => {
    for (const lvl of ["default", "low", "medium", "high", "max"] as EffortLevel[]) {
      const res = clampEffortForModel("future-model", lvl, undefined)
      expect(res.clamped).toBe(false)
      expect(res.effort).toBe(lvl)
      expect(res.notice).toBeUndefined()
    }
  })

  test("clamp target is always the model's own defaultEffort", () => {
    const support: ModelEffortSupport = {
      supportedEfforts: ["default", "low", "medium"],
      defaultEffort: "medium",
      reasoning: true,
    }
    const res = clampEffortForModel("custom", "max", support)
    expect(res.clamped).toBe(true)
    expect(res.effort).toBe("medium")
  })
})

describe("resolveModelEffortSupport — metadata SSOT (provider-metadata.ts)", () => {
  test("reasoning models support all five tiers", () => {
    for (const id of ["gpt-5", "claude-opus-4-8", "o1", "o3-mini", "gpt-5-codex"]) {
      const s = resolveModelEffortSupport(id)
      expect(s).toBeDefined()
      expect(s?.reasoning).toBe(true)
      expect(s?.supportedEfforts).toEqual(ALL_REASONING_EFFORTS)
    }
  })

  test("non-reasoning models support only 'default'", () => {
    for (const id of ["gpt-4o", "gpt-4o-mini", "claude-3-5-haiku", "claude-3-5-sonnet"]) {
      const s = resolveModelEffortSupport(id)
      expect(s).toBeDefined()
      expect(s?.reasoning).toBe(false)
      expect(s?.supportedEfforts).toEqual(["default"])
    }
  })

  test("family fallback: dated gpt-4o slug ⇒ non-reasoning (not mis-classified)", () => {
    const s = resolveModelEffortSupport("gpt-4o-2026-01-01")
    expect(s?.reasoning).toBe(false)
  })

  test("family fallback: dated claude-3-5-haiku ⇒ non-reasoning, NOT broad-reasoning", () => {
    const s = resolveModelEffortSupport("claude-3-5-haiku-20241022")
    expect(s?.reasoning).toBe(false)
  })

  test("family fallback: dated opus slug ⇒ reasoning", () => {
    const s = resolveModelEffortSupport("claude-opus-4-8-20260101")
    expect(s?.reasoning).toBe(true)
  })

  test("unknown model ⇒ undefined (conservative no-clamp path)", () => {
    expect(resolveModelEffortSupport("totally-unknown-vendor-9000")).toBeUndefined()
    expect(resolveModelEffortSupport("")).toBeUndefined()
  })
})
