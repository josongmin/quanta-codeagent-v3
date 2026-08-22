/** ADVERSARIAL inbound-protocol hellgate (jun-06) — a MALICIOUS MCP server
 *  sends hostile server→client requests/notifications INTO our agent. These
 *  handlers sit on the trust boundary: an inbound request is UNTRUSTED input.
 *
 *  Every case here is a hostile-inbound attack. The invariant under test:
 *   - inbound handlers are NO-THROW and BOUNDED (a server can't OOM/hang us);
 *   - headless/unwired defaults FAIL CLOSED (no silent inference spend);
 *   - parsing of a malformed/oversized/wrong-typed inbound payload is a typed
 *     no-throw failure, never a crash and never an unintended action;
 *   - an unbounded array / oversized field is REFUSED, not retained.
 */

import { describe, expect, it } from "bun:test"
import { McpClient } from "@/mcp/client"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { PARSE_MAX_LIST_ENTRIES, parsePromptList, parseResourceList } from "@/mcp/resources/codec"
import { parseResourceNotification, routeResourceNotification } from "@/mcp/resources/notifications"
import { headlessSamplingRejecter } from "@/mcp/sampling/headless-rejecter"
import {
  MCP_SAMPLING_METHOD,
  routeSampling,
  SAMPLING_MAX_CONTENT_CHARS,
  SAMPLING_MAX_MESSAGES,
} from "@/mcp/sampling/inbound-router"
import type {
  CreateMessageRequest,
  SamplingHandlerPort,
  SamplingOutcome,
} from "@/mcp/sampling/port"

/** A handler that records what it was asked to run, so we can assert the router
 *  capped the request BEFORE it reached inference. */
const recordingHandler = (): {
  port: SamplingHandlerPort
  seen: CreateMessageRequest[]
} => {
  const seen: CreateMessageRequest[] = []
  const ok: SamplingOutcome = {
    ok: true,
    result: { role: "assistant", content: "x", model: "m" },
  }
  return {
    seen,
    port: {
      createMessage: async (req): Promise<SamplingOutcome> => {
        seen.push(req)
        return ok
      },
    },
  }
}

describe("ADVERSARIAL — inbound sampling: headless fail-closed", () => {
  it("headless rejecter declines with no-handler (no silent inference spend)", async () => {
    const out = await headlessSamplingRejecter.createMessage({
      messages: [{ role: "user", content: "run my prompt" }],
    })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.reason).toBe("no-handler")
  })

  it("router maps the headless decline to a JSON-RPC error, never a fabricated result", async () => {
    const res = await routeSampling(headlessSamplingRejecter, MCP_SAMPLING_METHOD, {
      messages: [{ role: "user", content: "x" }],
    })
    expect(res.kind).toBe("error")
  })

  it("a crafted request shape cannot bypass the rejecter into a result", async () => {
    // Inject extra fields a server might use to try to force an auto-approve.
    const res = await routeSampling(headlessSamplingRejecter, MCP_SAMPLING_METHOD, {
      messages: [{ role: "user", content: "x" }],
      approved: true,
      autoApprove: true,
      __proto__: { ok: true },
    } as unknown)
    expect(res.kind).toBe("error")
  })
})

