import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { runBrowserFlow } from "@/auth/chatgpt-oauth/browser-flow"
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

const assertRebind = async (port: number): Promise<void> => {
  const deadline = Date.now() + 2000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const handle = await createCliOAuthCallback({ ports: [port] }).start({
        expectedState: "second-login",
      })
      handle.close()
      await handle.received.catch(() => undefined)
      return
    } catch (e) {
      last = e
      await Bun.sleep(25)
    }
  }
  throw last instanceof Error ? last : new Error("second login could not bind loopback")
}

describe("F-08 real loopback rebind after each terminal path", () => {
  test("timeout then second start binds the same port", async () => {
    const port = await freePort()
    const err = await runBrowserFlow({
      cfg,
      opener: () => {},
      timeoutMs: 50,
      callbackProvider: createCliOAuthCallback({ ports: [port] }),
    }).catch((e: Error) => e)
    expect(err).toMatchObject({ name: "BrowserFlowError", reason: "timeout" })
    await assertRebind(port)
  })

  test("open throw then second start binds the same port", async () => {
    const port = await freePort()
    await runBrowserFlow({
      cfg,
      opener: () => {
        throw new Error("open failed")
      },
      callbackProvider: createCliOAuthCallback({ ports: [port] }),
    }).catch(() => undefined)
    await assertRebind(port)
  })
})
