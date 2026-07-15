/** P0 loopback egress proxy I/O rail.
 *
 * Drives real loopback sockets but injects the physical dial/peer seams, so no
 * external DNS or network is involved. This pins three fail-closed boundaries:
 * denied CONNECT, malformed forward-proxy HTTP, and a post-dial rebind peer.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { createServer, get as httpGet, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createServer as createNetServer, connect as netConnect } from "node:net"
import { type DialTarget, LoopbackEgressProxy, type ResolvePeerHost } from "@/runtime/network-proxy"

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))

const socketRequest = (port: number, wire: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(wire))
    let response = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      response += chunk
    })
    socket.on("end", () => resolve(response))
    socket.on("error", reject)
  })

const proxyHttpStatus = (port: number, target: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: target }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode ?? 0))
    })
    req.on("error", reject)
  })

describe("P0 loopback proxy unit I/O", () => {
  let proxy: LoopbackEgressProxy | undefined
  let origin: Server | undefined

  afterEach(async () => {
    if (proxy !== undefined) await proxy.close()
    if (origin !== undefined) await closeServer(origin)
    proxy = undefined
    origin = undefined
  })

  test("CONNECT to an SSRF-blocked authority is 403 even when allowlisted", async () => {
    proxy = new LoopbackEgressProxy({ enabled: true, allowlist: ["127.0.0.1"] })
    const address = await proxy.listen()

    const response = await socketRequest(
      address.port,
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
    )

    expect(response.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
    expect(proxy.decisionLog()).toHaveLength(1)
    expect(proxy.decisionLog()[0]?.decision).toBe("deny")
  })

  test("malformed forward-proxy HTTP target is fail-closed with 403", async () => {
    proxy = new LoopbackEgressProxy({ enabled: true, allowlist: ["allowed.test"] })
    const address = await proxy.listen()

    // Relative-form is valid to an origin server but invalid at a forward proxy:
    // no absolute target means the proxy has no host to authorize.
    const response = await socketRequest(
      address.port,
      "GET /not-an-absolute-target HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n",
    )

    expect(response.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
    expect(proxy.decisionLog()).toHaveLength(0)
  })

  test("injected DNS rebind peer is denied after an otherwise allowlisted request", async () => {
    let originRequests = 0
    origin = createServer((_req, res) => {
      originRequests++
      res.writeHead(200).end("unexpected upstream response")
    })
    await new Promise<void>((resolve) => origin?.listen(0, "127.0.0.1", resolve))
    const originPort = (origin.address() as AddressInfo).port
    const dial: DialTarget = () => ({ host: "127.0.0.1", port: originPort })
    const rebindPeer: ResolvePeerHost = () => "169.254.169.254"
    proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      { dial, resolvePeerHost: rebindPeer },
    )
    const address = await proxy.listen()

    expect(await proxyHttpStatus(address.port, "http://allowed.test/health")).toBe(403)
    expect(proxy.decisionLog()[0]?.decision).toBe("allow")
    // The peer re-check occurs after TCP connect but BEFORE request bytes are
    // written, so the rebinding target observes no HTTP request at all.
    expect(originRequests).toBe(0)
  })

  test("raw CONNECT to a rebinding peer is 403 before tunneled bytes reach the upstream", async () => {
    let upstreamBytes = 0
    const rawOrigin = createNetServer((socket) => {
      socket.on("data", (chunk) => {
        upstreamBytes += chunk.length
      })
    })
    await new Promise<void>((resolve) => rawOrigin.listen(0, "127.0.0.1", resolve))
    const originPort = (rawOrigin.address() as AddressInfo).port
    const dial: DialTarget = () => ({ host: "127.0.0.1", port: originPort })
    const rebindPeer: ResolvePeerHost = () => "169.254.169.254"
    proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      { dial, resolvePeerHost: rebindPeer },
    )
    const address = await proxy.listen()
    try {
      const response = await socketRequest(
        address.port,
        "CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\nPOST /leak",
      )
      expect(response.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
      expect(upstreamBytes).toBe(0)
    } finally {
      await new Promise<void>((resolve) => rawOrigin.close(() => resolve()))
    }
  })
})
