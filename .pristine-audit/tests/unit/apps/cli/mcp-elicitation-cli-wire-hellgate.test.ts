/**
 * Track C — MCP interactive elicitation CLI WIRE hellgate.
 *
 * The `McpClient` already accepted an `elicitationPrompter` (defaulting to
 * `headlessRejecter`), and `ElicitationLeasePool` + `cliPrompter` existed — but
 * `loadMcpTools` constructed `new McpClient(config)` with NO prompter and the
 * CLI never built an interactive one, so every inbound `elicitation/create` was
 * auto-declined. This battery seals the new wire:
 *
 *   HELL-C-01  loadMcpTools forwards the per-server factory to the McpClient —
 *              an inbound elicitation reaches the injected prompter and the
 *              server gets `{action:"accept"}` carrying the operator's answer.
 *   HELL-C-02  absent factory ⇒ headlessRejecter default ⇒ inbound elicitation
 *              gets `{action:"decline"}` (byte-identical legacy; never dropped).
 *   HELL-C-03  the factory is invoked PER SERVER with `config.name` so the
 *              lease key is per-server.
 *   HELL-C-04  buildCliElicitationPrompterFactory: interactive io maps an
 *              `ask()` line → an `accept` elicitation result.
 *   HELL-C-05  non-interactive (non-TTY) ⇒ factory is `undefined` (so the
 *              caller passes nothing ⇒ headlessRejecter).
 *   HELL-C-06  per-server lease: two concurrent SAME-server SAME-title prompts
 *              coalesce to ONE underlying call; a different server does not.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCliElicitationPrompterFactory } from "@/../src/apps/cli/mcp-elicitation-prompter"
import type { ElicitationPrompterFactory } from "@/agent"
import { loadMcpTools } from "@/agent"
import {
  type CliPrompterIO,
  type ElicitationPrompter,
  type ElicitationResult,
  headlessRejecter,
} from "@/mcp"

/** Mock MCP server (newline-delimited JSON-RPC 2.0 over stdio). On `tools/list`
 *  it FIRST issues an inbound `elicitation/create` request (id 9001) asking for
 *  a single string property, THEN replies to the list. The server records the
 *  elicitation RESPONSE the client sends back by echoing it as a tool name so
 *  the test can read it off `tools/list` — but simpler: it just `tools/list`
 *  replies with a tool whose description is the stringified elicitation
 *  response it received. */
const MOCK_SERVER = `
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
let elicitResponse = null
let pendingListId = null
const maybeSendList = () => {
  if (pendingListId === null) return
  reply({ jsonrpc: "2.0", id: pendingListId, result: {
    tools: [{ name: "probe", description: JSON.stringify(elicitResponse),
      inputSchema: { type: "object" } }],
  } })
  pendingListId = null
}
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock", version: "0.0.1" },
        capabilities: { tools: {} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // no reply
    } else if (msg.method === "tools/list") {
      pendingListId = msg.id
      // ask the CLIENT for a value first
      reply({ jsonrpc: "2.0", id: 9001, method: "elicitation/create", params: {
        message: "secret token?",
        requestedSchema: { type: "object", properties: { token: { type: "string" } } },
      } })
    } else if (msg.id === 9001 && msg.result !== undefined) {
      // client's reply to our elicitation request
      elicitResponse = msg.result
      maybeSendList()
    } else if (msg.method !== undefined) {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`

let dir: string
let serverPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-elicit-wire-"))
  serverPath = join(dir, "mock-server.mjs")
  await writeFile(serverPath, MOCK_SERVER)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A prompter that always accepts a string with a fixed answer. */
const acceptingPrompter = (answer: string): ElicitationPrompter => {
  const ok = <T>(value: T): Promise<ElicitationResult<T>> => Promise.resolve({ ok: true, value })
  return {
    promptString: () => ok(answer),
    promptNumber: () => ok(0),
    promptInteger: () => ok(0),
    promptBoolean: () => ok(true),
    promptEnum: () => ok(answer),
    promptMultiEnum: () => ok([answer]),
    promptSingleEnum: () => ok(answer),
    promptUrl: () => ok(answer),
  }
}

