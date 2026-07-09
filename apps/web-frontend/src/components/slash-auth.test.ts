/**
 * UUX-4-13 (jul-10 W4) — web OAuth completion signal.
 *
 * Before: `/login` opened the browser and said "finish the flow, then come
 * back" — the daemon's background exchange result (success OR failure) never
 * reached the transcript (failures were `logger.warn`-only, console-side).
 *
 * Now: the daemon's `/auth/login` response carries an `attemptId`, and the
 * frontend runs a BOUNDED poll against `/auth/login/status?attempt=<id>`,
 * reporting the terminal outcome (success / failure / timeout) into the
 * transcript via `onResult`. Old daemons (no `attemptId`) keep the exact old
 * behaviour — no poll, no new messages.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildAuthSlashCommands,
  type LoginPollOutcome,
  pollLoginCompletion,
  reportLoginCompletion,
} from "./slash-auth"

const instantSleep = async (_ms: number): Promise<void> => {}

/** Scripted fetch: pops one response per call; repeats the last one after. */
const scriptedFetch = (bodies: readonly { status: number; json: unknown }[]) => {
  const calls: string[] = []
  let i = 0
  const impl = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url))
    const pick = bodies[Math.min(i, bodies.length - 1)]
    i += 1
    if (pick === undefined) throw new Error("no scripted response")
    return new Response(JSON.stringify(pick.json), { status: pick.status })
  }
  return { impl: impl as typeof fetch, calls }
}

const ep = { httpUrl: "http://127.0.0.1:4096", token: "tok" }

describe("pollLoginCompletion — bounded /auth/login/status poll", () => {
  it("pending → ok resolves with the plan (and hits the attempt-status route with auth)", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 200, json: { state: "pending" } },
      { status: 200, json: { state: "pending" } },
      { status: 200, json: { state: "ok", planType: "plus" } },
    ])
    const outcome = await pollLoginCompletion(ep, "att-1", {
      fetchImpl: impl,
      sleep: instantSleep,
      intervalMs: 10,
      timeoutMs: 1000,
    })
    expect(outcome).toEqual({ kind: "ok", planType: "plus" })
    expect(calls[0]).toBe("http://127.0.0.1:4096/auth/login/status?attempt=att-1")
    expect(calls.length).toBe(3)
  })

  it("a daemon-side failure reaches the caller (not console-only anymore)", async () => {
    const { impl } = scriptedFetch([
      { status: 200, json: { state: "failed", error: "exchange_code 400" } },
    ])
    const outcome = await pollLoginCompletion(ep, "att-2", {
      fetchImpl: impl,
      sleep: instantSleep,
      intervalMs: 10,
      timeoutMs: 1000,
    })
    expect(outcome).toEqual({ kind: "failed", error: "exchange_code 400" })
  })

  it("BOUNDED: perpetual pending stops at timeoutMs with a timeout outcome", async () => {
    const { impl, calls } = scriptedFetch([{ status: 200, json: { state: "pending" } }])
    const outcome = await pollLoginCompletion(ep, "att-3", {
      fetchImpl: impl,
      sleep: instantSleep,
      intervalMs: 10,
      timeoutMs: 55,
    })
    expect(outcome).toEqual({ kind: "timeout" })
    // ceil(55/10) = 6 polls max — the loop cannot run past the deadline.
    expect(calls.length).toBeLessThanOrEqual(6)
  })

  it("404 (unknown attempt / old daemon route) → unsupported, poll stops immediately", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 404, json: { error: "unknown_auth_route" } },
      { status: 200, json: { state: "ok" } },
    ])
    const outcome = await pollLoginCompletion(ep, "att-4", {
      fetchImpl: impl,
      sleep: instantSleep,
      intervalMs: 10,
      timeoutMs: 1000,
    })
    expect(outcome).toEqual({ kind: "unsupported" })
    expect(calls.length).toBe(1)
  })

  it("transient network errors are tolerated until the bound", async () => {
    let n = 0
    const impl = (async () => {
      n += 1
      if (n < 3) throw new Error("ECONNREFUSED")
      return new Response(JSON.stringify({ state: "ok", planType: null }), { status: 200 })
    }) as typeof fetch
    const outcome = await pollLoginCompletion(ep, "att-5", {
      fetchImpl: impl,
      sleep: instantSleep,
      intervalMs: 10,
      timeoutMs: 1000,
    })
    expect(outcome).toEqual({ kind: "ok", planType: null })
  })
})

