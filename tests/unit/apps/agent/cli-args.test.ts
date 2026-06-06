/**
 * RFC may-22-unified-agent-runtime / Phase 4 — `parseAgentArgs` contract.
 *
 * Propositional cases: every test pins one exact parser rule (mode required,
 * unknown flag rejects, dial mapping, mode-specific gate, integer parsing,
 * enum validation, help short-circuit). No heuristic / threshold tests.
 */
import { describe, expect, test } from "bun:test"
import { AgentArgsError, formatHelp, parseAgentArgs } from "@/../src/apps/agent/cli-args"

describe("parseAgentArgs — happy paths", () => {
  test("valid --mode interactive parses", () => {
    const a = parseAgentArgs(["--mode", "interactive"])
    expect(a.mode).toBe("interactive")
    expect(a.help).toBe(false)
    expect(a.dials).toEqual({})
  })

  test("--mode headless with -p parses", () => {
    const a = parseAgentArgs(["--mode", "headless", "-p", "do the thing"])
    expect(a.mode).toBe("headless")
    expect(a.prompt).toBe("do the thing")
  })

  test("--mode headless with --prompt parses", () => {
    const a = parseAgentArgs(["--mode", "headless", "--prompt", "task body"])
    expect(a.prompt).toBe("task body")
  })

  test("--mode batch --corpus X --instance foo parses", () => {
    const a = parseAgentArgs([
      "--mode",
      "batch",
      "--corpus",
      "/tmp/corpus",
      "--instance",
      "django_017",
    ])
    expect(a.mode).toBe("batch")
    expect(a.corpus).toBe("/tmp/corpus")
    expect(a.instance).toBe("django_017")
  })

  test("--mode ci-bot --pr 42 parses", () => {
    const a = parseAgentArgs(["--mode", "ci-bot", "--pr", "42"])
    expect(a.mode).toBe("ci-bot")
    expect(a.pr).toBe("42")
  })

  test("dial flag maps kebab-case to BudgetDials field", () => {
    const a = parseAgentArgs([
      "--mode",
      "interactive",
      "--max-turns",
      "50",
      "--max-wall-clock-ms",
      "1800000",
      "--max-cost-usd",
      "5",
    ])
    expect(a.dials.maxTurns).toBe(50)
    expect(a.dials.maxWallClockMs).toBe(1800000)
    expect(a.dials.maxCostUsd).toBe(5)
  })

  test("--model + --provider parses", () => {
    const a = parseAgentArgs([
      "--mode",
      "interactive",
      "--model",
      "gpt-5-mini",
      "--provider",
      "openai",
    ])
    expect(a.model).toBe("gpt-5-mini")
    expect(a.provider).toBe("openai")
  })

  test("--exhaustion parses every valid enum value", () => {
    for (const v of [
      "ask-user",
      "stop",
      "stop-with-summary",
      "emit-partial",
      "fail-run",
    ] as const) {
      const a = parseAgentArgs(["--mode", "interactive", "--exhaustion", v])
      expect(a.exhaustion).toBe(v)
    }
  })
})

describe("parseAgentArgs — error paths", () => {
  test("missing --mode throws", () => {
    expect(() => parseAgentArgs([])).toThrow(AgentArgsError)
  })

  test("unknown flag throws AgentArgsError", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--foo"])).toThrow(/unknown flag '--foo'/)
  })

  test("--corpus without --mode batch throws", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--corpus", "/x"])).toThrow(
      /--corpus is only valid with --mode batch/,
    )
  })

  test("--pr without --mode ci-bot throws", () => {
    expect(() => parseAgentArgs(["--mode", "headless", "--pr", "7"])).toThrow(
      /--pr is only valid with --mode ci-bot/,
    )
  })

  test("-p outside --mode headless throws", () => {
    expect(() => parseAgentArgs(["--mode", "batch", "-p", "task"])).toThrow(
      /-p\/--prompt is only valid with --mode headless/,
    )
  })

  test("non-integer dial throws", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--max-turns", "abc"])).toThrow(
      /expects an integer/,
    )
  })

  test("dial value with non-numeric suffix throws (not silently parsed)", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--max-turns", "12abc"])).toThrow(
      /expects an integer/,
    )
  })

  test("negative dial throws", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--max-turns", "-1"])).toThrow(
      /must be >= 0/,
    )
  })

  test("invalid --mode enum throws", () => {
    expect(() => parseAgentArgs(["--mode", "wat"])).toThrow(/--mode must be/)
  })

  test("invalid --provider enum throws", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--provider", "google"])).toThrow(
      /--provider must be/,
    )
  })

  test("invalid --exhaustion enum throws", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--exhaustion", "panic"])).toThrow(
      /--exhaustion must be/,
    )
  })

  test("flag value that looks like another flag is rejected", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--model", "--provider"])).toThrow(
      /flag '--model' requires a value/,
    )
  })

  test("flag missing its value at end of argv throws", () => {
    expect(() => parseAgentArgs(["--mode"])).toThrow(/requires a value/)
  })
})

