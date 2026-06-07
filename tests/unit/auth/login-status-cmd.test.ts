import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildLoginCmd } from "../../../src/apps/cli/login-cmd"
import { buildLogoutCmd } from "../../../src/apps/cli/logout-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import { buildStatusCmd } from "../../../src/apps/cli/status-cmd"
import type { OAuthCallbackProvider } from "../../../src/auth/chatgpt-oauth"
import { chatgptTokenPath, writeToken } from "../../../src/auth/chatgpt-oauth"

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

interface Cap {
  out: string
  err: string
  ctx: SlashContext
}

const makeCtx = (prefsHome: string): Cap => {
  const cap: Cap = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        cap.out += s
      },
      err: (s) => {
        cap.err += s
      },
      cwd: prefsHome,
      prefsHome,
    },
  }
  return cap
}

const makeControlledProvider = (): {
  provider: OAuthCallbackProvider
  succeed(code?: string): void
} => {
  let resolveReceived: ((value: { code: string }) => void) | undefined
  return {
    provider: {
      async start(input) {
        if (input.signal?.aborted) {
          throw new Error("unexpected pre-abort")
        }
        const received = new Promise<{ code: string }>((resolve) => {
          resolveReceived = resolve
        })
        return {
          redirectUri: "http://localhost:1455/auth/callback",
          received,
        }
      },
    },
    succeed(code = "ok-code") {
      resolveReceived?.({ code })
    },
  }
}

const toBase64Url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")

const fakeIdToken = (plan: string): string => {
  const h = toBase64Url('{"alg":"RS256"}')
  const b = toBase64Url(
    JSON.stringify({
      exp: 1_924_992_000,
      "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "acct-1" },
    }),
  )
  return `${h}.${b}.sig`
}

const writeCodexAuth = async (home: string, plan = "pro"): Promise<void> => {
  const path = join(home, "auth.json")
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: "2026-05-23T00:00:00.000Z",
      tokens: {
        id_token: fakeIdToken(plan),
        access_token: fakeIdToken(plan),
        refresh_token: "rt-codex",
        account_id: "acct-1",
      },
    }),
    "utf8",
  )
  if (process.platform !== "win32") await chmod(path, 0o600)
}

