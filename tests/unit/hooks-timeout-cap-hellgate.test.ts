/**
 * HELLGATE — S5 hook hardening. Adversarial proofs for:
 *   - per-handler timeout (race + log + continue; default-OFF preserves
 *     legacy unbounded behavior; per-registration override wins over env)
 *   - DoS caps (handlers-per-event throws; payload bytes truncate)
 *   - anti-leak (timeout / truncation warnings do NOT include the payload
 *     itself, only event kind / size / elapsed)
 *
 * Tests reach for the bus directly (`@/agent/hooks`) instead of the @/agent
 * barrel so the symbol set under test does not depend on the WIP-protected
 * `src/agent/index.ts` re-export surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HookBus,
  HookRegistrationError,
  MAX_HANDLERS_PER_EVENT,
  MAX_PAYLOAD_BYTES,
  PAYLOAD_TRUNCATE_MARKER,
  truncatePayload,
} from "@/agent/hooks"
import { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"

const noEnvTimeout = (): void => {
  delete process.env.QUANTA_HOOK_TIMEOUT_MS
  delete process.env.QUANTA_HOOK_MAX_HANDLERS
  delete process.env.QUANTA_HOOK_MAX_PAYLOAD_BYTES
  __resetRuntimeConfig()
}

beforeEach(noEnvTimeout)
afterEach(noEnvTimeout)

describe("S5 hook hardening — per-handler timeout", () => {
  test("a handler that resolves within its timeout returns its value", async () => {
    const bus = new HookBus()
    bus.on("turn_start", async () => ({ promptHook: { injectAfterSystem: "ok" } }), {
      timeoutMs: 100,
    })
    // Tiny sleep ⇒ well under the 100ms budget.
    await new Promise((r) => setTimeout(r, 5))
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(result.promptHook?.injectAfterSystem).toBe("ok")
    expect(result.timeoutCount).toBeUndefined()
  })

  test("a handler that exceeds its timeout is dropped + logged + bus continues", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    let secondRan = false
    bus.on(
      "turn_start",
      async () => {
        // Sleep longer than the timeout — the bus must NOT wait for us.
        await new Promise((r) => setTimeout(r, 200))
        return { promptHook: { injectAfterSystem: "late" } }
      },
      { timeoutMs: 50 },
    )
    bus.on("turn_start", () => {
      secondRan = true
    })
    const t0 = Date.now()
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    const elapsed = Date.now() - t0
    // First handler timed out (50ms cap, slept 200) — must come back fast,
    // well under the 200ms it WOULD have taken to wait.
    expect(elapsed).toBeLessThan(180)
    expect(secondRan).toBe(true)
    // Timed-out handler's late return was DROPPED — its promptHook is not
    // reflected in the result.
    expect(result.promptHook).toBeUndefined()
    expect(result.timeoutCount).toBe(1)
    // Warning was logged with event kind + timeout, NO payload.
    expect(lines.length).toBeGreaterThan(0)
    const warn = lines.find((l) => l.includes("hook.handler.timeout"))
    expect(warn).toBeDefined()
    const parsed = JSON.parse(warn as string) as {
      event: string
      fields: { event: string; elapsed: number; timeoutMs: number }
    }
    expect(parsed.fields.event).toBe("turn_start")
    expect(parsed.fields.timeoutMs).toBe(50)
    expect(parsed.fields.elapsed).toBeGreaterThanOrEqual(50)
    // Anti-leak: payload / turn number must NOT appear in the warning text.
    expect(warn).not.toContain("payload")
  })

  test("multiple slow handlers: each ticks the timeoutCount", async () => {
    const bus = new HookBus()
    bus.on(
      "turn_start",
      async () => {
        await new Promise((r) => setTimeout(r, 100))
      },
      { timeoutMs: 20 },
    )
    bus.on(
      "turn_start",
      async () => {
        await new Promise((r) => setTimeout(r, 100))
      },
      { timeoutMs: 20 },
    )
    bus.on("turn_start", () => {
      // fast handler — not counted
    })
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(result.timeoutCount).toBe(2)
  })

  test("per-handler override WINS over runtime-config default", async () => {
    process.env.QUANTA_HOOK_TIMEOUT_MS = "10"
    __resetRuntimeConfig()
    const bus = new HookBus()
    let resolved = false
    bus.on(
      "turn_start",
      async () => {
        await new Promise((r) => setTimeout(r, 50))
        resolved = true
      },
      { timeoutMs: 500 }, // per-handler override — 500ms wins over env 10ms
    )
    await bus.emit({ type: "turn_start", turn: 1 })
    expect(resolved).toBe(true)
  })

  test("runtime-config default applies when no per-handler override is set", async () => {
    process.env.QUANTA_HOOK_TIMEOUT_MS = "20"
    __resetRuntimeConfig()
    const bus = new HookBus()
    bus.on("turn_start", async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    const t0 = Date.now()
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(Date.now() - t0).toBeLessThan(180)
    expect(result.timeoutCount).toBe(1)
  })

  test("constructor option default WINS over QUANTA knob", async () => {
    process.env.QUANTA_HOOK_TIMEOUT_MS = "20"
    __resetRuntimeConfig()
    const bus = new HookBus(undefined, { defaultTimeoutMs: 500 })
    let resolved = false
    bus.on("turn_start", async () => {
      await new Promise((r) => setTimeout(r, 50))
      resolved = true
    })
    await bus.emit({ type: "turn_start", turn: 1 })
    expect(resolved).toBe(true)
  })

  test("NO override AND NO QUANTA knob ⇒ unbounded (legacy byte-identical)", async () => {
    const bus = new HookBus()
    let resolved = false
    bus.on("turn_start", async () => {
      await new Promise((r) => setTimeout(r, 50))
      resolved = true
    })
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(resolved).toBe(true)
    // No timeout fired, no field added.
    expect(result.timeoutCount).toBeUndefined()
  })

  test("a slow handler does NOT block concurrent emits to a DIFFERENT bus", async () => {
    const slow = new HookBus()
    const fast = new HookBus()
    slow.on(
      "turn_start",
      async () => {
        await new Promise((r) => setTimeout(r, 100))
      },
      { timeoutMs: 20 },
    )
    let fastRan = 0
    fast.on("turn_start", () => {
      fastRan++
    })
    // Race: slow takes 20ms (timeout) ⇒ fast must complete in parallel.
    const [, fastResult] = await Promise.all([
      slow.emit({ type: "turn_start", turn: 1 }),
      fast.emit({ type: "turn_start", turn: 2 }),
    ])
    expect(fastRan).toBe(1)
    expect(fastResult.deny).toBeNull()
  })

  test("DEFAULT_HOOK_TIMEOUT_MS is 5000ms (documented in hooks.ts)", () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(5_000)
  })

  test("warning JSON does NOT include the event payload (anti-leak)", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    bus.on(
      "pre_tool_use",
      async () => {
        await new Promise((r) => setTimeout(r, 100))
      },
      { timeoutMs: 20 },
    )
    await bus.emit({
      type: "pre_tool_use",
      name: "secret_tool",
      input: { secretArg: "TOP_SECRET_VALUE_DO_NOT_LEAK" },
    })
    const text = lines.join("\n")
    expect(text).not.toContain("TOP_SECRET_VALUE_DO_NOT_LEAK")
    expect(text).not.toContain("secretArg")
  })
})

describe("S5 hook hardening — DoS caps", () => {
  test("registering MAX_HANDLERS_PER_EVENT (64) handlers succeeds", () => {
    const bus = new HookBus()
    for (let i = 0; i < MAX_HANDLERS_PER_EVENT; i++) {
      bus.on("turn_start", () => undefined)
    }
    // No throw — 64 fits exactly.
    expect(true).toBe(true)
  })

  test("registering a 65th handler throws HookRegistrationError", () => {
    const bus = new HookBus()
    for (let i = 0; i < MAX_HANDLERS_PER_EVENT; i++) {
      bus.on("turn_start", () => undefined)
    }
    expect(() => bus.on("turn_start", () => undefined)).toThrow(HookRegistrationError)
  })

  test("the cap is PER EVENT (not global) — sibling events stay unaffected", () => {
    const bus = new HookBus()
    for (let i = 0; i < MAX_HANDLERS_PER_EVENT; i++) {
      bus.on("turn_start", () => undefined)
    }
    // session_start is independent — still has 0/64 capacity.
    for (let i = 0; i < 10; i++) {
      bus.on("session_start", () => undefined)
    }
    expect(true).toBe(true)
  })

  test("HookRegistrationError carries an actionable name + message", () => {
    const bus = new HookBus()
    for (let i = 0; i < MAX_HANDLERS_PER_EVENT; i++) {
      bus.on("turn_start", () => undefined)
    }
    try {
      bus.on("turn_start", () => undefined)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(HookRegistrationError)
      expect((e as Error).name).toBe("HookRegistrationError")
      expect((e as Error).message).toContain("turn_start")
      expect((e as Error).message).toContain("64")
      expect((e as Error).message).toContain("QUANTA_HOOK_MAX_HANDLERS")
    }
  })

  test("knob QUANTA_HOOK_MAX_HANDLERS raises the cap", () => {
    process.env.QUANTA_HOOK_MAX_HANDLERS = "128"
    __resetRuntimeConfig()
    const bus = new HookBus()
    for (let i = 0; i < 100; i++) {
      bus.on("turn_start", () => undefined)
    }
    // 100 < 128 — no throw.
    expect(true).toBe(true)
  })

  test("constructor option maxHandlers WINS over QUANTA knob", () => {
    process.env.QUANTA_HOOK_MAX_HANDLERS = "10"
    __resetRuntimeConfig()
    const bus = new HookBus(undefined, { maxHandlers: 200 })
    for (let i = 0; i < 150; i++) {
      bus.on("turn_start", () => undefined)
    }
    expect(true).toBe(true)
  })

  test("a 1MB+1 payload is TRUNCATED (not thrown) — graceful degradation", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    let seen: { type: string; name: string; input: unknown } | undefined
    bus.on("pre_tool_use", (e) => {
      seen = { type: e.type, name: e.name, input: e.input }
      return undefined
    })
    const giantArg = "x".repeat(MAX_PAYLOAD_BYTES + 1)
    const result = await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { content: giantArg },
    })
    // Dispatch fired despite oversize — graceful, not thrown.
    expect(result.deny).toBeNull()
    expect(seen).toBeDefined()
    // Truncation warning was emitted with event kind + cap (NOT payload).
    const warn = lines.find((l) => l.includes("hook.payload.truncated"))
    expect(warn).toBeDefined()
    expect(warn).not.toContain(giantArg)
    // The content string the handler observed was truncated + marked.
    const inputAsRecord = seen?.input as { content?: string } | undefined
    expect(inputAsRecord?.content?.includes(PAYLOAD_TRUNCATE_MARKER)).toBe(true)
  })

  test("a payload UNDER the cap is forwarded byte-identical (zero-overhead path)", async () => {
    const bus = new HookBus()
    let seen: unknown
    bus.on("pre_tool_use", (e) => {
      seen = e.input
    })
    const smallInput = { content: "hi", flag: true, n: 42 }
    await bus.emit({ type: "pre_tool_use", name: "write", input: smallInput })
    // Reference-equality — NO clone for small payloads.
    expect(seen).toBe(smallInput)
  })

  test("truncatePayload helper preserves event type verbatim", () => {
    const giant = "x".repeat(2_000_000)
    const result = truncatePayload(
      { type: "pre_tool_use", name: "write", input: { content: giant } },
      MAX_PAYLOAD_BYTES,
    )
    expect(result.truncated).toBe(true)
    expect((result.payload as { type: string }).type).toBe("pre_tool_use")
  })

  test("payload truncation marker is stable + grep-detectable", () => {
    expect(PAYLOAD_TRUNCATE_MARKER).toBe("...[truncated@hookbus]")
    // Anchored, distinctive — no false positives from ordinary tool output.
    expect(PAYLOAD_TRUNCATE_MARKER.includes("hookbus")).toBe(true)
  })

  test("knob QUANTA_HOOK_MAX_PAYLOAD_BYTES controls the cap", async () => {
    process.env.QUANTA_HOOK_MAX_PAYLOAD_BYTES = "200"
    __resetRuntimeConfig()
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    bus.on("pre_tool_use", () => undefined)
    await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { content: "x".repeat(1000) },
    })
    expect(lines.some((l) => l.includes("hook.payload.truncated"))).toBe(true)
  })

  test("constructor maxPayloadBytes WINS over QUANTA knob", async () => {
    process.env.QUANTA_HOOK_MAX_PAYLOAD_BYTES = "10"
    __resetRuntimeConfig()
    const bus = new HookBus(undefined, { maxPayloadBytes: 1_000_000 })
    let seen: unknown
    bus.on("pre_tool_use", (e) => {
      seen = e.input
    })
    const input = { content: "x".repeat(100) }
    await bus.emit({ type: "pre_tool_use", name: "write", input })
    // 100 chars well under 1MB — no truncation.
    expect(seen).toBe(input)
  })

  test("truncation does NOT mutate the caller's payload (defensive copy)", async () => {
    const bus = new HookBus(undefined, { maxPayloadBytes: 200 })
    bus.on("pre_tool_use", () => undefined)
    const original = { content: "y".repeat(1000) }
    await bus.emit({ type: "pre_tool_use", name: "write", input: original })
    // Caller's object unchanged.
    expect(original.content.length).toBe(1000)
    expect(original.content.includes(PAYLOAD_TRUNCATE_MARKER)).toBe(false)
  })

  test("circular-reference payload is replaced with a marker (never throws)", async () => {
    const bus = new HookBus()
    bus.on("post_tool_use", () => undefined)
    type Circ = {
      type: string
      name: string
      input: unknown
      ok: boolean
      output: string
      self?: unknown
    }
    const circ: Circ = {
      type: "post_tool_use",
      name: "x",
      input: {},
      ok: true,
      output: "y",
    }
    circ.self = circ
    // Must not throw, must complete.
    const result = await bus.emit(circ as unknown as Parameters<typeof bus.emit>[0])
    expect(result.deny).toBeNull()
  })
})

describe("S5 hook hardening — backward compat", () => {
  test("a legacy handler (no options) still works", async () => {
    const bus = new HookBus()
    let ran = false
    bus.on("session_start", () => {
      ran = true
    })
    const result = await bus.emit({ type: "session_start", sessionId: "s1" })
    expect(ran).toBe(true)
    expect(result.deny).toBeNull()
    // Legacy result shape — NO new fields when no override fired.
    expect(result.timeoutCount).toBeUndefined()
    expect(result.updatedPrompt).toBeUndefined()
  })

  test("no handlers ⇒ zero-overhead path (no truncation, no logger call)", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    const result = await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { content: "x".repeat(MAX_PAYLOAD_BYTES * 2) },
    })
    // Zero handlers ⇒ no truncation cost paid, no warning emitted.
    expect(lines.length).toBe(0)
    expect(result.deny).toBeNull()
  })
})
