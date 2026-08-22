/** H19 roots + B1 supervised-reconnect LIVE wire — hellgate at the
 *  `@/agent/mcp-bridge` consumer boundary + the supervisor restart factory.
 *
 *  The composition root decides the advertise-iff-able inbound-capability bundle
 *  (`{ negotiator, handler?, rootsProvider? }`) and hands it DOWN to
 *  `loadMcpTools`. `mcp-bridge` is a PURE consumer — it never imports `@/host`;
 *  it only threads the bundle into every `McpClient` it constructs, on BOTH the
 *  single-client AND the supervised (auto-restart) path. This battery proves:
 *
 *   (A) roots knob ON + provider ⇒ the client ADVERTISES `roots` AND answers an
 *       inbound `roots/list` with the workspace root.
 *   (B) roots knob OFF (no provider) ⇒ NO `roots` advertised, BUT an inbound
 *       `roots/list` is STILL answered with an empty list (never `-32601`).
 *   (C) supervised path: after a simulated reconnect the NEW client STILL
 *       advertises sampling+roots AND handles `sampling/createMessage` (fake LLM)
 *       + `roots/list` — the bundle survives auto-restart.
 *   (D) default-OFF (both knobs unset / no bundle) ⇒ byte-identical:
 *       `defaultNegotiator` caps `{}`, headless sampling rejecter, empty roots.
 *
 *  The negotiator is built EXACTLY as the surface does (`pickMcpNegotiator` from
 *  the SAME flags that produce the ports — `buildSamplingWiring` /
 *  `buildRootsWiring`), so advertise + answering-port move together.
 */

import { describe, expect, it } from "bun:test"
import { applyMcpClientWiring, loadMcpTools, type SamplingWiringInput } from "@/agent/mcp-bridge"
import { buildRootsWiring, buildSamplingWiring, pickMcpNegotiator } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  DEFAULT_BACKOFF_POLICY,
  type ElicitationPrompter,
  McpClient,
  type McpServerConfig,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { MCP_ROOTS_LIST_METHOD } from "@/mcp/resources"
import { MCP_SAMPLING_METHOD } from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 64; i++) await Promise.resolve()
}

/** Scripted transport that captures sent payloads + lets the test emit inbound
 *  messages + drive an exit (for the supervised reconnect). */
class ScriptedTransport implements McpTransport {
  private messageHandler: ((msg: JsonRpcMessage) => void) | null = null
  private exitHandler: (() => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    this.sent.push(payload as Record<string, unknown>)
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandler = handler
    return () => {
      this.messageHandler = null
    }
  }
  onExit(handler: () => void): () => void {
    this.exitHandler = handler
    return () => {
      this.exitHandler = null
    }
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.messageHandler?.(msg)
  }
  exit(): void {
    this.exitHandler?.()
  }
}

const fakeLlm = (): { llm: LLMPort; calls: () => number } => {
  let n = 0
  return {
    calls: () => n,
    llm: {
      model: "fake-model",
      stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        n += 1
        return (async function* () {
          yield { type: "text_delta", delta: "4" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        })()
      },
    },
  }
}

const consentOf = (answer: boolean): ElicitationPrompter => {
  const reject = async (): Promise<never> => {
    throw new Error("only promptBoolean")
  }
  return {
    promptBoolean: async () => ({ ok: true, value: answer }),
    promptString: reject,
    promptNumber: reject,
    promptInteger: reject,
    promptEnum: reject,
    promptMultiEnum: reject,
    promptSingleEnum: reject,
    promptUrl: reject,
  }
}

const CAPS_FULL = { QUANTA_MCP_CAPS: "full" } as NodeJS.ProcessEnv
const CONFIG: McpServerConfig = { name: "s1", command: ["x"] }
const CWD = "/work/space"
const sampleParams = {
  messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
  systemPrompt: "calc",
  maxTokens: 16,
}

/** Build the unified bundle EXACTLY as the surface would: ONE negotiator from the
 *  SAME flags that produce the ports. `undefined` when neither is advertised. */
