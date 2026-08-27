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
 *   X-9  The daemon port the fence trusts is the THREADED one (config /
 *        actually-bound), not `process.env.QUANTA_WEB_PORT`.
 *
 * ── HERMETICITY (this file reads NO ambient environment) ──────────────────
 * An earlier revision resolved the daemon port from `process.env` inside the
 * production fence, so these arms inherited whatever `QUANTA_WEB_PORT` the
 * shell happened to carry. MEASURED on that revision: bare → 16 pass / 0 fail,
 * but `QUANTA_WEB_PORT=5173` → 2 fail (X-3 + the size arm) and `=80` → 3 fail
 * (X-3, X-7, size). The fix is structural rather than a `withPort` wrapper: the
 * fence takes the port as an ARGUMENT, so every arm below names the port it is
 * asserting about and nothing here can be perturbed from outside. The only
 * block that touches the environment is X-9's e2e arm, which SETS a decoy
 * `QUANTA_WEB_PORT` (saved/restored) precisely to prove the fence ignores it.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { main } from "@/apps/web-daemon"
import { buildFetchHandler, type FetchHandlerDeps } from "@/apps/web-daemon/server/fetch-handler"
import { _allowedOriginsForTest, corsHeaders, isAllowedOrigin } from "@/apps/web-daemon/server/http"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { createStubRuntimeFactory } from "./fixture"

/** The port `index.ts` resolves to when nothing overrides it. Named here as a
 *  LITERAL rather than imported, so a change to the shipped default has to be
 *  restated in this file instead of silently tracking. */
const DEFAULT_DAEMON_PORT = 4096

const calls: string[] = []

/** Build the real route table for a daemon whose resolved port is `daemonPort`.
 *  `config.port` is the value `index.ts` threads down — the SAME field the
 *  production fence reads. */