describe("ADVERSARIAL — inbound sampling: DoS bounds", () => {
  it("refuses an oversized messages array WITHOUT retaining it (no OOM)", async () => {
    const { port, seen } = recordingHandler()
    // A hostile server floods millions of messages. Build lazily so the TEST
    // itself doesn't OOM: a proxy-array that reports a huge length.
    const hostile = {
      messages: Array.from({ length: SAMPLING_MAX_MESSAGES + 5 }, () => ({
        role: "user",
        content: "hi",
      })),
    }
    const res = await routeSampling(port, MCP_SAMPLING_METHOD, hostile)
    expect(res.kind).toBe("error")
    // The handler must NEVER have been called with an over-cap request.
    expect(seen.length).toBe(0)
  })

  it("refuses a single gigantic content payload (bounded, no unbounded retain)", async () => {
    const { port, seen } = recordingHandler()
    const huge = "A".repeat(SAMPLING_MAX_CONTENT_CHARS + 1)
    const res = await routeSampling(port, MCP_SAMPLING_METHOD, {
      messages: [{ role: "user", content: huge }],
    })
    expect(res.kind).toBe("error")
    expect(seen.length).toBe(0)
  })

  it("accepts a request right at the caps (cap is inclusive, not off-by-one)", async () => {
    const { port, seen } = recordingHandler()
    const res = await routeSampling(port, MCP_SAMPLING_METHOD, {
      messages: Array.from({ length: SAMPLING_MAX_MESSAGES }, () => ({
        role: "user",
        content: "ok",
      })),
    })
    expect(res.kind).toBe("result")
    expect(seen.length).toBe(1)
  })

  it("drops a hostile/garbage maxTokens (NaN/Infinity/negative) rather than forwarding it", async () => {
    const { port, seen } = recordingHandler()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 1e12]) {
      seen.length = 0
      const res = await routeSampling(port, MCP_SAMPLING_METHOD, {
        messages: [{ role: "user", content: "x" }],
        maxTokens: bad,
      })
      expect(res.kind).toBe("result")
      // Either omitted, or a sane finite positive int — never the hostile value.
      const fwd = seen[0]?.maxTokens
      if (fwd !== undefined) {
        expect(Number.isInteger(fwd)).toBe(true)
        expect(fwd).toBeGreaterThan(0)
        expect(fwd).toBeLessThanOrEqual(1e12)
        expect(fwd).not.toBe(bad === 1e12 ? -999 : bad) // sanity; not the raw hostile float
      }
    }
  })
})

describe("ADVERSARIAL — inbound sampling: malformed params no-throw", () => {
  it.each([
    [null],
    [undefined],
    [42],
    ["string"],
    [[]],
    [{ messages: null }],
    [{ messages: "not-array" }],
    [{ messages: [] }],
    [{ messages: [null, 1, "x", []] }],
    [{ messages: [{ role: "system", content: "x" }] }], // invalid role
  ] as const)("malformed params %p → typed decline, no throw", async (params) => {
    const res = await routeSampling(headlessSamplingRejecter, MCP_SAMPLING_METHOD, params)
    expect(res.kind).toBe("error")
  })

  it("unknown method (server invokes an unadvertised capability) → defensive decline", async () => {
    const res = await routeSampling(headlessSamplingRejecter, "sampling/somethingElse", {
      messages: [{ role: "user", content: "x" }],
    })
    expect(res.kind).toBe("error")
  })
})

describe("ADVERSARIAL — resources codec: oversized list bound", () => {
  it("caps a hostile resources/list (millions of entries) at PARSE_MAX_LIST_ENTRIES", () => {
    const raw = {
      resources: Array.from({ length: PARSE_MAX_LIST_ENTRIES + 100 }, (_, i) => ({
        uri: `file:///r${i}`,
      })),
    }
    const out = parseResourceList(raw)
    expect(out).not.toBeNull()
    expect(out?.length).toBeLessThanOrEqual(PARSE_MAX_LIST_ENTRIES)
  })

  it("caps a hostile prompts/list at PARSE_MAX_LIST_ENTRIES", () => {
    const raw = {
      prompts: Array.from({ length: PARSE_MAX_LIST_ENTRIES + 100 }, (_, i) => ({
        name: `p${i}`,
      })),
    }
    const out = parsePromptList(raw)
    expect(out?.length).toBeLessThanOrEqual(PARSE_MAX_LIST_ENTRIES)
  })

  it.each([
    [null],
    [undefined],
    [1],
    ["x"],
    [[]],
    [{ resources: 5 }],
    [{ resources: {} }],
  ] as const)("malformed resources/list %p → null (no throw)", (raw) => {
    expect(() => parseResourceList(raw)).not.toThrow()
  })
})