describe("Track C wire — loadMcpTools forwards the elicitation prompter", () => {
  it("HELL-C-01 / HELL-C-03 inbound elicitation reaches the injected per-server prompter", async () => {
    const seenServerIds: string[] = []
    const factory: ElicitationPrompterFactory = (serverId) => {
      seenServerIds.push(serverId)
      return acceptingPrompter("hunter2")
    }
    const { tools, clients } = await loadMcpTools(
      [{ name: "mock", command: [process.execPath, serverPath] }],
      factory,
    )
    // HELL-C-03: factory invoked once, with the server's config.name.
    expect(seenServerIds).toEqual(["mock"])
    // HELL-C-01: the server received an `accept` carrying the prompter's answer.
    const probe = tools.find((t) => t.name.endsWith("__probe"))
    expect(probe).toBeDefined()
    expect(probe?.description).toBe(
      JSON.stringify({ action: "accept", content: { token: "hunter2" } }),
    )
    for (const c of clients) await c.stop()
  })

  it("HELL-C-02 no factory ⇒ headlessRejecter default ⇒ inbound elicitation declined", async () => {
    const { tools, clients } = await loadMcpTools([
      { name: "mock", command: [process.execPath, serverPath] },
    ])
    const probe = tools.find((t) => t.name.endsWith("__probe"))
    expect(probe).toBeDefined()
    // headlessRejecter returns `headless-denied` ⇒ router maps to `decline`.
    expect(probe?.description).toBe(JSON.stringify({ action: "decline" }))
    for (const c of clients) await c.stop()
  })
})

describe("Track C wire — buildCliElicitationPrompterFactory", () => {
  it("HELL-C-04 interactive io maps ask() line → accept result", async () => {
    const io: CliPrompterIO = {
      write: () => {},
      read: () => Promise.resolve("typed-answer"),
    }
    const factory = buildCliElicitationPrompterFactory({ io, interactive: true })
    expect(factory).toBeDefined()
    const prompter = factory?.("srv-a") as ElicitationPrompter
    const res = await prompter.promptString({ prompt: "name?" })
    expect(res).toEqual({ ok: true, value: "typed-answer" })
  })

  it("HELL-C-05 non-interactive ⇒ factory is undefined", () => {
    const factory = buildCliElicitationPrompterFactory({ interactive: false })
    expect(factory).toBeUndefined()
    // The headless default exists as the fallback the client uses when absent.
    expect(headlessRejecter).toBeDefined()
  })

  it("HELL-C-06 per-server lease: same server+title coalesces; different server does not", async () => {
    let calls = 0
    let release: (v: ElicitationResult<string>) => void = () => {}
    const gated = new Promise<ElicitationResult<string>>((r) => {
      release = r
    })
    const io: CliPrompterIO = { write: () => {}, read: () => Promise.resolve("x") }
    // Replace the inner prompter via a custom io is not enough to count calls,
    // so build a factory over a counting prompter through the public path: we
    // wrap a counting prompter in the SAME lease pool the factory uses by
    // exercising forContext indirectly — here we assert coalescing semantics
    // via the factory's per-server binding using a counting base prompter.
    const countingIo: CliPrompterIO = {
      write: () => {},
      read: () => {
        calls++
        return gated.then((r) => (r.ok ? r.value : "x"))
      },
    }
    void io
    const factory = buildCliElicitationPrompterFactory({ io: countingIo, interactive: true })
    expect(factory).toBeDefined()
    const a1 = factory?.("server-A") as ElicitationPrompter
    const a2 = factory?.("server-A") as ElicitationPrompter
    const b = factory?.("server-B") as ElicitationPrompter
    const req = { prompt: "same question", title: "T" }
    const p1 = a1.promptString(req)
    const p2 = a2.promptString(req) // same server + same title ⇒ coalesced
    const p3 = b.promptString(req) // different server ⇒ separate read
    // Two distinct underlying reads: one for server-A (coalesced p1+p2), one for server-B.
    expect(calls).toBe(2)
    release({ ok: true, value: "answer" })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toEqual({ ok: true, value: "answer" })
    expect(r2).toEqual({ ok: true, value: "answer" })
    expect(r3).toEqual({ ok: true, value: "answer" })
  })
})
