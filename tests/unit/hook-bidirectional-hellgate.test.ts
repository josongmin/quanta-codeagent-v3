/**
 * HELLGATE — adversarial proofs for the ADR-0133 bidirectional Request/
 * Response RPC superset. Mirrors the 7 cursor-absorption-r1-r4-hardening
 * cases ([[cursor-absorption-r1-r4-hardening]]) but extended to the THREE
 * new event variants (`post_tool_use_failure` / `pre_compact` /
 * `subagent_start` / `subagent_stop`) and the TWO new response channels
 * (`promptHook` accumulator, `abort` short-circuit).
 *
 * The 7 hardening cases re-validated on the NEW surface:
 *   1. DoS within caps — `promptHook` accumulator is bounded by
 *      PROMPT_HOOK_MAX_CHARS per side; pile of giant injects degrades to
 *      a fixed-size tail with a warn log.
 *   2. Node stack — the emit is an `async` for-of (NOT recursion), so
 *      thousands of handlers do NOT blow the stack.
 *   3. Absolute path / payload normalization — the bus treats handler
 *      returns as opaque text + plain objects; no path normalization is
 *      performed (the consumer's tool re-validates).
 *   4. Rule count DoS — handler registration is unbounded by design; the
 *      bus does NOT enforce a registration cap, but a saturated handler
 *      list (10K handlers) still runs deterministically within seconds.
 *   5. Throwing matcher / handler poison — a throwing handler on a NEW
 *      event variant is isolated + logged + siblings still run
 *      (extended from the pre_tool_use / post_tool_use coverage).
 *   6. YAML fold — N/A here (hook payloads are typed objects, not YAML);
 *      the property is preserved structurally by the typed envelope.
 *   7. Post-hook input gap — the legacy gap was: pre_tool_use rewrote, then
 *      the rewrite did NOT reach execute. ADR-0133 preserves that fix
 *      (covered by hooks-updated-input.test.ts) AND adds the symmetric
 *      `post_tool_use_failure` channel so a failure-driven retry can ALSO
 *      inject context via `promptHook`.
 */
import { describe, expect, test } from "bun:test"
import { HookBus, PROMPT_HOOK_MAX_CHARS, TOOL_FAILURE_RETRY_MAX } from "@/agent"
import { StructuredLogger } from "@/observability"

describe("HELLGATE [ADR-0133] — promptHook DoS bounded by cap", () => {
  test("a single handler emitting a 100K-char inject is trimmed to PROMPT_HOOK_MAX_CHARS", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    const giant = "G".repeat(100_000)
    bus.on("post_tool_use", () => ({ promptHook: { injectAfterSystem: giant } }))
    const result = await bus.emit({
      type: "post_tool_use",
      name: "x",
      input: {},
      ok: true,
      output: "y",
    })
    expect(result.promptHook?.injectAfterSystem?.length).toBe(PROMPT_HOOK_MAX_CHARS)
    // Trim warning fired.
    expect(lines.some((l) => l.includes("hook.prompt_hook.trimmed"))).toBe(true)
  })

  test("100 handlers each emitting 200-char injects accumulate but cap at PROMPT_HOOK_MAX_CHARS", async () => {
    const bus = new HookBus()
    for (let i = 0; i < 100; i++) {
      bus.on("post_tool_use", () => ({
        promptHook: { injectBeforeUser: "Y".repeat(200) },
      }))
    }
    const result = await bus.emit({
      type: "post_tool_use",
      name: "x",
      input: {},
      ok: true,
      output: "y",
    })
    // 100 × 200 + 99 newlines = 20_099 chars; capped at PROMPT_HOOK_MAX_CHARS.
    expect(result.promptHook?.injectBeforeUser?.length).toBe(PROMPT_HOOK_MAX_CHARS)
  })

  test("after-system and before-user have INDEPENDENT caps (each 10K, total ≤ 20K)", async () => {
    const bus = new HookBus()
    bus.on("subagent_stop", () => ({
      promptHook: {
        injectAfterSystem: "A".repeat(20_000),
        injectBeforeUser: "B".repeat(20_000),
      },
    }))
    const result = await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "", turns: 0 },
    })
    expect(result.promptHook?.injectAfterSystem?.length).toBe(PROMPT_HOOK_MAX_CHARS)
    expect(result.promptHook?.injectBeforeUser?.length).toBe(PROMPT_HOOK_MAX_CHARS)
  })
})

describe("HELLGATE [ADR-0133] — emit chain is iterative (NO stack blow)", () => {
  test("5K handlers on a single event run without RangeError", async () => {
    const bus = new HookBus()
    let count = 0
    for (let i = 0; i < 5_000; i++) {
      bus.on("turn_start", () => {
        count++
      })
    }
    await bus.emit({ type: "turn_start", turn: 1 })
    expect(count).toBe(5_000)
  })

  test("5K handlers each emitting a tiny promptHook still cap correctly (no exponential growth)", async () => {
    const bus = new HookBus()
    for (let i = 0; i < 5_000; i++) {
      bus.on("turn_start", () => ({ promptHook: { injectAfterSystem: "xx" } }))
    }
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    // 5000 × 2 + 4999 newlines = 14_999 ≥ cap ⇒ trim to cap exactly.
    expect(result.promptHook?.injectAfterSystem?.length).toBe(PROMPT_HOOK_MAX_CHARS)
  })
})