describe("reportLoginCompletion — terminal outcome lands in the transcript", () => {
  const collect = () => {
    const seen: { msg: string; kind: "ok" | "err" }[] = []
    return { seen, onResult: (msg: string, kind: "ok" | "err") => seen.push({ msg, kind }) }
  }

  it("ok → success line with the plan", () => {
    const { seen, onResult } = collect()
    reportLoginCompletion({ kind: "ok", planType: "plus" }, onResult, 120_000)
    expect(seen).toEqual([{ msg: "login complete — plan=plus", kind: "ok" }])
  })

  it("failed → error line carrying the daemon's error", () => {
    const { seen, onResult } = collect()
    reportLoginCompletion({ kind: "failed", error: "exchange_code 400" }, onResult, 120_000)
    expect(seen).toEqual([{ msg: "login failed: exchange_code 400", kind: "err" }])
  })

  it("timeout → honest not-confirmed line pointing at /whoami", () => {
    const { seen, onResult } = collect()
    reportLoginCompletion({ kind: "timeout" } as LoginPollOutcome, onResult, 120_000)
    expect(seen).toEqual([
      { msg: "login not confirmed after 120s — run /whoami to check", kind: "err" },
    ])
  })

  it("unsupported → status-unknown line (attempt evicted / daemon restarted)", () => {
    const { seen, onResult } = collect()
    reportLoginCompletion({ kind: "unsupported" } as LoginPollOutcome, onResult, 120_000)
    expect(seen).toEqual([
      { msg: "login status unknown (daemon restarted?) — run /whoami to check", kind: "err" },
    ])
  })
})

describe("/login action wiring — the poll actually starts (and old daemons stay silent)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const runLogin = async (loginJson: unknown, statusJson: unknown) => {
    const calls: string[] = []
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith("/auth/login")) {
        return new Response(JSON.stringify(loginJson), { status: 200 })
      }
      return new Response(JSON.stringify(statusJson), { status: 200 })
    }) as typeof fetch)
    const seen: { msg: string; kind: "ok" | "err" }[] = []
    const commands = buildAuthSlashCommands({
      ...ep,
      onResult: (msg, kind) => seen.push({ msg, kind }),
      loginPollOptions: { intervalMs: 1, timeoutMs: 50, sleep: instantSleep },
    })
    const login = commands.find((c) => c.slug === "login")
    expect(login?.kind).toBe("local")
    if (login?.kind !== "local" && login?.kind !== "readout") throw new Error("unexpected kind")
    await login.action("")
    return { calls, seen }
  }

  it("attemptId present ⇒ a completion message eventually lands in the transcript", async () => {
    const { seen } = await runLogin(
      { authorizeUrl: "https://auth.example/x", attemptId: "att-9" },
      { state: "ok", planType: "plus" },
    )
    await vi.waitFor(() => {
      expect(seen.map((s) => s.msg)).toContain("login complete — plan=plus")
    })
  })

  it("old daemon (no attemptId) ⇒ exactly the old messages, no poll traffic", async () => {
    const { calls, seen } = await runLogin({ authorizeUrl: "https://auth.example/x" }, {})
    // Give any (buggy) stray poll a few ticks to show up.
    await new Promise((r) => setTimeout(r, 5))
    expect(calls.filter((c) => c.includes("/auth/login/status"))).toEqual([])
    expect(seen.some((s) => s.msg.includes("login complete"))).toBe(false)
  })
})
