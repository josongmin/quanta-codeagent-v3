/** Direct HTTP boundary proof: bearer rejection happens before any auth route
 * handler (OAuth/file side effects) is invoked. */
import { describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { buildFetchHandler, type FetchHandlerDeps } from "@/apps/web-daemon/server/fetch-handler"
import type { WSData } from "@/apps/web-daemon/server/ws-data"

const handlerWith = (calls: string[]) =>
  buildFetchHandler({
    config: { authToken: "expected-token" },
    authRoutes: {
      login: async () => {
        calls.push("login")
        return new Response("unexpected")
      },
      loginStatus: async () => {
        calls.push("loginStatus")
        return new Response("unexpected")
      },
      logout: async () => {
        calls.push("logout")
        return new Response("unexpected")
      },
      status: async () => {
        calls.push("status")
        return new Response("unexpected")
      },
    },
  } as unknown as FetchHandlerDeps)

describe("HELLGATE web-daemon auth routes", () => {
  test("bad bearer returns 401 before every OAuth handler", async () => {
    const calls: string[] = []
    const fetch = handlerWith(calls)
    const routes = [
      ["POST", "/auth/login"],
      ["GET", "/auth/login/status?attempt=x"],
      ["POST", "/auth/logout"],
      ["GET", "/auth/status"],
    ] as const

    for (const [method, path] of routes) {
      const result = await fetch(
        new Request(`http://127.0.0.1:4096${path}`, {
          method,
          headers: { authorization: "Bearer wrong-token" },
        }),
        {} as Server<WSData>,
      )
      expect(result?.status, `${method} ${path}`).toBe(401)
    }
    expect(calls).toEqual([])
  })
})