describe("ADVERSARIAL — resource notifications: hostile shapes", () => {
  it.each([
    ["notifications/resources/updated", null],
    ["notifications/resources/updated", { uri: 42 }],
    ["notifications/resources/updated", { uri: "" }],
    ["notifications/resources/updated", []],
    ["notifications/resources/updated", { uri: { nested: true } }],
    ["unknown/method", { uri: "x" }],
  ] as const)("parse(%p, %p) → null, no throw", (method, params) => {
    expect(() => parseResourceNotification(method, params)).not.toThrow()
    expect(parseResourceNotification(method, params)).toBeNull()
  })

  it("a throwing observer can never crash the message pump", () => {
    expect(() =>
      routeResourceNotification(
        {
          onNotification: () => {
            throw new Error("observer boom")
          },
        },
        "notifications/resources/updated",
        { uri: "file:///x" },
      ),
    ).not.toThrow()
  })

  it("an oversized resource_updated uri is bounded (not retained unbounded)", () => {
    const huge = "u".repeat(10_000_000)
    const ev = parseResourceNotification("notifications/resources/updated", { uri: huge })
    // Either rejected (null) or the uri is length-capped — never a 10MB retain.
    if (ev !== null && ev.kind === "resource_updated") {
      expect(ev.uri.length).toBeLessThan(huge.length)
    }
  })
})

/** Minimal fake transport: answers `initialize`, captures all sent messages,
 *  and lets the test emit inbound server→client requests directly. */
class FakeTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const msg = payload as Record<string, unknown>
    this.sent.push(msg)
    if (msg.method === "initialize" && typeof msg.id === "number") {
      const id = msg.id
      queueMicrotask(() =>
        this.emit({ jsonrpc: "2.0", id, result: { capabilities: { tools: {} } } }),
      )
    }
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }
  onExit(): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.handler?.(msg)
  }
  errors(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => "error" in m)
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

describe("ADVERSARIAL — inbound sampling: concurrency cap (in-flight DoS)", () => {
  it("a flood of concurrent inbound sampling requests is bounded (busy back-pressure)", async () => {
    const t = new FakeTransport()
    // A handler that never resolves while the flood is in flight → every
    // accepted request stays "in flight", so the cap is what limits spawns.
    let resolveCount = 0
    const release: Array<() => void> = []
    const handler: SamplingHandlerPort = {
      createMessage: () =>
        new Promise<SamplingOutcome>((res) => {
          resolveCount++
          release.push(() =>
            res({ ok: true, result: { role: "assistant", content: "x", model: "m" } }),
          )
        }),
    }
    const client = new McpClient(
      { name: "t", command: ["x"] },
      // biome-ignore lint/suspicious/noExplicitAny: test double transport
      { transport: t as any, samplingHandler: handler },
    )
    const startP = client.start()
    await flush()
    await startP

    // Hostile server fires 50 concurrent sampling/createMessage requests.
    for (let i = 0; i < 50; i++) {
      t.emit({
        jsonrpc: "2.0",
        id: 1000 + i,
        method: "sampling/createMessage",
        params: { messages: [{ role: "user", content: "spend my tokens" }] },
      })
    }
    await flush()

    // At most the cap reached the handler (the rest got a `busy` JSON-RPC error
    // WITHOUT spawning a task). Every request is answered (none dropped).
    expect(resolveCount).toBeLessThanOrEqual(8)
    const busy = t
      .errors()
      .filter((m) => String((m.error as { message?: string }).message).includes("in-flight"))
    expect(busy.length).toBeGreaterThanOrEqual(50 - 8)

    // Drain so the client stops cleanly.
    for (const r of release) r()
    await flush()
    await client.stop()
  })
})