const handlerFor = (daemonPort: number) =>
  buildFetchHandler({
    config: { authToken: undefined, port: daemonPort },
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
  opts: { readonly daemonPort?: number; readonly boundPort?: number } = {},
): Promise<{ status: number; acao: string | null }> => {
  const daemonPort = opts.daemonPort ?? DEFAULT_DAEMON_PORT
  // The second argument is the live `Bun.serve` handle. A bare `{}` is the
  // "handle carries no port" case (⇒ the fence falls back to `config.port`);
  // `boundPort` is the OS-picked / EADDRINUSE-fallback case, where the handle
  // knows a port the config never did.
  const srv = opts.boundPort === undefined ? {} : { port: opts.boundPort }
  const res = await handlerFor(daemonPort)(
    new Request(`http://127.0.0.1:${daemonPort}${path}`, {
      method,
      ...(origin === undefined ? {} : { headers: { origin } }),
    }),
    srv as never,
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
      `http://localhost:${DEFAULT_DAEMON_PORT}`,
      `http://[::1]:${DEFAULT_DAEMON_PORT}`,
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
    const res = await handlerFor(DEFAULT_DAEMON_PORT)(
      new Request(`http://127.0.0.1:${DEFAULT_DAEMON_PORT}${path}`, {
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
    const allowed = SPOOFS.filter((o) => isAllowedOrigin(o, DEFAULT_DAEMON_PORT))
    expect(allowed).toEqual([])
  })
})

/**
 * X-7 — HELLGATE: the fence does not isolate the daemon from OTHER LOCAL
 * SERVERS.
 *
 * The docstring above `LOOPBACK_ORIGIN_RE` claimed the allowlist was "exactly
 * the set the shipped frontends are served from". It was not: it was EVERY
 * loopback port. The daemon is tokenless by default, so a project's own
 * `localhost:3000` dev server — carrying, say, one compromised npm dependency in
 * its browser bundle — was an allowed origin and could read the full transcript
 * and POST /config. That is squarely "a page in the user's browser", the stated
 * threat.
 *
 * The allowlist must be the daemon's OWN port + the pinned Vite dev port +
 * Tauri, not every port. Asserted here against a daemon on the DEFAULT port, so
 * the portless `http://localhost` forms are foreign too (a daemon on :80 is a
 * different question — see X-8's portless arm).
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
    const allowed = FOREIGN_LOCAL.filter((o) => isAllowedOrigin(o, DEFAULT_DAEMON_PORT))
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
 * TRACKS the threaded port rather than a literal.
 */
describe("X-8 PAIRED CONTROL — the three shipped frontends still pass", () => {
  test("Vite dev (5173), the daemon's default port (4096) and Tauri all pass", async () => {
    const SHIPPED = [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      `http://localhost:${DEFAULT_DAEMON_PORT}`,
      `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
      `http://[::1]:${DEFAULT_DAEMON_PORT}`,
      "tauri://localhost",
      "https://tauri.localhost",
    ]
    const refused = SHIPPED.filter((o) => !isAllowedOrigin(o, DEFAULT_DAEMON_PORT))
    expect(refused).toEqual([])
    for (const origin of SHIPPED) {
      const res = await call("GET", "/health", origin)
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 })
    }
  })

  test("the daemon arm TRACKS the resolved port — a hardcoded 4096 fails here", () => {
    // The Tauri-shell shape: a random free port handed to the sidecar.
    expect(isAllowedOrigin("http://localhost:39117", 39117)).toBe(true)
    expect(isAllowedOrigin("http://127.0.0.1:39117", 39117)).toBe(true)
    // ...and the OLD default is no longer special once the daemon moved.
    expect(isAllowedOrigin("http://localhost:4096", 39117)).toBe(false)
    // The dev port is not port-dependent — it stays allowed.
    expect(isAllowedOrigin("http://localhost:5173", 39117)).toBe(true)
  })

  test("an unusable port degrades to a NARROWER set, it does not throw or open up", () => {
    // `resolveFencePort` is total. Whatever nonsense arrives — including the
    // `port: 0` sentinel, which is "let the OS choose" and not an origin — the
    // daemon arm simply drops out. Vite + Tauri survive; nothing widens.
    for (const bad of [0, -1, 70000, Number.NaN, 4096.5]) {
      expect({ bad, allowed: isAllowedOrigin("http://localhost:3000", bad) }).toEqual({
        bad,
        allowed: false,
      })
      expect({ bad, allowed: isAllowedOrigin("http://localhost:5173", bad) }).toEqual({
        bad,
        allowed: true,
      })
      expect({ bad, allowed: isAllowedOrigin("tauri://localhost", bad) }).toEqual({
        bad,
        allowed: true,
      })
    }
    // ...and specifically: a port-0 daemon mints NO `:0` origins. This used to be
    // a docstring claim the code did not implement (`parseDaemonPort` rejected
    // only `n < 0`, so `:0` produced six allowed origins). Not browser-reachable,
    // but a false statement in a list that advertises itself as measured.
    for (const origin of ["http://localhost:0", "http://127.0.0.1:0", "http://[::1]:0"]) {
      expect({ origin, allowed: isAllowedOrigin(origin, 0) }).toEqual({ origin, allowed: false })
    }
  })

  test("a daemon on :80 is allowed under the PORTLESS origin a browser emits", () => {
    expect(isAllowedOrigin("http://localhost", 80)).toBe(true)
    expect(isAllowedOrigin("http://127.0.0.1", 80)).toBe(true)
    // https is a DIFFERENT origin and port 80 says nothing about it.
    expect(isAllowedOrigin("https://localhost", 80)).toBe(false)
  })

  test("a daemon on :443 is allowed under its portless https origin, and not http", () => {
    expect(isAllowedOrigin("https://localhost", 443)).toBe(true)
    expect(isAllowedOrigin("https://127.0.0.1", 443)).toBe(true)
    expect(isAllowedOrigin("http://localhost", 443)).toBe(false)
  })

  /**
   * The SET, not just its yes/no answers.
   *
   * Enumerated as LITERALS rather than recomputed from the same loop the
   * production code uses — a mirror of `buildAllowedOrigins` would be green
   * against any widening it shared. Previously this arm asserted `size === 14`,
   * which is (a) not the invariant and (b) only true when the daemon port is
   * outside {5173, 80, 443}: at 5173 the two arms collapse to 8, at 80/443 the
   * portless spellings make 17. All three shapes are now stated outright.
   */
  const sorted = (o: Iterable<string>): string[] => [...o].sort()

  test("the resolved allowlist is a CLOSED, exactly-enumerated set — default port", () => {
    expect(sorted(_allowedOriginsForTest(DEFAULT_DAEMON_PORT))).toEqual(
      sorted([
        "http://localhost:4096",
        "http://127.0.0.1:4096",
        "http://[::1]:4096",
        "https://localhost:4096",
        "https://127.0.0.1:4096",
        "https://[::1]:4096",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        "https://[::1]:5173",
        "tauri://localhost",
        "https://tauri.localhost",
      ]),
    )
  })

  test("...a daemon ON the Vite port collapses to ONE loopback arm, not a wider set", () => {
    expect(sorted(_allowedOriginsForTest(5173))).toEqual(
      sorted([
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        "https://[::1]:5173",
        "tauri://localhost",
        "https://tauri.localhost",
      ]),
    )
  })

  test("...a daemon on :80 adds exactly the three portless http spellings", () => {
    expect(sorted(_allowedOriginsForTest(80))).toEqual(
      sorted([
        "http://localhost:80",
        "http://127.0.0.1:80",
        "http://[::1]:80",
        "https://localhost:80",
        "https://127.0.0.1:80",
        "https://[::1]:80",
        "http://localhost",
        "http://127.0.0.1",
        "http://[::1]",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        "https://[::1]:5173",
        "tauri://localhost",
        "https://tauri.localhost",
      ]),
    )
  })

  test("...and an unusable port leaves ONLY Vite + Tauri — never everything", () => {
    expect(sorted(_allowedOriginsForTest(null))).toEqual(
      sorted([
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        "https://[::1]:5173",
        "tauri://localhost",
        "https://tauri.localhost",
      ]),
    )
  })
})