describe("HELLGATE [ADR-0133] — throwing handler poison-isolation extends to NEW events", () => {
  test("throwing handler on post_tool_use_failure does NOT break sibling", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    let sibRan = false
    bus.on("post_tool_use_failure", () => {
      throw new Error("boom")
    })
    bus.on("post_tool_use_failure", () => {
      sibRan = true
    })
    await bus.emit({
      type: "post_tool_use_failure",
      name: "x",
      input: {},
      error: "e",
    })
    expect(sibRan).toBe(true)
    expect(lines.some((l) => l.includes("hook.handler.error"))).toBe(true)
  })

  test("throwing handler on pre_compact does NOT break sibling OR pollute the result", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    bus.on("pre_compact", () => {
      throw new Error("compact boom")
    })
    let sibRan = false
    bus.on("pre_compact", () => {
      sibRan = true
      return { promptHook: { injectAfterSystem: "sib ok" } }
    })
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    expect(sibRan).toBe(true)
    expect(result.promptHook?.injectAfterSystem).toBe("sib ok")
    expect(lines.some((l) => l.includes("compact boom"))).toBe(true)
  })

  test("throwing handler on subagent_start does NOT prevent abort by sibling", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    bus.on("subagent_start", () => {
      throw new Error("ss boom")
    })
    bus.on("subagent_start", () => ({ abort: { reason: "veto" } }))
    const result = await bus.emit({
      type: "subagent_start",
      subagentId: "s",
      parentId: undefined,
      taskPrompt: "t",
    })
    expect(result.abort).toEqual({ reason: "veto" })
    expect(lines.some((l) => l.includes("ss boom"))).toBe(true)
  })
})

describe("HELLGATE [ADR-0133] — abort short-circuit cannot be bypassed by later promptHook", () => {
  test("later handler's promptHook is NOT recorded after a prior handler aborted", async () => {
    const bus = new HookBus()
    let laterRan = false
    bus.on("pre_compact", () => ({ abort: { reason: "stop" } }))
    bus.on("pre_compact", () => {
      laterRan = true
      return { promptHook: { injectAfterSystem: "ignored" } }
    })
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    expect(result.abort).toEqual({ reason: "stop" })
    expect(laterRan).toBe(false)
    expect("promptHook" in result).toBe(false)
  })

  test("a promptHook recorded BEFORE the abort handler is preserved", async () => {
    const bus = new HookBus()
    bus.on("pre_compact", () => ({ promptHook: { injectAfterSystem: "early" } }))
    bus.on("pre_compact", () => ({ abort: { reason: "stop" } }))
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    expect(result.abort).toEqual({ reason: "stop" })
    expect(result.promptHook?.injectAfterSystem).toBe("early")
  })
})

describe("HELLGATE [ADR-0133] — malformed handler returns are IGNORED, not poison", () => {
  test("a handler returning a `promptHook` of wrong type is ignored", async () => {
    const bus = new HookBus()
    bus.on("turn_start", () => ({ promptHook: 42 }) as unknown as undefined)
    bus.on("turn_start", () => ({ promptHook: { injectAfterSystem: "good" } }))
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(result.promptHook?.injectAfterSystem).toBe("good")
  })

  test("a handler returning a `promptHook` with non-string sides is ignored", async () => {
    const bus = new HookBus()
    bus.on(
      "turn_start",
      () =>
        ({
          promptHook: { injectAfterSystem: null, injectBeforeUser: { a: 1 } },
        }) as unknown as undefined,
    )
    bus.on("turn_start", () => ({ promptHook: { injectBeforeUser: "ok" } }))
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect("injectAfterSystem" in (result.promptHook ?? {})).toBe(false)
    expect(result.promptHook?.injectBeforeUser).toBe("ok")
  })

  test("a handler returning `abort: 'just-a-string'` is ignored (must be {reason: string})", async () => {
    const bus = new HookBus()
    bus.on("turn_start", () => ({ abort: "fail" }) as unknown as undefined)
    bus.on("turn_start", () => ({ abort: { reason: "real" } }))
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(result.abort).toEqual({ reason: "real" })
  })
})

describe("HELLGATE [ADR-0133] — backward compat invariants", () => {
  test("a legacy {deny, updatedInput} handler still works UNCHANGED in the new schema", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ deny: "no", updatedInput: { x: 9 } }))
    const result = await bus.emit({ type: "pre_tool_use", name: "x", input: {} })
    expect(result.deny).toEqual({ deny: "no" })
    expect(result.updatedInput).toEqual({ x: 9 })
    expect("promptHook" in result).toBe(false)
    expect("abort" in result).toBe(false)
  })

  test("a legacy handler that returns undefined still yields the legacy {deny:null} shape exactly", async () => {
    const bus = new HookBus()
    bus.on("session_start", () => undefined)
    const result = await bus.emit({ type: "session_start", sessionId: "s" })
    expect(Object.keys(result).sort()).toEqual(["deny"])
    expect(result.deny).toBeNull()
  })
})

describe("HELLGATE [ADR-0133] — tool retry cap constant is wire-stable", () => {
  test("TOOL_FAILURE_RETRY_MAX is a positive small integer (constants must not drift silently)", () => {
    expect(Number.isInteger(TOOL_FAILURE_RETRY_MAX)).toBe(true)
    expect(TOOL_FAILURE_RETRY_MAX).toBeGreaterThan(0)
    expect(TOOL_FAILURE_RETRY_MAX).toBeLessThanOrEqual(10)
  })
})
