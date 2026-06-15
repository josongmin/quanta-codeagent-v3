/** Hellgate — jun-6 RFC: revoke OAuth tokens on logout (server-side, RFC 7009).
 *
 *  Load-bearing invariants (RFC §4.5, §6, §8):
 *   - revoke runs BEFORE the local delete;
 *   - a network failure / non-2xx ⇒ the local delete STILL happens (NO-THROW);
 *   - no token value ever leaks into a log line, a rendered box, or the URL;
 *   - knob-OFF ⇒ ZERO network calls + output byte-identical to local-delete-only;
 *   - codex-managed ⇒ skipped (returns 2 BEFORE any revoke).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildLogoutCmd } from "../../../src/apps/cli/logout-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import {
  chatgptTokenPath,
  defaultRevocationEndpoint,
  type FetchPort,
  revokeRefreshToken,
  writeToken,
} from "../../../src/auth/chatgpt-oauth"

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes (control chars) is the point — mirrors sibling auth CLI tests.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

const REFRESH_SECRET = "rt-SUPER-SECRET-do-not-leak-9f3a"

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

interface FetchCall {
  url: string
  init: RequestInit | undefined
  body: string
}

/** A recording fetch stub. `mode` decides the wire outcome WITHOUT touching the
 *  real network. */
const makeFetch = (
  mode: { kind: "ok" } | { kind: "non-2xx"; status: number } | { kind: "throw" },
): { fetchPort: FetchPort; calls: FetchCall[] } => {
  const calls: FetchCall[] = []
  const fetchPort: FetchPort = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      init,
      body: typeof init?.body === "string" ? init.body : "",
    })
    if (mode.kind === "throw") throw new Error("ECONNREFUSED auth.openai.com")
    if (mode.kind === "non-2xx") {
      return new Response("", { status: mode.status })
    }
    return new Response("", { status: 200 })
  }
  return { fetchPort, calls }
}

interface LogLine {
  msg: string
  ctx: unknown
}

const makeLogger = (): { logger: { warn(m: string, c?: unknown): void }; lines: LogLine[] } => {
  const lines: LogLine[] = []
  return { logger: { warn: (msg, ctx) => lines.push({ msg, ctx }) }, lines }
}

const toBase64Url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")

const fakeIdToken = (): string => {
  const h = toBase64Url('{"alg":"RS256"}')
  const b = toBase64Url(
    JSON.stringify({
      exp: 1_924_992_000,
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-1" },
    }),
  )
  return `${h}.${b}.sig`
}

const writeCodexAuth = async (home: string): Promise<void> => {
  await mkdir(home, { recursive: true })
  const path = join(home, "auth.json")
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: "2026-05-23T00:00:00.000Z",
      tokens: {
        id_token: fakeIdToken(),
        access_token: fakeIdToken(),
        refresh_token: "rt-codex",
        account_id: "acct-1",
      },
    }),
    "utf8",
  )
  if (process.platform !== "win32") await chmod(path, 0o600)
}

const seedToken = async (dir: string, refresh = REFRESH_SECRET): Promise<void> => {
  await writeToken(chatgptTokenPath(dir), {
    access_token: "at",
    refresh_token: refresh,
    expires_at: "2030-01-01T00:00:00.000Z",
    plan_type: "pro",
    account_id: "acct-1",
  })
}

const tokenExists = async (dir: string): Promise<boolean> => {
  try {
    await stat(chatgptTokenPath(dir))
    return true
  } catch {
    return false
  }
}

let dir: string
let codexHome: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "revoke-logout-"))
  codexHome = await mkdtemp(join(tmpdir(), "revoke-codex-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(codexHome, { recursive: true, force: true })
})

// ── Unit: revokeRefreshToken (closed-port, NO-THROW) ─────────────────────────

describe("revokeRefreshToken (RFC 7009 closed-port)", () => {
  test("happy 200 ⇒ ok:true, POST carries token_type_hint + client_id in BODY", async () => {
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const out = await revokeRefreshToken(
      { fetchPort },
      {
        revocationEndpoint: "https://auth.openai.com/oauth/revoke",
        clientId: "client_x",
        refreshToken: REFRESH_SECRET,
      },
    )
    expect(out).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.method).toBe("POST")
    const params = new URLSearchParams(calls[0]?.body)
    expect(params.get("token")).toBe(REFRESH_SECRET)
    expect(params.get("token_type_hint")).toBe("refresh_token")
    expect(params.get("client_id")).toBe("client_x")
    // Token rides the BODY only — never the URL.
    expect(calls[0]?.url).not.toContain(REFRESH_SECRET)
    expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/revoke")
  })

  test("empty refresh token ⇒ no-token, NO fetch issued", async () => {
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const out = await revokeRefreshToken(
      { fetchPort },
      { revocationEndpoint: "https://x/oauth/revoke", clientId: "c", refreshToken: "" },
    )
    expect(out).toEqual({ ok: false, reason: "no-token" })
    expect(calls).toHaveLength(0)
  })

  test("network throw ⇒ resolves network (NEVER throws), logs reason w/o token", async () => {
    const { fetchPort } = makeFetch({ kind: "throw" })
    const { logger, lines } = makeLogger()
    const out = await revokeRefreshToken(
      { fetchPort, logger },
      {
        revocationEndpoint: "https://x/oauth/revoke",
        clientId: "c",
        refreshToken: REFRESH_SECRET,
      },
    )
    expect(out).toEqual({ ok: false, reason: "network" })
    expect(lines).toHaveLength(1)
    // No token in the log message or its structured context.
    const serialized = JSON.stringify(lines)
    expect(serialized).not.toContain(REFRESH_SECRET)
  })

  test.each([
    400, 401, 404, 500,
  ])("non-2xx %i ⇒ non-2xx, no throw, no token in log", async (status) => {
    const { fetchPort } = makeFetch({ kind: "non-2xx", status })
    const { logger, lines } = makeLogger()
    const out = await revokeRefreshToken(
      { fetchPort, logger },
      {
        revocationEndpoint: "https://x/oauth/revoke",
        clientId: "c",
        refreshToken: REFRESH_SECRET,
      },
    )
    expect(out).toEqual({ ok: false, reason: "non-2xx" })
    expect(JSON.stringify(lines)).not.toContain(REFRESH_SECRET)
  })

  test("defaultRevocationEndpoint mirrors issuer + /oauth/revoke", () => {
    expect(defaultRevocationEndpoint("https://auth.openai.com")).toBe(
      "https://auth.openai.com/oauth/revoke",
    )
  })
})