const mockTokenResponse = (plan: string): Response =>
  new Response(
    JSON.stringify({
      access_token: "at-stub",
      refresh_token: "rt-stub",
      id_token: fakeIdToken(plan),
      expires_in: 3600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

let dir: string
let codexHome: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "logincmd-"))
  codexHome = await mkdtemp(join(tmpdir(), "logincmd-codex-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(codexHome, { recursive: true, force: true })
})

describe("/login command", () => {
  test("explicitly-cleared client_id → exits 2 with friendly error box", async () => {
    // Default client_id is now the public Codex OAuth app id, so `/login`
    // works out of the box with an empty env. The refusal path only fires
    // when an operator has *explicitly* cleared the env var.
    const cmd = buildLoginCmd({ env: { QUANTA_OAUTH_CLIENT_ID: "" } })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(2)
    expect(stripAnsi(cap.err)).toContain("OAuth client_id is not configured")
    expect(stripAnsi(cap.err)).toContain("QUANTA_OAUTH_CLIENT_ID")
  })

  test("rejects bogus argv", async () => {
    const cmd = buildLoginCmd({ env: { QUANTA_OAUTH_CLIENT_ID: "x" } })
    const cap = makeCtx(dir)
    const exit = await cmd.run(["--other"], cap.ctx)
    expect(exit).toBe(1)
    expect(stripAnsi(cap.err)).toContain("usage: /login")
  })

  test("happy path writes token + renders Signed in box (plus plan → exit 0)", async () => {
    let capturedUrl: string | null = null
    const controlled = makeControlledProvider()
    const cmd = buildLoginCmd({
      env: { QUANTA_OAUTH_CLIENT_ID: "client_x", QUANTA_PREFS_HOME: dir },
      opener: (u) => {
        capturedUrl = u
      },
      callbackProvider: controlled.provider,
      fetchImpl: async () => mockTokenResponse("plus"),
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
      timeoutMs: 5000,
    })
    const cap = makeCtx(dir)
    // Drive the callback once the opener captures the URL.
    const runPromise = cmd.run([], cap.ctx)
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    controlled.succeed()
    const exit = await runPromise
    expect(exit).toBe(0)
    const out = stripAnsi(cap.out)
    expect(out).toContain("Signed in")
    expect(out).toContain("plus")
    expect(out).toContain("acct-1")

    // Token file landed at the expected path with 0600 on POSIX.
    const path = chatgptTokenPath(dir)
    const s = await stat(path)
    if (process.platform !== "win32") expect(s.mode & 0o777).toBe(0o600)
  })

  test("free plan: token still saved (truth surface) but exit 3 + warn line", async () => {
    let capturedUrl: string | null = null
    const controlled = makeControlledProvider()
    const cmd = buildLoginCmd({
      env: { QUANTA_OAUTH_CLIENT_ID: "client_x", QUANTA_PREFS_HOME: dir },
      opener: (u) => {
        capturedUrl = u
      },
      callbackProvider: controlled.provider,
      fetchImpl: async () => mockTokenResponse("free"),
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
      timeoutMs: 5000,
    })
    const cap = makeCtx(dir)
    const runPromise = cmd.run([], cap.ctx)
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    controlled.succeed()
    const exit = await runPromise
    expect(exit).toBe(3)
    expect(stripAnsi(cap.out)).toContain("Free ChatGPT plan does not include API access")
    const stored = JSON.parse(await readFile(chatgptTokenPath(dir), "utf8")) as {
      plan_type?: string
      account_id?: string
    }
    expect(stored.plan_type).toBe("free")
    expect(stored.account_id).toBe("acct-1")
  })
})

describe("/status command", () => {
  test("no token + no env keys → default anthropic with hint", async () => {
    const cmd = buildStatusCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    const out = stripAnsi(cap.out)
    expect(out).toContain("Active provider")
    expect(out).toContain("anthropic")
    expect(out).toContain("default, no key configured")
    expect(out).toContain("ANTHROPIC_API_KEY")
    expect(out).toContain("not signed in")
  })

  test("env keys present → reflected as set", async () => {
    const cmd = buildStatusCmd({
      env: {
        QUANTA_PREFS_HOME: dir,
        CODEX_HOME: codexHome,
        ANTHROPIC_API_KEY: "sk-a",
        OPENAI_API_KEY: "sk-o",
      },
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
    })
    const cap = makeCtx(dir)
    await cmd.run([], cap.ctx)
    const out = stripAnsi(cap.out)
    expect(out).toMatch(/ANTHROPIC_API_KEY.*set/)
    expect(out).toMatch(/OPENAI_API_KEY.*set/)
  })

  test("valid token in store → shows active + plan", async () => {
    await writeToken(chatgptTokenPath(dir), {
      access_token: "at",
      refresh_token: "rt",
      expires_at: new Date(Date.parse("2026-05-23T00:00:00.000Z") + 3600_000).toISOString(),
      plan_type: "plus",
      account_id: "acct-1",
    })
    const cmd = buildStatusCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome, QUANTA_PROVIDER: "chatgpt-oauth" },
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
    })
    const cap = makeCtx(dir)
    await cmd.run([], cap.ctx)
    const out = stripAnsi(cap.out)
    expect(out).toContain("chatgpt-oauth")
    expect(out).toContain("active")
    expect(out).toContain("plus")
    expect(out).toContain("acct-1")
  })

  test("explicit chatgpt-oauth but no token → red 'no token' hint", async () => {
    const cmd = buildStatusCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome, QUANTA_PROVIDER: "chatgpt-oauth" },
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
    })
    const cap = makeCtx(dir)
    await cmd.run([], cap.ctx)
    expect(stripAnsi(cap.out)).toContain("no token")
  })

  test("Codex auth fallback → shows active token source and path", async () => {
    await writeCodexAuth(codexHome)
    const cmd = buildStatusCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
    })
    const cap = makeCtx(dir)
    await cmd.run([], cap.ctx)
    const out = stripAnsi(cap.out)
    expect(out).toContain("chatgpt-oauth")
    expect(out).toContain("auto — token on disk")
    expect(out).toContain("codex login")
    expect(out).toContain(join(codexHome, "auth.json"))
  })

  test("expired token → shows expired state", async () => {
    await writeToken(chatgptTokenPath(dir), {
      access_token: "at",
      refresh_token: "rt",
      expires_at: "2020-01-01T00:00:00.000Z",
    })
    const cmd = buildStatusCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      nowMs: () => Date.parse("2026-05-23T00:00:00.000Z"),
    })
    const cap = makeCtx(dir)
    await cmd.run([], cap.ctx)
    expect(stripAnsi(cap.out)).toContain("expired")
  })
})

