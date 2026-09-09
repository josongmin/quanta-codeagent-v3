import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { BrowserFlowError, runBrowserFlow } from "@/auth/chatgpt-oauth/browser-flow"
import { createCliOAuthCallback } from "@/auth/chatgpt-oauth/cli-callback"
import type { OAuthConfig } from "@/auth/chatgpt-oauth/config"

const cfg: OAuthConfig = {
  issuer: "https://auth.example.test",
  clientId: "client_xyz",
  apiBase: "https://api.example.test",
  sku: "QUANTA",
  originator: "quanta-test",
}

const freePort = async (): Promise<number> => {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => resolve())
  })
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    probe.close((err) => (err ? reject(err) : resolve()))
  })
  return port
}

const startOn = (port: number, state = "s1") =>
  createCliOAuthCallback({ ports: [port] }).start({ expectedState: state })

const rebind = async (port: number): Promise<void> => {
  const deadline = Date.now() + 2000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const handle = await startOn(port, `rebind-${Date.now()}`)
      handle.close()
      await handle.received.catch(() => undefined)
      return
    } catch (e) {
      last = e
      await Bun.sleep(20)
    }
  }
  throw last instanceof Error ? last : new Error("loopback port did not rebind")
}

describe("F-08 OAuth callback close", () => {
  test("close is idempotent and releases the loopback port", async () => {
    const port = await freePort()
    const handle = await startOn(port)
    handle.close()
    handle.close()
    await handle.received.catch((e: Error) => {
      expect(e).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
    })
    await rebind(port)
  })

  test("success callback then close allows a second login bind", async () => {
    const port = await freePort()
    const handle = await startOn(port, "ok-state")
    const url = new URL(handle.redirectUri)
    url.searchParams.set("code", "auth-code")
    url.searchParams.set("state", "ok-state")
    const received = handle.received
    const res = await fetch(url)
    expect(res.ok).toBe(true)
    await expect(received).resolves.toEqual({ code: "auth-code" })
    handle.close()
    await rebind(port)
  })

  test("timeout path closes the listener so the port rebinds", async () => {
    const port = await freePort()
    const result = await runBrowserFlow({
      cfg,
      opener: () => {},
      timeoutMs: 40,
      callbackProvider: createCliOAuthCallback({ ports: [port] }),
    }).catch((e: Error) => e)
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "timeout" })
    await rebind(port)
  })

  test("opener throw closes the listener so the port rebinds", async () => {
    const port = await freePort()
    const result = await runBrowserFlow({
      cfg,
      opener: () => {
        throw new Error("browser missing")
      },
      timeoutMs: 2000,
      callbackProvider: createCliOAuthCallback({ ports: [port] }),
    }).catch((e: Error) => e)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain("browser missing")
    await rebind(port)
  })

  test("abort inside opener closes without waiting for timeout", async () => {
    const port = await freePort()
    const ac = new AbortController()
    const started = Date.now()
    const result = await runBrowserFlow({
      cfg,
      opener: () => {
        ac.abort()
      },
      timeoutMs: 8_000,
      signal: ac.signal,
      callbackProvider: createCliOAuthCallback({ ports: [port] }),
    }).catch((e: Error) => e)
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
    expect(Date.now() - started).toBeLessThan(2000)
    await rebind(port)
  })

  test("caller abort closes the listener so the port rebinds", async () => {
    const port = await freePort()
    const ac = new AbortController()
    const flow = runBrowserFlow({
      cfg,
      opener: () => {},
      timeoutMs: 10_000,
      signal: ac.signal,
      callbackProvider: createCliOAuthCallback({ ports: [port] }),
    }).catch((e: Error) => e)
    await Bun.sleep(20)
    ac.abort()
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
    await rebind(port)
  })

  test("close-vs-callback race does not leak the port or unhandled rejection", async () => {
    const port = await freePort()
    const handle = await startOn(port, "race")
    const url = new URL(handle.redirectUri)
    url.searchParams.set("code", "c")
    url.searchParams.set("state", "race")
    const received = handle.received.catch((e: Error) => e)
    const fetchP = fetch(url).catch(() => undefined)
    handle.close()
    await Promise.all([received, fetchP])
    expect(await received).toBeTruthy()
    await rebind(port)
  })
})

describe("F-08 close-vs-callback BrowserFlowError", () => {
  test("close before callback rejects received as user_cancel", async () => {
    const port = await freePort()
    const handle = await startOn(port)
    handle.close()
    await expect(handle.received).rejects.toBeInstanceOf(BrowserFlowError)
    await rebind(port)
  })
})