// ── Logout wiring ────────────────────────────────────────────────────────────

describe("/logout revoke wiring (knob-gated, NO-THROW)", () => {
  test("knob ON + 200 ⇒ revoke POSTed BEFORE delete, file gone, box notes revoke", async () => {
    await seedToken(dir)
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    expect(calls).toHaveLength(1)
    expect(await tokenExists(dir)).toBe(false)
    const out = stripAnsi(cap.out)
    expect(out).toContain("Signed out")
    expect(out).toContain("server session revoked")
  })

  test("network FAILURE ⇒ local delete STILL happens, exit 0, 'local only' note", async () => {
    await seedToken(dir)
    const { fetchPort } = makeFetch({ kind: "throw" })
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0) // logout still succeeded
    expect(await tokenExists(dir)).toBe(false) // the dominant safety case
    expect(stripAnsi(cap.out)).toContain("local only")
  })

  test("non-2xx ⇒ local delete STILL happens, exit 0, never throws", async () => {
    await seedToken(dir)
    const { fetchPort } = makeFetch({ kind: "non-2xx", status: 500 })
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    expect(await tokenExists(dir)).toBe(false)
  })

  test("knob OFF ⇒ ZERO network calls + output byte-identical to local-delete-only", async () => {
    // Baseline: today's logout (no revoke deps wired at all).
    await seedToken(dir)
    const baselineCmd = buildLogoutCmd({ env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome } })
    const baseline = makeCtx(dir)
    expect(await baselineCmd.run([], baseline.ctx)).toBe(0)

    // Knob OFF but a fetch IS supplied — it must never be invoked, and the
    // rendered box must match the baseline byte-for-byte.
    await seedToken(dir)
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: false,
      fetchPort,
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    expect(calls).toHaveLength(0) // no revoke constructed
    expect(cap.out).toBe(baseline.out) // byte-identical
    // No "revoke" KV line rendered (the tmp path itself may contain the word).
    expect(stripAnsi(cap.out)).not.toContain("server session revoked")
    expect(stripAnsi(cap.out)).not.toContain("local only")
  })

  test("codex-managed ⇒ returns 2 BEFORE any revoke, fetch never invoked", async () => {
    // Seed a Codex-owned token so resolution reports source === "codex".
    await writeCodexAuth(codexHome)
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(2)
    expect(stripAnsi(cap.out)).toContain("Managed by Codex")
    expect(calls).toHaveLength(0) // never revoke a credential we don't own
  })

  test("no refresh token in record-shape ⇒ no revoke POST (caller guard)", async () => {
    // A token whose refresh_token is empty: the wiring guard skips the POST.
    await writeToken(chatgptTokenPath(dir), {
      access_token: "at",
      refresh_token: "",
      expires_at: "2030-01-01T00:00:00.000Z",
    })
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
    })
    const cap = makeCtx(dir)
    const exit = await cmd.run([], cap.ctx)
    expect(exit).toBe(0)
    expect(calls).toHaveLength(0)
    expect(await tokenExists(dir)).toBe(false)
  })

  test("revoke is issued BEFORE the local delete (token file still present at revoke time)", async () => {
    await seedToken(dir)
    // A fetch stub that, at the moment the revoke POST fires, observes whether
    // the on-disk token file still exists. revoke-before-delete ⇒ it MUST still
    // be there (the local delete has not run yet).
    let tokenPresentAtRevoke: boolean | undefined
    const fetchPort: FetchPort = async () => {
      tokenPresentAtRevoke = await tokenExists(dir)
      return new Response("", { status: 200 })
    }
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
    })
    const cap = makeCtx(dir)
    expect(await cmd.run([], cap.ctx)).toBe(0)
    expect(tokenPresentAtRevoke).toBe(true) // revoke ran while the token was still local
    expect(await tokenExists(dir)).toBe(false) // and the delete still happened after
  })

  test("NO token leaks into log/box even on success (token only in wire body)", async () => {
    await seedToken(dir)
    const { fetchPort, calls } = makeFetch({ kind: "ok" })
    const { logger, lines } = makeLogger()
    const cmd = buildLogoutCmd({
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      revokeOnLogout: true,
      fetchPort,
      logger,
    })
    const cap = makeCtx(dir)
    await cmd.run([], cap.ctx)
    // The token rides the POST body (required by RFC 7009)…
    expect(calls[0]?.body).toContain(REFRESH_SECRET)
    // …but NEVER the rendered box or any log line.
    expect(stripAnsi(cap.out)).not.toContain(REFRESH_SECRET)
    expect(cap.err).not.toContain(REFRESH_SECRET)
    expect(JSON.stringify(lines)).not.toContain(REFRESH_SECRET)
  })
})
