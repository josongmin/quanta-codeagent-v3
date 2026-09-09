/**
 * Hellgate — T-7 bench account login (jun-20 multi-auth fleet).
 *
 * Drives runBenchLogin end-to-end with a MOCK OAuth callback + fetch + in-memory
 * fs (no real browser / issuer / disk). Teeth:
 *  - a new account writes its token to a per-label path AND is appended to the
 *    manifest (the loop the fleet previously lacked),
 *  - the produced manifest is CONSUMABLE by the pool (parseAuthPoolManifest),
 *  - a second login APPENDS (never clobbers the first account),
 *  - re-login of the same label is idempotent (no duplicate manifest entry),
 *  - a label/auth-file conflict and a missing client_id fail fast.
 */
import { describe, expect, test } from "bun:test"
import {
  type BenchLoginDeps,
  benchAccountAuthFile,
  parseAuthPoolManifest,
  runBenchLogin,
} from "@/apps/bench/auth-pool"
import type { TokenRecord } from "@/auth/chatgpt-oauth"

const HOME = "/home/tester"

/** A fake fs + OAuth harness shared across one test's logins. */
const harness = (over: { tokenBody?: Record<string, unknown> } = {}) => {
  const files = new Map<string, string>()
  const tokens = new Map<string, TokenRecord>()
  const opened: string[] = []
  const deps: BenchLoginDeps = {
    env: { QUANTA_OAUTH_CLIENT_ID: "test-client", QUANTA_PREFS_HOME: HOME },
    opener: (url) => void opened.push(url),
    callbackProvider: {
      start: async () => ({
        redirectUri: "http://localhost:1/auth/callback",
        received: Promise.resolve({ code: "auth-code-123" }),
        close() {},
      }),
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          over.tokenBody ?? {
            access_token: "AT-secret",
            refresh_token: "RT-secret",
            expires_in: 3600,
          },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    nowMs: () => 1_000_000_000,
    writeTokenImpl: async (path, rec) => void tokens.set(path, rec),
    readFileImpl: (path) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    writeFileImpl: (path, text) => void files.set(path, text),
  }
  return { files, tokens, opened, deps }
}

describe("T-7 runBenchLogin", () => {
  test("a new account writes a per-label token file and registers in the manifest", async () => {
    const h = harness()
    const res = await runBenchLogin({ label: "acct-a", maxParallel: 6 }, h.deps)

    const expectedPath = benchAccountAuthFile(h.deps.env, "acct-a")
    expect(expectedPath).toBe(`${HOME}/auth/chatgpt-acct-a.json`)
    expect(res.authFile).toBe(expectedPath)
    expect(res.manifestAdded).toBe(true)
    expect(res.accountCount).toBe(1)

    // token persisted (with the real refresh token — stripping happens at SHIP time)
    expect(h.tokens.get(expectedPath)?.access_token).toBe("AT-secret")

    // manifest written AND consumable by the pool resolver
    const manifestText = h.files.get(res.manifestPath)
    expect(manifestText).toBeDefined()
    const src = parseAuthPoolManifest(manifestText ?? "")
    expect(src.kind).toBe("pool")
    if (src.kind !== "pool") throw new Error("expected pool")
    expect(src.accounts[0]).toMatchObject({
      label: "acct-a",
      authFile: expectedPath,
      maxParallel: 6,
    })
  })

  test("a second login APPENDS — the first account is never clobbered", async () => {
    const h = harness()
    await runBenchLogin({ label: "acct-a" }, h.deps)
    const res = await runBenchLogin({ label: "acct-b" }, h.deps)
    expect(res.manifestAdded).toBe(true)
    expect(res.accountCount).toBe(2)
    const src = parseAuthPoolManifest(h.files.get(res.manifestPath) ?? "")
    if (src.kind !== "pool") throw new Error("expected pool")
    expect(src.accounts.map((a) => a.label)).toEqual(["acct-a", "acct-b"])
  })

  test("re-login of the same label is idempotent (no duplicate manifest entry)", async () => {
    const h = harness()
    await runBenchLogin({ label: "acct-a" }, h.deps)
    const res = await runBenchLogin({ label: "acct-a" }, h.deps)
    expect(res.manifestAdded).toBe(false) // already present
    expect(res.accountCount).toBe(1)
    const src = parseAuthPoolManifest(h.files.get(res.manifestPath) ?? "")
    if (src.kind !== "pool") throw new Error("expected pool")
    expect(src.accounts.length).toBe(1) // not duplicated
  })

  test("same label but a DIFFERENT auth-file fails fast (ambiguous)", async () => {
    const h = harness()
    await runBenchLogin({ label: "acct-a" }, h.deps)
    await expect(
      runBenchLogin({ label: "acct-a", authFile: "/somewhere/else.json" }, h.deps),
    ).rejects.toThrow(/already in .* different auth_file/)
  })

  test("missing QUANTA_OAUTH_CLIENT_ID fails fast before any browser/fetch", async () => {
    const h = harness()
    const noClient: BenchLoginDeps = {
      ...h.deps,
      env: { QUANTA_OAUTH_CLIENT_ID: "", QUANTA_PREFS_HOME: HOME },
    }
    await expect(runBenchLogin({ label: "acct-a" }, noClient)).rejects.toThrow(/client_id/)
    expect(h.opened.length).toBe(0) // never opened a browser
    expect(h.files.size).toBe(0) // never touched the manifest
  })

  test("empty label and non-positive max-parallel fail fast", async () => {
    const h = harness()
    await expect(runBenchLogin({ label: "   " }, h.deps)).rejects.toThrow(/non-empty/)
    await expect(runBenchLogin({ label: "acct-a", maxParallel: 0 }, h.deps)).rejects.toThrow(
      /max-parallel/,
    )
  })
})
