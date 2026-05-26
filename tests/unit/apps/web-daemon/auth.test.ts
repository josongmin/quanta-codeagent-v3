import { afterEach, describe, expect, test } from "bun:test"
import { main } from "@/apps/web-daemon"
import {
  _constantTimeEqualsForTest as constantTimeEquals,
  _extractTokenForTest as extractToken,
} from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { createStubRuntimeFactory } from "./fixture"

const cleanup: WebDaemonHandle[] = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const handle = cleanup.pop()
    if (handle !== undefined) await handle.stop().catch(() => undefined)
  }
})

const boot = async (
  overrides: { authToken?: string | undefined } = {},
): Promise<WebDaemonHandle> => {
  const { factory } = createStubRuntimeFactory()
  const handle = await main({
    port: 0,
    bind: "127.0.0.1",
    runtimeFactory: factory,
    authToken: overrides.authToken,
  })
  cleanup.push(handle)
  return handle
}

describe("constantTimeEquals", () => {
  test("equal strings of same length return true", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true)
  })

  test("different strings of same length return false", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false)
  })

  test("strings of different lengths return false (length oracle is mandatory)", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false)
    expect(constantTimeEquals("", "x")).toBe(false)
  })

  test("two empty strings are equal", () => {
    expect(constantTimeEquals("", "")).toBe(true)
  })
})

describe("extractToken", () => {
  test("Bearer header is decoded", () => {
    const url = new URL("ws://h/")
    expect(extractToken(url, "Bearer secret-token")).toBe("secret-token")
  })

  test("Bearer case-insensitive match (header key is HTTP-case-insensitive)", () => {
    const url = new URL("ws://h/")
    expect(extractToken(url, "bearer secret-token")).toBe("secret-token")
  })

  test("?token= query falls back when header is absent", () => {
    const url = new URL("ws://h/?token=q-token")
    expect(extractToken(url, null)).toBe("q-token")
  })

  test("Bearer header takes precedence over query token", () => {
    const url = new URL("ws://h/?token=q-token")
    expect(extractToken(url, "Bearer h-token")).toBe("h-token")
  })

  test("missing token (no header, no query) returns undefined", () => {
    const url = new URL("ws://h/")
    expect(extractToken(url, null)).toBeUndefined()
  })

  test("empty token rejected (Bearer with whitespace-only)", () => {
    const url = new URL("ws://h/")
    expect(extractToken(url, "Bearer   ")).toBeUndefined()
  })
})

describe("daemon auth gate (HTTP upgrade path)", () => {
  test("with no token configured, /health responds 200 (no auth required for health)", async () => {
    const handle = await boot()
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; sessions: number; uptime_ms: number }
    expect(body.status).toBe("ok")
    expect(body.sessions).toBe(0)
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
  })

  test("with token configured, upgrade WITHOUT token returns 401", async () => {
    const handle = await boot({ authToken: "secret-token" })
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    })
    expect(res.status).toBe(401)
  })

  test("with token configured, upgrade with WRONG token returns 401", async () => {
    const handle = await boot({ authToken: "secret-token" })
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        authorization: "Bearer wrong-token",
      },
    })
    expect(res.status).toBe(401)
  })

  test("with token configured, /health is still publicly accessible (intentional — no secrets exposed)", async () => {
    const handle = await boot({ authToken: "secret-token" })
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(res.status).toBe(200)
  })

  test("unknown HTTP path returns 404", async () => {
    const handle = await boot()
    const res = await fetch(`http://127.0.0.1:${handle.port}/no-such-path`)
    expect(res.status).toBe(404)
  })
})
