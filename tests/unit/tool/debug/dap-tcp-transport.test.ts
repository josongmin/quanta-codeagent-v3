/**
 * W5 DAP — TCP transport. Some debug adapters (Go's dlv-dap, vscode-js-debug)
 * speak DAP over a TCP SOCKET, not stdio. The TCP transport spawns/connects the
 * adapter and exposes the SAME DapTransport (send/onData/close) the stdio one
 * does, so DapClient + inspectViaDap work unchanged. Verified against a real
 * local net.Server speaking DAP frames (no external adapter needed).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { DapClient } from "@/tool/debug/dap-client"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"
import { connectTcpTransport, getFreePort } from "@/tool/debug/port"
import { present } from "../../../_helpers/expect-present"

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
})

/** A local TCP "DAP adapter": frames responses to requests. */
const startFakeDapServer = async (): Promise<number> => {
  const port = await getFreePort()
  server = createServer((socket) => {
    const dec = new DapFrameDecoder()
    socket.on("data", (chunk) => {
      for (const raw of dec.push(chunk)) {
        const req = raw as { seq: number; command: string }
        if (req.command === "initialize") {
          socket.write(
            encodeDapMessage({
              type: "response",
              request_seq: req.seq,
              success: true,
              command: "initialize",
              body: { supportsConfigurationDoneRequest: true },
            }),
          )
          socket.write(encodeDapMessage({ type: "event", event: "initialized" }))
        } else if (req.command === "threads") {
          socket.write(
            encodeDapMessage({
              type: "response",
              request_seq: req.seq,
              success: true,
              command: "threads",
              body: { threads: [{ id: 1, name: "main" }] },
            }),
          )
        }
      }
    })
  })
  await new Promise<void>((resolve) =>
    present(server, "fake DAP server").listen(port, "127.0.0.1", () => resolve()),
  )
  return port
}

describe("DAP TCP transport", () => {
  test("getFreePort returns a usable port number", async () => {
    const p = await getFreePort()
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(65536)
  })

  test("connectTcpTransport + DapClient: request/response over a real socket", async () => {
    const port = await startFakeDapServer()
    const transport = await connectTcpTransport({ host: "127.0.0.1", port, connectTimeoutMs: 3000 })
    const client = new DapClient(transport)
    const init = await client.request("initialize", { adapterID: "test" })
    expect(init.success).toBe(true)
    expect(init.body).toEqual({ supportsConfigurationDoneRequest: true })
    const threads = await client.request("threads")
    expect(threads.body).toEqual({ threads: [{ id: 1, name: "main" }] })
    client.dispose()
  })

  test("events arrive over the socket (initialized after initialize)", async () => {
    const port = await startFakeDapServer()
    const transport = await connectTcpTransport({ host: "127.0.0.1", port })
    const client = new DapClient(transport)
    const got = client.waitForEvent("initialized")
    await client.request("initialize", {})
    expect(
      await Promise.race([
        got.then(() => "init"),
        new Promise((r) => setTimeout(() => r("timeout"), 2000)),
      ]),
    ).toBe("init")
    client.dispose()
  })

  test("connect to a dead port rejects within the timeout (no hang)", async () => {
    const dead = await getFreePort() // free, nothing listening
    await expect(
      connectTcpTransport({ host: "127.0.0.1", port: dead, connectTimeoutMs: 1500 }),
    ).rejects.toThrow()
  })
})
