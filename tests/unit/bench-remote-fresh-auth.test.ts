import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refreshRemoteAuthJson } from "@/apps/bench/remote/fresh-auth"
import { chatgptTokenPath, hashRefreshLockKey } from "@/auth/chatgpt-oauth"
import { FileBasedLock } from "@/auth/lock-file-based"
import { createNodeLockFileStore } from "@/auth/node-lock-file-store"

const TEMP_DIRS = new Set<string>()

const tempAuthFile = (body: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), "bench-remote-fresh-auth-"))
  TEMP_DIRS.add(dir)
  const path = join(dir, "chatgpt.json")
  writeFileSync(path, `${JSON.stringify(body)}\n`)
  return path
}

afterEach(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
  TEMP_DIRS.clear()
})

describe("refreshRemoteAuthJson", () => {
  test("refreshes and persists the access token before remote ship", async () => {
    const path = tempAuthFile({
      access_token: "ACCESS-old",
      refresh_token: "REFRESH-local-only",
      expires_at: "2026-06-21T00:00:00.000Z",
      account_id: "acct-old",
    })
    const out = await refreshRemoteAuthJson(path, {
      env: {},
      nowMs: () => Date.parse("2026-06-21T00:00:00.000Z"),
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "ACCESS-new", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })

    const returned = JSON.parse(out) as Record<string, unknown>
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(returned.access_token).toBe("ACCESS-new")
    expect(returned.refresh_token).toBe("REFRESH-local-only")
    expect(persisted.access_token).toBe("ACCESS-new")
    expect(persisted.refresh_token).toBe("REFRESH-local-only")
    expect(persisted.expires_at).toBe("2026-06-21T01:00:00.000Z")
  })

  test("fails before provisioning when the refresh grant is revoked", async () => {
    const path = tempAuthFile({
      access_token: "ACCESS-old",
      refresh_token: "REFRESH-dead",
      expires_at: "2026-06-21T00:00:00.000Z",
    })

    await expect(
      refreshRemoteAuthJson(path, {
        env: {},
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(/token exchange failed: 401 invalid_grant/)

    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(persisted.access_token).toBe("ACCESS-old")
  })

  test("expired refresh acquires and releases the ChatGPT lock transaction", async () => {
    const path = tempAuthFile({
      access_token: "ACCESS-old",
      refresh_token: "REFRESH-local-only",
      expires_at: "2026-06-21T00:00:00.000Z",
    })
    let acquired = 0
    let released = 0
    const out = await refreshRemoteAuthJson(path, {
      env: {},
      nowMs: () => Date.parse("2026-06-21T00:00:00.000Z"),
      lock: {
        tryAcquire: async () => {
          acquired++
          return "acquired"
        },
        release: async () => {
          released++
        },
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "ACCESS-new", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    expect(acquired).toBe(1)
    expect(released).toBe(1)
    expect(JSON.parse(out).access_token).toBe("ACCESS-new")
  })

  test("lock acquire timeout is not the 1h remaining issuer fallback", async () => {
    const now = Date.parse("2026-06-21T00:00:00.000Z")
    const path = tempAuthFile({
      access_token: "ACCESS-live",
      refresh_token: "REFRESH-local-only",
      expires_at: "2026-06-21T02:00:00.000Z",
    })
    await expect(
      refreshRemoteAuthJson(path, {
        env: {},
        nowMs: () => now,
        lock: {
          tryAcquire: async () => "would-wait",
          release: async () => undefined,
        },
        fetchImpl: async () => {
          throw new Error("issuer must not be called")
        },
      }),
    ).rejects.toThrow(/lock acquire timed out/)
  })

  test("default lock contends on QUANTA_PREFS_HOME/locks, not auth/locks", async () => {
    const home = mkdtempSync(join(tmpdir(), "bench-lock-home-"))
    TEMP_DIRS.add(home)
    const env = { QUANTA_PREFS_HOME: home }
    mkdirSync(join(home, "auth"), { recursive: true, mode: 0o700 })
    const authFile = chatgptTokenPath(home)
    writeFileSync(
      authFile,
      `${JSON.stringify({
        access_token: "ACCESS-old",
        refresh_token: "REFRESH-local-only",
        expires_at: "2026-06-21T00:00:00.000Z",
      })}\n`,
    )
    const nowMs = () => Date.parse("2026-06-21T00:00:00.000Z")
    const blocker = new FileBasedLock({
      store: createNodeLockFileStore(join(home, "locks")),
      clock: { now: nowMs },
      pid: 1,
    })
    expect(await blocker.tryAcquire(hashRefreshLockKey(authFile), "blocker", 60_000)).toBe(
      "acquired",
    )
    await expect(
      refreshRemoteAuthJson(authFile, {
        env,
        nowMs,
        fetchImpl: async () =>
          new Response(JSON.stringify({ access_token: "ACCESS-new", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(/lock acquire timed out/)
  })
})
