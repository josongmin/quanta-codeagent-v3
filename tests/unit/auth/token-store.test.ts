import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  deleteToken,
  hasUsableChatgptToken,
  isExpired,
  readCodexAuthToken,
  readResolvedToken,
  readToken,
  type TokenRecord,
  TokenStoreError,
  writeToken,
} from "../../../src/auth/chatgpt-oauth/token-store"

const sampleRecord: TokenRecord = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_at: "2030-01-01T00:00:00.000Z",
  plan_type: "plus",
  account_id: "acct-1",
  last_refresh: "2026-05-23T00:00:00.000Z",
}

const toBase64Url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")

const fakeJwt = (payload: Record<string, unknown>): string => {
  const header = toBase64Url('{"alg":"RS256"}')
  const body = toBase64Url(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

const fakeCodexIdToken = (): string =>
  fakeJwt({
    exp: 1_924_992_000,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_account_id: "acct-codex",
    },
  })

let dir: string
let tokenPath: string
let codexPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokstore-"))
  tokenPath = join(dir, "auth", "chatgpt.json")
  codexPath = join(dir, ".codex", "auth.json")
  // Pre-create the parent so the tests that bypass writeToken (writing
  // malformed contents directly via writeFile) don't ENOENT.
  await mkdir(dirname(tokenPath), { recursive: true })
  await mkdir(dirname(codexPath), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("token-store.read/write", () => {
  test("read returns null when file is absent", async () => {
    expect(await readToken(tokenPath)).toBeNull()
  })

  test("writeToken round-trips through readToken byte-equal", async () => {
    await writeToken(tokenPath, sampleRecord)
    const back = await readToken(tokenPath)
    expect(back).toEqual(sampleRecord)
  })

  test("written file has mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return
    await writeToken(tokenPath, sampleRecord)
    const s = await stat(tokenPath)
    expect(s.mode & 0o777).toBe(0o600)
  })

  test("read refuses a world-readable token file on POSIX", async () => {
    if (process.platform === "win32") return
    await writeToken(tokenPath, sampleRecord)
    await chmod(tokenPath, 0o644)
    await expect(readToken(tokenPath)).rejects.toThrow(TokenStoreError)
  })

  test("read throws on malformed JSON", async () => {
    await writeFile(tokenPath, "not json", "utf8")
    if (process.platform !== "win32") await chmod(tokenPath, 0o600)
    await expect(readToken(tokenPath)).rejects.toThrow(TokenStoreError)
  })

  test("read throws when required field missing", async () => {
    await writeFile(tokenPath, JSON.stringify({ access_token: "x" }), "utf8")
    if (process.platform !== "win32") await chmod(tokenPath, 0o600)
    await expect(readToken(tokenPath)).rejects.toThrow(TokenStoreError)
  })

  test("write is atomic (no .tmp lingers on success)", async () => {
    await writeToken(tokenPath, sampleRecord)
    const tmp = `${tokenPath}.tmp`
    let lingers = false
    try {
      await readFile(tmp)
      lingers = true
    } catch {
      lingers = false
    }
    expect(lingers).toBe(false)
  })

  test("readCodexAuthToken projects Codex auth.json into TokenRecord", async () => {
    await writeFile(
      codexPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-05-23T00:00:00.000Z",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: fakeCodexIdToken(),
          access_token: fakeJwt({ exp: 1_924_992_000 }),
          refresh_token: "rt-codex",
          account_id: "acct-codex",
        },
      }),
      "utf8",
    )
    if (process.platform !== "win32") await chmod(codexPath, 0o600)

    const back = await readCodexAuthToken(codexPath)
    expect(back).toMatchObject({
      access_token: expect.any(String),
      refresh_token: "rt-codex",
      account_id: "acct-codex",
      plan_type: "pro",
      last_refresh: "2026-05-23T00:00:00.000Z",
    })
    expect(back?.expires_at).toBe("2031-01-01T00:00:00.000Z")
  })

  test("readResolvedToken prefers quanta token over Codex fallback", async () => {
    await writeToken(tokenPath, sampleRecord)
    await writeFile(
      codexPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: fakeCodexIdToken(),
          access_token: fakeJwt({ exp: 1_924_992_000 }),
          refresh_token: "rt-codex",
          account_id: "acct-codex",
        },
      }),
      "utf8",
    )
    if (process.platform !== "win32") await chmod(codexPath, 0o600)

    const resolved = await readResolvedToken({
      QUANTA_PREFS_HOME: dir,
      CODEX_HOME: join(dir, ".codex"),
    })
    expect(resolved).toMatchObject({
      source: "quanta",
      path: tokenPath,
      record: sampleRecord,
    })
  })

  test("readResolvedToken honors QUANTA_CHATGPT_AUTH_SOURCE=codex", async () => {
    await writeToken(tokenPath, sampleRecord)
    await writeFile(
      codexPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: fakeCodexIdToken(),
          access_token: fakeJwt({ exp: 1_924_992_000 }),
          refresh_token: "rt-codex",
          account_id: "acct-codex",
        },
      }),
      "utf8",
    )
    if (process.platform !== "win32") await chmod(codexPath, 0o600)

    const resolved = await readResolvedToken({
      QUANTA_PREFS_HOME: dir,
      CODEX_HOME: join(dir, ".codex"),
      QUANTA_CHATGPT_AUTH_SOURCE: "codex",
    })
    expect(resolved).toMatchObject({
      source: "codex",
      path: codexPath,
    })
  })

  test("hasUsableChatgptToken accepts Codex chatgpt auth bundle", async () => {
    await writeFile(
      codexPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: fakeCodexIdToken(),
          access_token: fakeJwt({ exp: 1_924_992_000 }),
          refresh_token: "rt-codex",
          account_id: "acct-codex",
        },
      }),
      "utf8",
    )
    if (process.platform !== "win32") await chmod(codexPath, 0o600)

    expect(
      hasUsableChatgptToken({
        QUANTA_PREFS_HOME: dir,
        CODEX_HOME: join(dir, ".codex"),
      }),
    ).toBe(true)
  })
})

describe("token-store.delete", () => {
  test("delete is idempotent (absent file is fine)", async () => {
    await expect(deleteToken(tokenPath)).resolves.toBeUndefined()
  })

  test("delete removes an existing token file", async () => {
    await writeToken(tokenPath, sampleRecord)
    await deleteToken(tokenPath)
    expect(await readToken(tokenPath)).toBeNull()
  })
})

describe("token-store.isExpired", () => {
  test("true when expires_at is in the past", () => {
    expect(isExpired({ expires_at: "2020-01-01T00:00:00Z" }, Date.now(), 0)).toBe(true)
  })
  test("true when within the skew window", () => {
    const now = 1_700_000_000_000
    const tenSecLater = new Date(now + 10_000).toISOString()
    expect(isExpired({ expires_at: tenSecLater }, now, 30_000)).toBe(true)
  })
  test("false when expires_at is far in the future", () => {
    const now = 1_700_000_000_000
    const yearLater = new Date(now + 365 * 24 * 3600 * 1000).toISOString()
    expect(isExpired({ expires_at: yearLater }, now, 30_000)).toBe(false)
  })
  test("unparseable timestamp is treated as expired", () => {
    expect(isExpired({ expires_at: "not-a-date" }, Date.now(), 0)).toBe(true)
  })
})