describe("/logout command", () => {
  test("rejects any arguments", async () => {
    const cmd = buildLogoutCmd()
    const cap = makeCtx(dir)
    expect(await cmd.run(["foo"], cap.ctx)).toBe(1)
    expect(cap.err).toContain("takes no arguments")
  })

  test("absent token → 'not signed in' yellow path + exit 0", async () => {
    const cmd = buildLogoutCmd({ env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome } })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    expect(stripAnsi(cap.out)).toContain("Not signed in")
    expect(stripAnsi(cap.out)).toContain("Nothing to delete")
  })

  test("present token → deletes file + renders 'Signed out' with prior plan", async () => {
    // Seed a token first via the login happy-path machinery.
    const seedCmd = buildLoginCmd({
      env: { QUANTA_OAUTH_CLIENT_ID: "client_x" },
      opener: (_u) => {
        // capture & drive below
      },
      timeoutMs: 5000,
    })
    void seedCmd
    // Use direct token-store API to avoid running the full OAuth flow here.
    const { chatgptTokenPath, writeToken } = await import("@/auth/chatgpt-oauth")
    await writeToken(chatgptTokenPath(dir), {
      access_token: "at",
      refresh_token: "rt",
      expires_at: "2030-01-01T00:00:00.000Z",
      plan_type: "pro",
      account_id: "acct-1",
    })

    const cmd = buildLogoutCmd({ env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome } })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    const out = stripAnsi(cap.out)
    expect(out).toContain("Signed out")
    expect(out).toContain("deleted")
    expect(out).toContain("pro")
    expect(out).toContain("acct-1")

    // File is actually gone.
    let exists = true
    try {
      await stat(chatgptTokenPath(dir))
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  test("running logout twice is idempotent (second run → not signed in)", async () => {
    const { chatgptTokenPath, writeToken } = await import("@/auth/chatgpt-oauth")
    await writeToken(chatgptTokenPath(dir), {
      access_token: "at",
      refresh_token: "rt",
      expires_at: "2030-01-01T00:00:00.000Z",
    })
    const cmd = buildLogoutCmd({ env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome } })
    const first = makeCtx(dir)
    expect(await cmd.run([], first.ctx)).toBe(0)
    expect(stripAnsi(first.out)).toContain("Signed out")
    const second = makeCtx(dir)
    expect(await cmd.run([], second.ctx)).toBe(0)
    expect(stripAnsi(second.out)).toContain("Not signed in")
  })

  test("Codex-managed token → logout refuses local deletion", async () => {
    await writeCodexAuth(codexHome)
    const cmd = buildLogoutCmd({ env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome } })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(2)
    const out = stripAnsi(cap.out)
    expect(out).toContain("Managed by Codex")
    expect(out).toContain(join(codexHome, "auth.json"))
  })
})
