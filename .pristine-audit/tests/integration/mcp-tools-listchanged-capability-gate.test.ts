/**
 * RFC04-1 — negotiated `tools.listChanged` observer parity (front-door).
 *
 * Drives the REAL `McpClient` transport + inbound router against two stdio fake
 * servers. Server A advertises `capabilities.tools.listChanged: true` and emits
 * an unsolicited `notifications/tools/list_changed`; server B advertises
 * `capabilities.tools: {}` (NO listChanged) and emits the SAME notification. A
 * capturing observer records the delivered invalidation signals.
 *
 * Contract: the signal is delivered ONLY for the capability-advertising server
 * (A). A non-negotiating server (B) cannot trigger a reload by spamming the
 * notification — it is dropped BEFORE reaching the observer.
 *
 * Red-on-injection: remove the capability gate in `client.ts`
 * (`gatedResourceObserver`) and server B's notification reaches the observer,
 * flipping the "not delivered" assertion RED.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpClient } from "@/mcp"
import type { McpResourceNotification } from "@/mcp/resources"

/** Fake server that, after `initialize`, immediately pushes ONE unsolicited
 *  `notifications/tools/list_changed`. `capsToolsBody` is spliced into the
 *  advertised `capabilities.tools` slot so we can toggle `listChanged`. */
const serverSrc = (capsToolsBody: string): string => `
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
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
        capabilities: { tools: ${capsToolsBody} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // The client sends this AFTER it has captured the negotiated
      // capabilities from the initialize response. Emitting the unsolicited
      // tools/list_changed here guarantees the capability record is populated
      // before the notification is routed — the gate reads a settled slot, not
      // a mid-handshake race.
      reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "alpha" }] } })
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`

let dir: string
let advPath: string
let plainPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-rfc04-1-"))
  advPath = join(dir, "adv-server.mjs")
  plainPath = join(dir, "plain-server.mjs")
  await writeFile(advPath, serverSrc("{ listChanged: true }"))
  await writeFile(plainPath, serverSrc("{}"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Spawn a client with a capturing observer; start, wait for the post-init
 *  notification to pump, then stop. Returns the delivered signal kinds. */
const runAndCollect = async (serverPath: string): Promise<McpResourceNotification["kind"][]> => {
  const seen: McpResourceNotification["kind"][] = []
  const client = new McpClient(
    { name: "mock", command: [process.execPath, serverPath] },
    { resourceObserver: { onNotification: (e) => seen.push(e.kind) } },
  )
  await client.start()
  // The notification is pushed synchronously after the initialize reply; give
  // the transport message pump a couple of macrotask turns to route it.
  await new Promise((r) => setTimeout(r, 40))
  await client.stop()
  return seen
}

describe("RFC04-1 tools/list_changed capability gate (real transport)", () => {
  it("DELIVERS the signal when the server advertised tools.listChanged", async () => {
    const seen = await runAndCollect(advPath)
    expect(seen).toContain("tools_list_changed")
  })

  it("DROPS the signal when the server did NOT advertise tools.listChanged", async () => {
    const seen = await runAndCollect(plainPath)
    // A non-negotiating server cannot trigger a reload by emitting the
    // notification: the capability gate drops it before the observer.
    expect(seen).not.toContain("tools_list_changed")
  })

  it("capability predicate reflects the negotiated slot", async () => {
    const adv = new McpClient(
      { name: "adv", command: [process.execPath, advPath] },
      { resourceObserver: { onNotification: () => {} } },
    )
    const plain = new McpClient(
      { name: "plain", command: [process.execPath, plainPath] },
      { resourceObserver: { onNotification: () => {} } },
    )
    // Before start ⇒ fail-closed false for both.
    expect(adv.serverSupportsToolsListChanged()).toBe(false)
    expect(plain.serverSupportsToolsListChanged()).toBe(false)
    await adv.start()
    await plain.start()
    expect(adv.serverSupportsToolsListChanged()).toBe(true)
    expect(plain.serverSupportsToolsListChanged()).toBe(false)
    await adv.stop()
    await plain.stop()
  })
})
