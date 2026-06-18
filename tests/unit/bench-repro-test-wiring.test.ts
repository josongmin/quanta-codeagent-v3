/**
 * Bench driver wiring for `QUANTA_BENCH_REPRO_TEST=K`.
 *
 * Invariants:
 *   - `parseBenchReproTestK` accepts integers in [1, 40]; rejects every
 *     other shape (garbage / NaN / negative / 0 / >40 / non-integer).
 *   - `prepareReproTest(K=undefined)` ⇒ null (byte-identical to baseline).
 *   - `prepareReproTest(K=5, mock LLM)` happy path ⇒ selection with
 *     `selected` non-null.
 *   - `prepareReproTest` swallows LLM / exec failures ⇒ null.
 *   - `buildConfig` with `reproHint=""` is byte-identical to the path
 *     without reproHint.
 *   - `buildConfig` with `reproHint="X"` prepends X to the user text.
 *   - `composeWithReproHint` placement: hint + repro + base vs. repro + base
 *     vs. just hintedBase.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  benchOptIns,
  buildConfig,
  composeWithReproHint,
  parseBenchReproTestK,
  prepareReproTest,
  prepareReproTestDetailed,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
} from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "../../src/llm"
import type { StreamPort } from "../../src/stream"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: 'print("Issue reproduced")' }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class NullStream implements StreamPort {
  emit(_event: unknown): void {}
}

const mkInstance = (overrides: Partial<Instance> = {}): Instance => ({
  id: "test",
  repoPath: "/tmp/x",
  problemStatement: "the bug is in foo.py",
  testCmd: "true",
  ...overrides,
})

const ENV_KEYS = ["QUANTA_BENCH_REPRO_TEST", "QUANTA_BENCH_ISSUE_HINT"] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  restore(saved)
})

// ─── parseBenchReproTestK ────────────────────────────────────────────────

describe("parseBenchReproTestK", () => {
  test("absent ⇒ undefined", () => {
    expect(parseBenchReproTestK(undefined)).toBeUndefined()
  })

  test("empty / whitespace ⇒ undefined", () => {
    expect(parseBenchReproTestK("")).toBeUndefined()
    expect(parseBenchReproTestK("   ")).toBeUndefined()
  })

  test("valid integer 1..40 ⇒ parsed", () => {
    expect(parseBenchReproTestK("1")).toBe(1)
    expect(parseBenchReproTestK("5")).toBe(5)
    expect(parseBenchReproTestK("40")).toBe(40)
  })

  test("0 / negative ⇒ undefined", () => {
    expect(parseBenchReproTestK("0")).toBeUndefined()
    expect(parseBenchReproTestK("-1")).toBeUndefined()
  })

  test(">40 ⇒ undefined", () => {
    expect(parseBenchReproTestK("41")).toBeUndefined()
    expect(parseBenchReproTestK("100")).toBeUndefined()
  })

  test("non-integer / garbage ⇒ undefined", () => {
    expect(parseBenchReproTestK("5.5")).toBeUndefined()
    expect(parseBenchReproTestK("abc")).toBeUndefined()
    expect(parseBenchReproTestK("5abc")).toBeUndefined()
    expect(parseBenchReproTestK("NaN")).toBeUndefined()
    expect(parseBenchReproTestK("Infinity")).toBeUndefined()
  })

  test("benchOptIns unaffected (no overlap with this flag)", () => {
    process.env.QUANTA_BENCH_REPRO_TEST = "5"
    // The opt-in resolver explicitly does NOT include repro-test (orthogonal
    // axis); only `QUANTA_BENCH_ISSUE_HINT` toggles issueHintMode.
    expect(benchOptIns().issueHintMode).toBe("off")
  })
})

// ─── prepareReproTest ────────────────────────────────────────────────────

describe("prepareReproTest", () => {
  test("K=undefined ⇒ null", async () => {
    const sel = await prepareReproTest(mkInstance(), "/tmp/sb", undefined, {
      llm: new StubLLM(),
    })
    expect(sel).toBeNull()
  })

  test("empty problem statement ⇒ null", async () => {
    const sel = await prepareReproTest(mkInstance({ problemStatement: "" }), "/tmp/sb", 5, {
      llm: new StubLLM(),
    })
    expect(sel).toBeNull()
  })

  test("happy path: K=3, mock LLM+exec ⇒ selection with non-null selected", async () => {
    const writes: { path: string; content: string }[] = []
    const sel = await prepareReproTest(mkInstance(), "/tmp/sb", 3, {
      llm: new StubLLM(),
      writeFile: async (path, content) => {
        writes.push({ path, content })
      },
      exec: async () => ({ code: 0, stdout: "Issue reproduced\n", stderr: "" }),
    })
    expect(sel).not.toBeNull()
    expect(sel?.selected).toBe('print("Issue reproduced")')
    expect(sel?.reproducedCount).toBe(3)
    // 3 scripts were written by the executor (not yet the final reproduce_issue.py).
    expect(writes).toHaveLength(3)
  })

  test("LLM stream failure ⇒ samples all '' ⇒ null selection", async () => {
    class ThrowLLM implements LLMPort {
      // biome-ignore lint/correctness/useYield: throws before any yield
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        throw new Error("provider down")
      }
    }
    const sel = await prepareReproTest(mkInstance(), "/tmp/sb", 3, {
      llm: new ThrowLLM(),
      writeFile: async () => {},
      exec: async () => ({ code: 0, stdout: "Issue reproduced\n", stderr: "" }),
    })
    // Generator returns ["", "", ""], executor classifies each as "unknown".
    expect(sel?.selected).toBeNull()
    expect(sel?.reproducedCount).toBe(0)
  })

  test("exec failures (Python missing) ⇒ all exec_failed ⇒ null selection", async () => {
    const sel = await prepareReproTest(mkInstance(), "/tmp/sb", 3, {
      llm: new StubLLM(),
      writeFile: async () => {},
      exec: async () => {
        throw new Error("python: command not found")
      },
    })
    expect(sel?.selected).toBeNull()
    expect(sel?.reproducedCount).toBe(0)
  })

  test("detailed telemetry: disabled knob records disabled reason", async () => {
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", undefined, {
      llm: new StubLLM(),
    })
    expect(detail.selection).toBeNull()
    expect(detail.telemetry).toEqual({ installed: false, reason: "disabled" })
  })

  test("detailed telemetry: generator throw records generation_failed", async () => {
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 3, {
      llm: new StubLLM(),
      generate: async () => {
        throw new Error("provider down")
      },
    })
    expect(detail.selection).toBeNull()
    expect(detail.telemetry).toEqual({
      installed: false,
      reason: "generation_failed",
      samples: 0,
      reproducedCount: 0,
    })
  })

  test("detailed telemetry: all exec_failed samples records execution_failed", async () => {
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 3, {
      llm: new StubLLM(),
      writeFile: async () => {},
      exec: async () => {
        throw new Error("python: command not found")
      },
    })
    expect(detail.selection?.selected).toBeNull()
    expect(detail.telemetry).toMatchObject({
      installed: false,
      reason: "execution_failed",
      samples: 3,
      reproducedCount: 0,
    })
    // The exec-throw reason is now captured into the diagnostic stderr tail
    // (never silent) — this is what attributed the original ENOENT.
    const t = detail.telemetry as { sampleStderrTail?: string }
    expect(t.sampleStderrTail).toContain("command not found")
  })

  test("WIRING: swebench instance ⇒ repro runs under uvx editable-install env (not bare python)", async () => {
    const seen: (readonly string[])[] = []
    await prepareReproTestDetailed(
      mkInstance({
        swebench: { instanceId: "sympy__sympy-1", repo: "sympy/sympy", baseCommit: "abc" },
      }),
      "/tmp/sb",
      1,
      {
        llm: new StubLLM(),
        writeFile: async () => {},
        exec: async (argv) => {
          seen.push(argv)
          return { code: 0, stdout: "Issue reproduced\n", stderr: "" }
        },
      },
    )
    // The exec argv must be the uvx env wrapper — a bare `python3` here is the
    // ModuleNotFoundError bug that made primary_rail_present_rate = 0.
    expect(seen[0]?.[0]).toBe("uvx")
    expect(seen[0]).toContain("--with-editable")
    expect(seen[0]?.[seen[0].length - 2]).toBe("python")
  })

  test("WIRING: non-swebench fixture ⇒ repro runs bare python3 (no uvx)", async () => {
    const seen: (readonly string[])[] = []
    await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 1, {
      llm: new StubLLM(),
      writeFile: async () => {},
      exec: async (argv) => {
        seen.push(argv)
        return { code: 0, stdout: "Issue reproduced\n", stderr: "" }
      },
    })
    expect(seen[0]?.[0]).toBe("python3")
    expect(seen[0]).not.toContain("uvx")
  })

  test("detailed telemetry: no reproduced candidate records sample counts", async () => {
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 2, {
      llm: new StubLLM(),
      writeFile: async () => {},
      exec: async () => ({ code: 0, stdout: "Issue resolved\n", stderr: "" }),
    })
    expect(detail.selection?.selected).toBeNull()
    // objectContaining: the telemetry also carries jun-18 diagnostic fields
    // (sampleOutcomes / sampleStdoutTail / sampleStderrTail) which are tested
    // separately; here we pin the stable classification fields.
    expect(detail.telemetry).toMatchObject({
      installed: false,
      reason: "no_reproduced_candidate",
      samples: 2,
      reproducedCount: 0,
    })
  })

  test("detailed telemetry: selected candidate records sample counts without claiming install", async () => {
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 2, {
      llm: new StubLLM(),
      writeFile: async () => {},
      exec: async () => ({ code: 0, stdout: "Issue reproduced\n", stderr: "" }),
    })
    expect(detail.selection?.selected).toBe('print("Issue reproduced")')
    expect(detail.telemetry).toEqual({
      installed: false,
      reason: "not_installed",
      samples: 2,
      reproducedCount: 2,
    })
  })
})

// ─── buildConfig byte-identity / hint placement ─────────────────────────

describe("buildConfig — repro hint placement", () => {
  const deps = { llm: new StubLLM(), maxTurns: 10, timeoutMs: 1000 }
  const sandbox = "/tmp/sb"
  const ac = new AbortController()

  test("reproHint=undefined ⇒ byte-identical to pre-feature path", () => {
    const a = buildConfig(mkInstance(), deps, sandbox, ac.signal, new NullStream())
    const b = buildConfig(
      mkInstance(),
      deps,
      sandbox,
      ac.signal,
      new NullStream(),
      undefined,
      undefined,
      undefined,
    )
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
  })

  test("reproHint='' ⇒ byte-identical to undefined", () => {
    const a = buildConfig(
      mkInstance(),
      deps,
      sandbox,
      ac.signal,
      new NullStream(),
      undefined,
      undefined,
      undefined,
    )
    const b = buildConfig(
      mkInstance(),
      deps,
      sandbox,
      ac.signal,
      new NullStream(),
      undefined,
      undefined,
      "",
    )
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
  })

  test("reproHint non-empty ⇒ injected into user message", () => {
    const cfg = buildConfig(
      mkInstance(),
      deps,
      sandbox,
      ac.signal,
      new NullStream(),
      undefined,
      undefined,
      "REPRO_DIRECTIVE",
    )
    const userText = (cfg.messages[0]?.content?.[0] as { text: string }).text
    expect(userText).toContain("REPRO_DIRECTIVE")
    // The repro line comes BEFORE the base task text.
    expect(userText.indexOf("REPRO_DIRECTIVE")).toBeLessThan(
      userText.indexOf(mkInstance().problemStatement),
    )
  })

  test("reproHint + issueHint=regex ⇒ issue-hint first, then repro, then base", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const cfg = buildConfig(
      mkInstance({ problemStatement: "See requests/models.py for the bug. UnicodeError" }),
      deps,
      sandbox,
      ac.signal,
      new NullStream(),
      undefined,
      undefined,
      "REPRO_DIRECTIVE",
    )
    const userText = (cfg.messages[0]?.content?.[0] as { text: string }).text
    const iHint = userText.indexOf("## Issue evidence (verbatim)")
    const iRepro = userText.indexOf("REPRO_DIRECTIVE")
    const iBase = userText.indexOf("Work inside")
    expect(iHint).toBeGreaterThanOrEqual(0)
    expect(iRepro).toBeGreaterThan(iHint)
    expect(iBase).toBeGreaterThan(iRepro)
  })
})

// ─── composeWithReproHint pure tests ─────────────────────────────────────

describe("composeWithReproHint", () => {
  test("reproHint undefined ⇒ hintedBase verbatim", () => {
    expect(composeWithReproHint("H", "H\n\nB", "B", undefined)).toBe("H\n\nB")
    expect(composeWithReproHint("", "B", "B", undefined)).toBe("B")
  })

  test("reproHint '' ⇒ hintedBase verbatim (byte-identical)", () => {
    expect(composeWithReproHint("H", "H\n\nB", "B", "")).toBe("H\n\nB")
    expect(composeWithReproHint("", "B", "B", "")).toBe("B")
  })

  test("reproHint non-empty + hint non-empty ⇒ H + R + B", () => {
    expect(composeWithReproHint("H", "H\n\nB", "B", "R")).toBe("H\n\nR\n\nB")
  })

  test("reproHint non-empty + hint empty ⇒ R + B (no leading hint section)", () => {
    expect(composeWithReproHint("", "B", "B", "R")).toBe("R\n\nB")
  })
})

// ─── exported constants ──────────────────────────────────────────────────

describe("exported constants", () => {
  test("REPRO_FILE_NAME is `reproduce_issue.py`", () => {
    expect(REPRO_FILE_NAME).toBe("reproduce_issue.py")
  })

  test("REPRO_HINT_MESSAGE mentions Issue resolved + file name", () => {
    expect(REPRO_HINT_MESSAGE).toContain("reproduce_issue.py")
    expect(REPRO_HINT_MESSAGE).toContain('"Issue resolved"')
  })
})