describe("parseAgentArgs — help short-circuit", () => {
  test("--help short-circuits before mode validation", () => {
    const a = parseAgentArgs(["--help"])
    expect(a.help).toBe(true)
  })

  test("-h short-circuits before mode validation", () => {
    const a = parseAgentArgs(["-h"])
    expect(a.help).toBe(true)
  })

  test("--help wins even with otherwise-invalid args", () => {
    const a = parseAgentArgs(["--mode", "wat", "--help"])
    expect(a.help).toBe(true)
  })
})

describe("formatHelp", () => {
  test("returns a non-empty stable string mentioning every mode", () => {
    const h = formatHelp()
    expect(h).toContain("interactive")
    expect(h).toContain("headless")
    expect(h).toContain("batch")
    expect(h).toContain("ci-bot")
    expect(h).toContain("--mode")
  })

  test("documents every dial flag", () => {
    const h = formatHelp()
    expect(h).toContain("--max-turns")
    expect(h).toContain("--max-wall-clock-ms")
    expect(h).toContain("--max-cost-usd")
    expect(h).toContain("--max-patch-bytes")
  })

  test("documents the headless structured-output flags", () => {
    const h = formatHelp()
    expect(h).toContain("--output-format")
    expect(h).toContain("--include-partial")
  })
})

describe("parseAgentArgs — P26 headless --output-format / --include-partial", () => {
  test("absent ⇒ outputFormat/includePartial slots omitted (byte-identical)", () => {
    const a = parseAgentArgs(["--mode", "headless", "-p", "task"])
    expect(a.outputFormat).toBeUndefined()
    expect(a.includePartial).toBeUndefined()
  })

  test.each(["text", "json", "stream-json"] as const)(
    "accepts --output-format %s",
    (fmt) => {
      const a = parseAgentArgs(["--mode", "headless", "-p", "task", "--output-format", fmt])
      expect(a.outputFormat).toBe(fmt)
    },
  )

  test("rejects an invalid --output-format value", () => {
    expect(() =>
      parseAgentArgs(["--mode", "headless", "-p", "task", "--output-format", "yaml"]),
    ).toThrow(/--output-format must be one of/)
  })

  test("rejects --output-format outside --mode headless", () => {
    expect(() =>
      parseAgentArgs(["--mode", "interactive", "--output-format", "json"]),
    ).toThrow(/--output-format is only valid with --mode headless/)
  })

  test("rejects --include-partial outside --mode headless", () => {
    expect(() =>
      parseAgentArgs(["--mode", "interactive", "--include-partial"]),
    ).toThrow(/--include-partial is only valid with --mode headless/)
  })

  test("rejects --include-partial without a structured --output-format", () => {
    expect(() =>
      parseAgentArgs(["--mode", "headless", "-p", "task", "--include-partial"]),
    ).toThrow(/--include-partial requires --output-format json\|stream-json/)
  })

  test("rejects --include-partial with --output-format text", () => {
    expect(() =>
      parseAgentArgs([
        "--mode",
        "headless",
        "-p",
        "task",
        "--output-format",
        "text",
        "--include-partial",
      ]),
    ).toThrow(/--include-partial requires --output-format json\|stream-json/)
  })

  test.each(["json", "stream-json"] as const)(
    "accepts --include-partial with --output-format %s",
    (fmt) => {
      const a = parseAgentArgs([
        "--mode",
        "headless",
        "-p",
        "task",
        "--output-format",
        fmt,
        "--include-partial",
      ])
      expect(a.outputFormat).toBe(fmt)
      expect(a.includePartial).toBe(true)
    },
  )
})
