import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

const networkEnvKeys = [
  "QUANTA_WEB_BIND",
  "QUANTA_WEB_AUTH_TOKEN",
  "QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD",
] as const
const originalNetworkEnv = Object.fromEntries(
  networkEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof networkEnvKeys)[number], string | undefined>

beforeEach(() => {
  for (const key of networkEnvKeys) delete process.env[key]
})

afterEach(async () => {
  while (cleanup.length > 0) {
    const handle = cleanup.pop()
    if (handle !== undefined) await handle.stop().catch(() => undefined)
  }
  for (const key of networkEnvKeys) {
    const value = originalNetworkEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
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

const attemptBoot = async (overrides: {
  readonly bind?: string
  readonly authToken?: string | undefined
}): Promise<{ readonly handle: WebDaemonHandle } | { readonly error: unknown }> => {
  const { factory } = createStubRuntimeFactory()
  try {
    const handle = await main({ port: 0, runtimeFactory: factory, ...overrides })
    cleanup.push(handle)
    return { handle }
  } catch (error) {
    return { error }
  }
}

const expectRejectedWildcard = async (bind: string, authToken?: string): Promise<void> => {
  const result = await attemptBoot({ bind, authToken })
  expect("error" in result).toBe(true)
  if (!("error" in result)) return
  expect(String(result.error)).toContain("wildcard bind requires QUANTA_WEB_AUTH_TOKEN")
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

describe("daemon bind/auth startup policy", () => {
  test("default startup binds loopback rather than an unauthenticated wildcard", async () => {
    const result = await attemptBoot({ authToken: undefined })
    if (!("handle" in result)) throw result.error
    expect(result.handle.hostname).toBe("127.0.0.1")
  })

  test("IPv4 wildcard without auth fails closed before startup", async () => {
    await expectRejectedWildcard("0.0.0.0")
  })

  test("IPv6 wildcard without auth fails closed before startup", async () => {
    await expectRejectedWildcard("::")
  })

  test("wildcard with an empty token is still unauthenticated and fails closed", async () => {
    await expectRejectedWildcard("0.0.0.0", "")
  })

  test("loopback remains available without auth", async () => {
    const result = await attemptBoot({ bind: "127.0.0.1", authToken: undefined })
    if (!("handle" in result)) throw result.error
    expect(result.handle.hostname).toBe("127.0.0.1")
  })

  test("wildcard remains available with a non-empty auth token", async () => {
    const result = await attemptBoot({ bind: "0.0.0.0", authToken: "lan-secret" })
    if (!("handle" in result)) throw result.error
    expect(result.handle.hostname).toBe("0.0.0.0")
  })

  test("wildcard remains available with an explicit strict acknowledgement", async () => {
    process.env.QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD = "1"
    const result = await attemptBoot({ bind: "0.0.0.0", authToken: undefined })
    if (!("handle" in result)) throw result.error
    expect(result.handle.hostname).toBe("0.0.0.0")
  })

  test("loose acknowledgement spelling does not authorize a wildcard", async () => {
    process.env.QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD = "true"
    await expectRejectedWildcard("0.0.0.0")
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