const bundleOf = (args: {
  sampling?: { llm: LLMPort; consent: ElicitationPrompter }
  roots?: boolean
  env?: NodeJS.ProcessEnv
}): SamplingWiringInput | undefined => {
  const env = args.env ?? CAPS_FULL
  const sampling = buildSamplingWiring(args.sampling !== undefined, args.sampling)
  const roots = buildRootsWiring(args.roots === true, CWD)
  const negotiator = pickMcpNegotiator(env, {
    ...(sampling.advertise ? { sampling: true } : {}),
    ...(roots.advertise ? { roots: true } : {}),
  })
  const compiled = negotiator.compile()
  const handler =
    sampling.advertise && sampling.handler !== undefined && compiled.sampling !== undefined
      ? sampling.handler
      : undefined
  const provider =
    roots.advertise && roots.provider !== undefined && compiled.roots !== undefined
      ? roots.provider
      : undefined
  if (handler === undefined && provider === undefined) return undefined
  return {
    negotiator,
    ...(handler !== undefined ? { handler } : {}),
    ...(provider !== undefined ? { rootsProvider: provider } : {}),
  }
}

/** Drive the single-client `loadMcpTools` with a scripted transport + the
 *  optional bundle; complete the handshake; return the live transport. */
const loadSingle = async (
  transport: ScriptedTransport,
  bundle: SamplingWiringInput | undefined,
): Promise<{ stop: () => Promise<void> }> => {
  const loadP = loadMcpTools([CONFIG], undefined, {
    transportFor: () => transport,
    ...(bundle !== undefined ? { samplingWiring: bundle } : {}),
  })
  await flush()
  const init = transport.sent.find((m) => m.method === "initialize") as { id: number } | undefined
  if (init !== undefined) transport.emit({ jsonrpc: "2.0", id: init.id, result: {} })
  await flush()
  const list = transport.sent.find((m) => m.method === "tools/list") as { id: number } | undefined
  if (list !== undefined) transport.emit({ jsonrpc: "2.0", id: list.id, result: { tools: [] } })
  const { clients } = await loadP
  return { stop: async () => Promise.all(clients.map((c) => c.stop())).then(() => undefined) }
}

const initCaps = (t: ScriptedTransport): Record<string, unknown> => {
  const init = t.sent.find((m) => m.method === "initialize") as {
    params: { capabilities: Record<string, unknown> }
  }
  return init.params.capabilities
}

const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

describe("H19 roots LIVE wire — single-client path", () => {
  it("(A) roots knob ON + provider ⇒ advertises roots + answers roots/list with the workspace root", async () => {
    const transport = new ScriptedTransport()
    const bundle = bundleOf({ roots: true })
    const { stop } = await loadSingle(transport, bundle)

    // Advertise-iff-provider: the client advertised `roots`.
    expect(initCaps(transport).roots).toEqual({ listChanged: false })

    transport.emit({ jsonrpc: "2.0", id: 7, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.id).toBe(7)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({
      roots: [
        { uri: `file://${CWD.split("/").map(encodeURIComponent).join("/")}`, name: "workspace" },
      ],
    })
    await stop()
  })

  it("(B) roots knob OFF ⇒ NO roots advertised, BUT roots/list still answered empty (never -32601)", async () => {
    const transport = new ScriptedTransport()
    const bundle = bundleOf({ roots: false })
    // No sampling either ⇒ the whole bundle is omitted (byte-identical default).
    expect(bundle).toBeUndefined()
    const { stop } = await loadSingle(transport, bundle)

    expect("roots" in initCaps(transport)).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 8, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.id).toBe(8)
    // Recognized method ⇒ empty result, NOT a -32601 error.
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({ roots: [] })
    await stop()
  })
})

