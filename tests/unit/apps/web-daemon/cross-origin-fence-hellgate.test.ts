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
 *        the daemon's own port, and the Tauri origin all pass. (This used to
 *        read "a loopback origin on any port" — see X-7/X-8: any-port was the
 *        defect, not the contract.)
 *   X-4  PAIRED CONTROL — a request with NO `Origin` header (curl, the CLI's
 *        own client, a same-origin fetch) is unaffected. This is the
 *        byte-identity arm: non-browser callers must not need a new header.
 */

import { describe, expect, test } from "bun:test"
import { buildFetchHandler, type FetchHandlerDeps } from "@/apps/web-daemon/server/fetch-handler"
import { _allowedOriginsForTest, isAllowedOrigin } from "@/apps/web-daemon/server/http"

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

/**
 * X-5 — the WS UPGRADE half.
 *
 * Why a WebSocket needs its own arms: it is EXEMPT from the same-origin policy,
 * so none of the CORS answers above constrain it. On a tokenless daemon any page
 * can open `ws://127.0.0.1:<port>/ws` and drive `turn.run`.
 *
 * MEASURED, and worth stating precisely because it is easy to get backwards:
 * deleting the `isAllowedOrigin` call from `makeTryUpgrade` does NOT turn these
 * arms red. That is not a hole in this block — `buildFetchHandler` runs the same
 * fence at the top of the handler, before ANY route, and the upgrade is only
 * reached through `serveUpgradeOrStatic` at the very bottom. So the in-upgrade
 * check is defense-in-depth, and the arms below pin the OBSERVABLE behaviour
 * (refused before `server.upgrade` is called) rather than which of the two
 * checks produced it. Delete BOTH and they go red.
 */
describe("X-5 the WS upgrade refuses a foreign origin", () => {
  // Past the fence, `makeTryUpgrade` calls `server.upgrade`. The stub records
  // whether it was reached: that is the observable that separates "the fence
  // refused" from "the fence let it through", and it is what the mutant this
  // block exists for would flip.
  let upgradeCalls = 0
  const srv = {
    upgrade: (): boolean => {
      upgradeCalls += 1
      return true
    },
  }

  const upgrade = async (
    path: string,
    origin?: string,
  ): Promise<{ status: number | null; acao: string | null; reached: boolean }> => {
    upgradeCalls = 0
    const res = await handler()(
      new Request(`http://127.0.0.1:4096${path}`, {
        method: "GET",
        headers: { upgrade: "websocket", ...(origin === undefined ? {} : { origin }) },
      }),
      srv as never,
    )
    // `undefined` means Bun consumed the request after a successful upgrade.
    const r = res === undefined ? null : res
    return {
      status: r === null ? null : r.status,
      acao: r === null ? null : r.headers.get("access-control-allow-origin"),
      reached: upgradeCalls > 0,
    }
  }

  for (const path of ["/", "/ws"]) {
    test(`${path} with a hostile Origin is refused, and hands out no ACAO`, async () => {
      const r = await upgrade(path, HOSTILE)
      expect({ path, status: r.status }).toEqual({ path, status: 403 })
      expect(r.acao).toBeNull()
      // The refusal happens BEFORE the upgrade, not after it.
      expect({ path, reached: r.reached }).toEqual({ path, reached: false })
    })
  }

  test("PAIRED CONTROL — an allowed origin is NOT refused by the fence", async () => {
    // It must get past the origin check. What happens after (the real
    // `server.upgrade`) is Bun's, and this stub cannot perform it — so the only
    // assertion that belongs here is "not the fence's 403".
    for (const origin of ["http://localhost:5173", "tauri://localhost"]) {
      const r = await upgrade("/ws", origin)
      expect({ origin, refused: r.status === 403 }).toEqual({ origin, refused: false })
      expect({ origin, reached: r.reached }).toEqual({ origin, reached: true })
    }
  })

  test("PAIRED CONTROL — no Origin header still reaches the upgrade path", async () => {
    const r = await upgrade("/ws", undefined)
    expect(r.status).not.toBe(403)
    expect(r.reached).toBe(true)
  })
})

/**
 * X-6 — the PARSING half, re-measured.
 *
 * Before changing the allowlist's SET, pin that the host-matching itself has no
 * spoofing hole: a hostile registrable domain that merely CONTAINS a loopback
 * label (`localhost.evil.com`), an authority-confusing userinfo form
 * (`localhost@evil.com`), an integer-encoded loopback (`2130706433`), the
 * IPv4-mapped IPv6 form, case variation, and the trailing-dot FQDN form must all
 * be refused. These arms are the CONTROL for the narrowing below: if narrowing
 * ever regresses to a substring/`startsWith` test, they go red.
 */
describe("X-6 origin PARSING has no spoofing hole", () => {
  const SPOOFS = [
    "http://localhost.evil.com",
    "https://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://localhost@evil.com",
    "http://evil.com#http://localhost",
    "http://evil.com?http://localhost",
    "http://2130706433",
    "http://0x7f000001",
    "http://017700000001",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:7f00:1]",
    "http://LOCALHOST.EVIL.COM",
    "http://localhost.",
    "http://127.0.0.1.",
    "http://localhost:5173.evil.com",
    "http://evil.com:5173",
    "https://evil.com",
    "null",
    "file://",
    "data:text/html,x",
    "http://localhost%2eevil.com",
    "http://xn--localhost-evil.com",
    "ftp://localhost",
    "ws://localhost:5173",
    "http://localhost:5173/",
    "http://localhost:5173 ",
    " http://localhost:5173",
    "http://127.1",
    "http://127.0.1",
    "http://[0:0:0:0:0:0:0:1]",
  ]

  test("every spoofing shape is refused by the real export", () => {
    const allowed = SPOOFS.filter((o) => isAllowedOrigin(o))
    expect(allowed).toEqual([])
  })
})

