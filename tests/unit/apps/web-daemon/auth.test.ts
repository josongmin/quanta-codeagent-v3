import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "@/apps/web-daemon"
import {
  _constantTimeEqualsForTest as constantTimeEquals,
  _extractTokenForTest as extractToken,
  _serveStaticSpaForTest as serveStaticSpa,
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

describe("static SPA serve (auth-gate: unknown paths are NOT silently served)", () => {
  // Regression: the static resolver previously blanket-fell-back to index.html
  // for ANY unknown path when a built dist was present, so `/no-such-path`,
  // `/admin`, etc. resolved to HTTP 200 — defeating the daemon's intent that
  // unknown HTTP paths are rejected. The fix serves only the SPA root and real
  // built assets; unknown paths return null ⇒ the caller emits 404.
  test("with a built dist present, an unknown path is rejected (null ⇒ 404)", () => {
    const distDir = mkdtempSync(join(tmpdir(), "quanta-web-dist-"))
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>app</title>")
    writeFileSync(join(distDir, "app.js"), "console.log('ok')")
    try {
      // SPA root and real assets still serve.
      expect(serveStaticSpa("/", distDir)?.status).toBe(200)
      expect(serveStaticSpa("/index.html", distDir)?.status).toBe(200)
      expect(serveStaticSpa("/app.js", distDir)?.status).toBe(200)
      // Unknown paths are NOT served via index.html fallback — they 404.
      expect(serveStaticSpa("/no-such-path", distDir)).toBeNull()
      expect(serveStaticSpa("/admin", distDir)).toBeNull()
      expect(serveStaticSpa("/missing.js", distDir)).toBeNull()
      // Path traversal stays rejected.
      expect(serveStaticSpa("/../etc/passwd", distDir)).toBeNull()
    } finally {
      rmSync(distDir, { recursive: true, force: true })
    }
  })

  test("no dist configured ⇒ resolver returns null for every path", () => {
    expect(serveStaticSpa("/", null)).toBeNull()
    expect(serveStaticSpa("/index.html", null)).toBeNull()
    expect(serveStaticSpa("/no-such-path", null)).toBeNull()
  })
})