describe("H19/B1 default-OFF — byte-identical negotiation (no bundle)", () => {
  it("(D) both knobs unset / no bundle ⇒ defaultNegotiator caps {} + headless sampling rejecter + empty roots", async () => {
    const transport = new ScriptedTransport()
    // No bundle AT ALL (the load opt is omitted), env has no QUANTA_MCP_CAPS.
    const { stop } = await loadSingle(transport, undefined)

    // defaultNegotiator ⇒ capabilities is exactly `{}`.
    expect(initCaps(transport)).toEqual({})

    // sampling ⇒ headless rejecter declines (no-handler), NOT -32601.
    transport.emit({ jsonrpc: "2.0", id: 1, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()
    const sErr = lastSend(transport).error as { code: number; message: string }
    expect(sErr.message).toContain("no-handler")

    // roots ⇒ empty list, never -32601.
    transport.emit({ jsonrpc: "2.0", id: 2, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const rReply = lastSend(transport)
    expect(rReply.error).toBeUndefined()
    expect(rReply.result).toEqual({ roots: [] })
    await stop()
  })
})

// --- supervised reconnect ----------------------------------------------------

interface FakeClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => () => void
  advance: (ms: number) => void
}
const makeClock = (): FakeClock => {
  let now = 0
  let seq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const e = { at: now + ms, seq: seq++, fn }
      timers.push(e)
      return () => {
        const i = timers.indexOf(e)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance: (ms) => {
      now += ms
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = due[0]
        if (next === undefined) break
        timers.splice(timers.indexOf(next), 1)
        next.fn()
      }
    },
  }
}

/** Build supervisor deps whose restart factory BAKES the wiring bundle in via the
 *  SAME `applyMcpClientWiring` helper the surface uses — mirroring
 *  `internal.ts#mcpSupervisorDepsFor`. Each restart yields a fresh scripted
 *  transport (from the queue) so the test can complete each handshake and
 *  inspect the NEW client's advertisement + inbound handling. */
const supervisorDepsWithWiring = (
  clock: FakeClock,
  transports: ScriptedTransport[],
  bundle: SamplingWiringInput | undefined,
): SupervisorDeps => {
  let idx = 0
  return {
    factory: (c): SupervisableMcpClient => {
      const transport = transports[idx++]
      if (transport === undefined) throw new Error("ran out of scripted transports")
      const opts: NonNullable<ConstructorParameters<typeof McpClient>[1]> = { transport }
      applyMcpClientWiring(opts, bundle)
      return new McpClient(c, opts)
    },
    policy: DEFAULT_BACKOFF_POLICY,
    now: clock.now,
    setTimer: clock.setTimer,
    random: () => 0, // deterministic backoff (no real RNG)
  }
}

/** Complete an `initialize` + `tools/list` handshake on `t`. Polls because
 *  `tools/list` is only sent AFTER `initialize` resolves, so answering both in
 *  one synchronous pass would miss the (not-yet-sent) `tools/list`. */
const handshake = async (t: ScriptedTransport): Promise<void> => {
  const waitFor = async (method: string): Promise<{ id: number } | undefined> => {
    for (let i = 0; i < 64; i++) {
      const m = t.sent.find((s) => s.method === method) as { id: number } | undefined
      if (m !== undefined) return m
      await flush()
    }
    return undefined
  }
  const init = await waitFor("initialize")
  if (init !== undefined) t.emit({ jsonrpc: "2.0", id: init.id, result: {} })
  const list = await waitFor("tools/list")
  if (list !== undefined) t.emit({ jsonrpc: "2.0", id: list.id, result: { tools: [] } })
}

describe("B1+H19 supervised reconnect — bundle survives auto-restart", () => {
  it("(C) after a reconnect the NEW client STILL advertises sampling+roots + handles createMessage + roots/list", async () => {
    const clock = makeClock()
    const t0 = new ScriptedTransport()
    const t1 = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const bundle = bundleOf({ sampling: { llm, consent: consentOf(true) }, roots: true })
    expect(bundle).toBeDefined()

    const loadP = loadMcpTools([CONFIG], undefined, {
      supervisorDepsFor: () => supervisorDepsWithWiring(clock, [t0, t1], bundle),
    })
    await handshake(t0)
    const { clients } = await loadP

    // First client advertised BOTH inbound capabilities.
    expect(initCaps(t0).sampling).toEqual({})
    expect(initCaps(t0).roots).toEqual({ listChanged: false })

    // --- simulate a crash + auto-restart onto t1 ---
    t0.exit()
    await flush()
    clock.advance(60_000) // fire the backoff timer ⇒ attemptRestart builds t1
    await flush()
    await handshake(t1)
    await flush()

    // The RE-connected client (t1) re-advertised sampling + roots.
    expect(initCaps(t1).sampling).toEqual({})
    expect(initCaps(t1).roots).toEqual({ listChanged: false })

    // ...and re-handles inbound requests against the NEW client.
    t1.emit({ jsonrpc: "2.0", id: 99, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()
    expect(calls()).toBe(1)
    const sReply = lastSend(t1)
    expect(sReply.id).toBe(99)
    expect(sReply.result).toEqual({
      role: "assistant",
      content: { type: "text", text: "4" },
      model: "fake-model",
      stopReason: "end_turn",
    })

    t1.emit({ jsonrpc: "2.0", id: 100, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const rReply = lastSend(t1)
    expect(rReply.id).toBe(100)
    expect((rReply.result as { roots: unknown[] }).roots).toHaveLength(1)

    await Promise.all(clients.map((c) => c.stop()))
  })
})