/**
 * X-9 — HELLGATE: the fence tracked the WRONG PORT SOURCE, so a daemon could
 * fence out its OWN SPA.
 *
 * MEASURED before the fix, with `QUANTA_WEB_PORT` UNSET and the daemon booted as
 * `main({ port: 9000 })` — the programmatic-override shape used by the CLI's
 * embedded daemon, every `main({ port: 0 })` test, and `index.ts`'s own
 * EADDRINUSE fallback:
 *
 *   isAllowedOrigin("http://localhost:9000")  -> false
 *   isAllowedOrigin("http://127.0.0.1:9000")  -> false
 *   isAllowedOrigin("http://localhost:4096")  -> true    <-- the WRONG daemon
 *
 * `index.ts` resolved `overrides.port ?? QUANTA_WEB_PORT ?? 4096`; the fence
 * independently re-read `QUANTA_WEB_PORT` only. So the daemon served its SPA on
 * 9000, the browser put `Origin: http://localhost:9000` on every WS upgrade and
 * every `POST /config`, and the daemon's own fence answered 403.
 *
 * The two arms below are the two halves of the fix — the threaded config port,
 * and the actually-BOUND port when they differ — plus a live-daemon arm that
 * proves it through the real `Bun.serve` handler with a DECOY env set.
 */
describe("X-9 HELLGATE — the fence follows the daemon's real port, not the env", () => {
  test("the `main({ port })` override shape: the daemon's own SPA is allowed", async () => {
    const OVERRIDE = 9000
    expect(isAllowedOrigin(`http://localhost:${OVERRIDE}`, OVERRIDE)).toBe(true)
    expect(isAllowedOrigin(`http://127.0.0.1:${OVERRIDE}`, OVERRIDE)).toBe(true)
    expect(isAllowedOrigin(`http://[::1]:${OVERRIDE}`, OVERRIDE)).toBe(true)
    // ANTI-LAZY: "allow the default too, just in case" would be a second daemon
    // on the machine that is not this one.
    expect(isAllowedOrigin(`http://localhost:${DEFAULT_DAEMON_PORT}`, OVERRIDE)).toBe(false)
    // End-to-end through the real handler, not just the predicate.
    const own = await call("GET", "/health", `http://localhost:${OVERRIDE}`, {
      daemonPort: OVERRIDE,
    })
    expect(own.status).toBe(200)
    const foreign = await call("GET", "/health", `http://localhost:${DEFAULT_DAEMON_PORT}`, {
      daemonPort: OVERRIDE,
    })
    expect(foreign.status).toBe(403)
  })

  test("the OS-picked shape: the BOUND port wins over the requested one", async () => {
    // `main` retries with `port: 0` when the requested port is in use, and every
    // `main({ port: 0 })` caller lands here too: `config.port` is 0 (unusable)
    // while the SPA is served on a port only the live handle knows.
    const BOUND = 51234
    const own = await call("GET", "/health", `http://localhost:${BOUND}`, {
      daemonPort: 0,
      boundPort: BOUND,
    })
    expect(own.status).toBe(200)
    // ANTI-LAZY (allow-everything): another local server is still refused on the
    // very same request shape.
    const foreign = await call("GET", "/health", "http://localhost:3000", {
      daemonPort: 0,
      boundPort: BOUND,
    })
    expect(foreign.status).toBe(403)
    // ANTI-LAZY (refuse-everything): Vite and Tauri still pass here.
    for (const origin of ["http://localhost:5173", "tauri://localhost"]) {
      const res = await call("GET", "/health", origin, { daemonPort: 0, boundPort: BOUND })
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 })
    }
  })

  /**
   * The live arm. Boots the REAL daemon through `main()` on an explicit port
   * override while `QUANTA_WEB_PORT` carries a DECOY value, then drives it over
   * a real socket. This is the only environment-touching block in the file, and
   * the environment is the thing under test: the decoy's origin must be REFUSED
   * and the daemon's own must be ALLOWED, which is exactly backwards from the
   * measured pre-fix behaviour above.
   */
  describe("live daemon, decoy QUANTA_WEB_PORT", () => {
    const booted: WebDaemonHandle[] = []
    afterAll(async () => {
      for (const h of booted) await h.stop()
    })

    /** Ask the OS for a port nobody is on, then give it back. */
    const freePort = async (): Promise<number> => {
      const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
      const port = probe.port
      await probe.stop(true)
      // A loopback TCP listener always has one; an absent port here would mean
      // the probe never bound, and picking a fallback would silently test a port
      // we do not own.
      if (port === undefined) throw new Error("probe listener reported no port")
      return port
    }

    const statusFor = async (port: number, origin: string): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin } })
      return res.status
    }

    test("its own SPA origin is allowed; the env's port is refused", async () => {
      const port = await freePort()
      const DECOY = port === 4096 ? 4097 : 4096
      const prev = process.env.QUANTA_WEB_PORT
      process.env.QUANTA_WEB_PORT = String(DECOY)
      try {
        const { factory } = createStubRuntimeFactory()
        const handle = await main({ port, bind: "127.0.0.1", runtimeFactory: factory })
        booted.push(handle)
        // The override, not the env, is what got bound.
        expect(handle.port).toBe(port)
        // THE HELLGATE: the browser served this daemon's SPA sends this Origin.
        expect(await statusFor(handle.port, `http://localhost:${handle.port}`)).toBe(200)
        expect(await statusFor(handle.port, `http://127.0.0.1:${handle.port}`)).toBe(200)
        // The env's port is some OTHER server; it must not be trusted.
        expect(await statusFor(handle.port, `http://localhost:${DECOY}`)).toBe(403)
        // PAIRED CONTROLS — not refuse-everything, not allow-everything.
        expect(await statusFor(handle.port, "http://localhost:5173")).toBe(200)
        expect(await statusFor(handle.port, "tauri://localhost")).toBe(200)
        expect(await statusFor(handle.port, HOSTILE)).toBe(403)
        expect(await statusFor(handle.port, "http://localhost:3000")).toBe(403)
      } finally {
        if (prev === undefined) delete process.env.QUANTA_WEB_PORT
        else process.env.QUANTA_WEB_PORT = prev
      }
    })
  })
})

