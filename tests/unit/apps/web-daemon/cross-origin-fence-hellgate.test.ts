/**
 * HELLGATE — the daemon is not readable (or drivable) by a page the user
 * happens to be visiting.
 *
 * MEASURED on the shipping handler before this fence: `quanta web` binds
 * `127.0.0.1` and `assertSafeBindPolicy` requires a token ONLY for a wildcard
 * bind, so the default daemon is tokenless. `makeRequireAuth` then returns
 * "allow" for every route, and `corsHeaders` echoed whatever `Origin` arrived.
 * A page on any site could therefore:
 *
 *   fetch("http://127.0.0.1:4096/threads")            -> 200, thread ids
 *   fetch("http://127.0.0.1:4096/threads/<id>/events") -> 200, full transcript
 *   fetch("http://127.0.0.1:4096/auth/status")         -> account id, plan, token path
 *   fetch("http://127.0.0.1:4096/auth/logout",{method:"POST"}) -> token deleted
 *
 * The last one matters even without a readable response: a POST with a simple
 * content-type is a CORS *simple request*, so the browser sends it WITHOUT a
 * preflight and the side effect lands whether or not the page can read the
 * reply. Omitting `access-control-allow-origin` is therefore not enough — a
 * disallowed `Origin` has to be REFUSED.
 *
 * Fence:
 *   X-1  An `Origin` outside the allowlist is refused (403) before any route
 *        handler runs — read routes and effectful routes alike.
 *   X-2  No `access-control-allow-origin` is handed to a disallowed origin, on
 *        the refusal or on the preflight.
 *   X-3  PAIRED CONTROL — the real frontends still work: the Vite dev origin,
 *        a loopback origin on any port, and the Tauri origin all pass.
 *   X-4  PAIRED CONTROL — a request with NO `Origin` header (curl, the CLI's
 *        own client, a same-origin fetch) is unaffected. This is the
 *        byte-identity arm: non-browser callers must not need a new header.
 */

import { describe, expect, test } from "bun:test"
import { buildFetchHandler, type FetchHandlerDeps } from "@/apps/web-daemon/server/fetch-handler"

const calls: string[] = []

const handler = () =>
  buildFetchHandler({
    config: { authToken: undefined },
    registry: { size: () => 0 },
    startedAt: 0,
    authRoutes: {
      login: async () => {
        calls.push("login")
        return new Response("ok")
      },
      loginStatus: async () => {
        calls.push("loginStatus")
        return new Response("ok")
      },
      logout: async () => {
        calls.push("logout")
        return new Response("ok")
      },
      status: async () => {
        calls.push("status")
        return new Response("ok")
      },
    },
  } as unknown as FetchHandlerDeps)

const call = async (
  method: string,
  path: string,
  origin?: string,
): Promise<{ status: number; acao: string | null }> => {
  const res = await handler()(
    new Request(`http://127.0.0.1:4096${path}`, {
      method,
      ...(origin === undefined ? {} : { headers: { origin } }),
    }),
    {} as never,
  )
  // The route table's fall-through arm is `undefined`; every path exercised here
  // must produce a real Response, so an absent one is a failed assertion rather
  // than a silently-skipped case.
  if (res === undefined) throw new Error(`no response for ${method} ${path}`)
  return { status: res.status, acao: res.headers.get("access-control-allow-origin") }
}

const HOSTILE = "https://evil.example"

describe("X — cross-origin fence", () => {
  test("X-1 a hostile Origin is refused on every route, effectful ones included", async () => {
    calls.length = 0
    const paths: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/health"],
      ["GET", "/network"],
      ["GET", "/threads"],
      ["GET", "/threads/t1/events"],
      ["GET", "/api/knobs"],
      ["GET", "/readout/cost"],
      ["GET", "/auth/status"],
      ["POST", "/auth/logout"],
      ["POST", "/config"],
    ]
    const seen: Record<string, number> = {}
    for (const [method, path] of paths) {
      seen[`${method} ${path}`] = (await call(method, path, HOSTILE)).status
    }
    for (const [route, status] of Object.entries(seen)) {
      expect({ route, status }).toEqual({ route, status: 403 })
    }
    // X-1 is a BEFORE-the-handler fence: no OAuth side effect may have run.
    expect(calls).toEqual([])
  })

  test("X-2 a disallowed origin is never handed an ACAO, nor a usable preflight", async () => {
    const get = await call("GET", "/health", HOSTILE)
    expect(get.acao).toBeNull()
    const preflight = await call("OPTIONS", "/config", HOSTILE)
    expect(preflight.acao).toBeNull()
  })

  test("X-3 PAIRED CONTROL — the real frontend origins still pass", async () => {
    const ALLOWED = [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4096",
      "http://[::1]:4096",
      "tauri://localhost",
    ]
    for (const origin of ALLOWED) {
      const res = await call("GET", "/health", origin)
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 })
      // The wire keeps its existing `*` for allowed callers — the fence is a
      // REFUSAL, not a re-plumbing of every `jsonResponse` call site. What must
      // hold is that an allowed origin still gets a usable ACAO.
      expect({ origin, usable: res.acao !== null }).toEqual({ origin, usable: true })
    }
    const preflight = await call("OPTIONS", "/config", "http://localhost:5173")
    expect(preflight.status).toBe(204)
    expect(preflight.acao).toBe("http://localhost:5173")
    // ...and the preflight must NOT be a wildcard for a named origin, or the
    // allowlist would be decorative for credentialed requests.
    expect(preflight.acao).not.toBe("*")
  })

  test("X-4 PAIRED CONTROL — no Origin header is byte-identical (curl, same-origin)", async () => {
    const res = await call("GET", "/health", undefined)
    expect(res.status).toBe(200)
    expect(res.acao).toBe("*")
  })
})