/**
 * X-7 — HELLGATE: the fence does not isolate the daemon from OTHER LOCAL
 * SERVERS.
 *
 * The docstring above `LOOPBACK_ORIGIN_RE` claims the allowlist is "exactly the
 * set the shipped frontends are served from". It is not: it is EVERY loopback
 * port. The daemon is tokenless by default, so a project's own `localhost:3000`
 * dev server — carrying, say, one compromised npm dependency in its browser
 * bundle — is an allowed origin and can read the full transcript and POST
 * /config. That is squarely "a page in the user's browser", the stated threat.
 *
 * The allowlist must be the daemon's OWN port + the pinned Vite dev port +
 * Tauri, not every port.
 */
describe("X-7 HELLGATE — a foreign LOCAL origin is not an allowed origin", () => {
  const FOREIGN_LOCAL = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8888",
    "http://[::1]:9229",
    "http://localhost",
    "http://127.0.0.1",
  ]

  test("a different local server's origin is refused by the export", () => {
    const allowed = FOREIGN_LOCAL.filter((o) => isAllowedOrigin(o))
    expect(allowed).toEqual([])
  })

  test("a different local server is refused end-to-end on an effectful route", async () => {
    calls.length = 0
    const res = await call("POST", "/config", "http://localhost:3000")
    expect(res.status).toBe(403)
    expect(res.acao).toBeNull()
    expect(calls).toEqual([])
  })
})

/**
 * X-8 — PAIRED CONTROL for the narrowing.
 *
 * X-7 is satisfiable the lazy way twice over, and both mutants are worse than
 * the bug:
 *   - refuse EVERY loopback origin  ⇒ the shipped frontends break;
 *   - hardcode 4096                 ⇒ the Tauri shell, which spawns the sidecar
 *     on a RANDOM free port and passes it as `QUANTA_WEB_PORT`
 *     (`apps/tauri-shell/src/daemon.rs`), breaks in production while every
 *     default-port test stays green.
 * So this block pins all three shipped frontends AND pins that the daemon arm
 * TRACKS the env rather than a literal.
 */
describe("X-8 PAIRED CONTROL — the three shipped frontends still pass", () => {
  const withPort = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.QUANTA_WEB_PORT
    if (value === undefined) delete process.env.QUANTA_WEB_PORT
    else process.env.QUANTA_WEB_PORT = value
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.QUANTA_WEB_PORT
      else process.env.QUANTA_WEB_PORT = prev
    }
  }

  test("Vite dev (5173), the daemon's default port (4096) and Tauri all pass", async () => {
    await withPort(undefined, async () => {
      const SHIPPED = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4096",
        "http://127.0.0.1:4096",
        "http://[::1]:4096",
        "tauri://localhost",
        "https://tauri.localhost",
      ]
      const refused = SHIPPED.filter((o) => !isAllowedOrigin(o))
      expect(refused).toEqual([])
      for (const origin of SHIPPED) {
        const res = await call("GET", "/health", origin)
        expect({ origin, status: res.status }).toEqual({ origin, status: 200 })
      }
    })
  })

  test("the daemon arm TRACKS QUANTA_WEB_PORT — a hardcoded 4096 fails here", async () => {
    await withPort("39117", async () => {
      // The Tauri-shell shape: a random free port handed to the sidecar.
      expect(isAllowedOrigin("http://localhost:39117")).toBe(true)
      expect(isAllowedOrigin("http://127.0.0.1:39117")).toBe(true)
      // ...and the OLD default is no longer special once the daemon moved.
      expect(isAllowedOrigin("http://localhost:4096")).toBe(false)
      // The dev port is not port-dependent — it stays allowed.
      expect(isAllowedOrigin("http://localhost:5173")).toBe(true)
    })
  })

  test("an unparseable QUANTA_WEB_PORT degrades to the default, it does not throw or open up", async () => {
    await withPort("not-a-port", async () => {
      expect(isAllowedOrigin("http://localhost:4096")).toBe(true)
      expect(isAllowedOrigin("http://localhost:3000")).toBe(false)
    })
  })

  test("a daemon on :80 is allowed under the PORTLESS origin a browser emits", async () => {
    await withPort("80", async () => {
      expect(isAllowedOrigin("http://localhost")).toBe(true)
      expect(isAllowedOrigin("http://127.0.0.1")).toBe(true)
      // https is a DIFFERENT origin and port 80 says nothing about it.
      expect(isAllowedOrigin("https://localhost")).toBe(false)
    })
  })

  test("the resolved allowlist is a CLOSED set, not a pattern", () => {
    const set = _allowedOriginsForTest()
    // 2 ports x 3 hosts x 2 schemes + 2 tauri = 14, with no port-80/443 extras
    // at the default port. Pinning the SIZE is what makes a future widening
    // (a regex creeping back in) visible rather than silent.
    expect(set.size).toBe(14)
  })
})