/**
 * X-10 — the CORS headers match what the docstring PROMISES.
 *
 * The `corsHeaders` docstring claimed an echoed origin means "credentialed
 * requests would work if the frontend ever adds `credentials: \"include\"`".
 * Measured 2026-08-28, that is false in both halves:
 *
 *     "http://localhost:5173" => {…,"access-control-allow-origin":"http://localhost:5173"}
 *     "http://evil.test"      => {…}                       (no ACAO — correct)
 *     null                    => {…,"access-control-allow-origin":"*"}
 *
 * No `access-control-allow-credentials` is emitted, and a browser DISCARDS a
 * credentialed response that lacks it — so a frontend following the docstring
 * would ship `credentials: "include"` and watch every request fail with a CORS
 * error that names the missing header, not the missing plan.
 *
 * The pin runs in BOTH directions on purpose. Granting credentials here is not
 * a one-line header: this allowlist admits `tauri://localhost` and every LAN
 * interface the daemon binds, and ACAO cannot be `*` alongside credentials at
 * all. So the arm fails if the echo is lost (breaking the dev server) AND if
 * ACAC appears (a much larger grant than it looks, made without re-reading the
 * allowlist above).
 */
describe("X-10 — CORS headers, as documented", () => {
  const reqWith = (origin: string | null): Request =>
    new Request("http://127.0.0.1:4096/x", origin === null ? {} : { headers: { origin } })

  test("X-10a an ALLOWED origin is echoed, never collapsed to `*`", () => {
    const h = corsHeaders(reqWith("http://localhost:5173"), 4096)
    expect(h["access-control-allow-origin"]).toBe("http://localhost:5173")
  })

  test("X-10b a DISALLOWED origin gets no ACAO at all", () => {
    const h = corsHeaders(reqWith("http://evil.test"), 4096)
    expect(h["access-control-allow-origin"]).toBeUndefined()
    // PAIRED CONTROL — refusing the ACAO is not refusing the whole header set;
    // `vary: Origin` must still be present or a shared cache will serve the
    // allowed origin's response to the hostile one.
    expect(h.vary).toBe("Origin")
  })

  test("X-10c an ABSENT origin keeps the historical `*`", () => {
    // curl and the CLI's own client send no Origin. CORS does not apply to
    // them, so `*` is inert rather than permissive — but it is what non-browser
    // callers have always received and removing it is a breaking change.
    expect(corsHeaders(reqWith(null), 4096)["access-control-allow-origin"]).toBe("*")
  })

  test("X-10d HELLGATE — credentialed CORS is NOT granted, for any origin", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost:4096",
      "tauri://localhost",
      "http://evil.test",
      null,
    ]) {
      const h = corsHeaders(reqWith(origin), 4096)
      expect({ origin, acac: h["access-control-allow-credentials"] }).toEqual({
        origin,
        acac: undefined,
      })
    }
  })
})
