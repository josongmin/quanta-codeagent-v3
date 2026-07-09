/**
 * UUX-4-13 (jul-10 W4) — OAuth login COMPLETION is observable over HTTP.
 *
 * Before: `/auth/login` returned the authorize URL and the background
 * exchange's outcome (success or failure) died in `logger.*` — the browser
 * could never learn whether the login actually completed.
 *
 * Now: every login start mints an ATTEMPT in a bounded registry; the
 * background flow marks it ok/failed; `GET /auth/login/status?attempt=<id>`
 * reads it back. The frontend's bounded poll turns that into a transcript
 * message.
 */

import { describe, expect, it } from "bun:test"
import {
  createLoginAttemptRegistry,
  handleAuthLoginAttemptStatus,
  handleAuthLoginStart,
  type LoginStartDeps,
} from "./auth-routes"

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>

/** Poll the registry until the attempt leaves `pending` (the background flow
 *  runs as a detached async task). Bounded — fails loudly instead of hanging. */
const settled = async (
  registry: ReturnType<typeof createLoginAttemptRegistry>,
  id: string,
): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 1))
    const view = registry.read(id)
    if (view !== undefined && view.state !== "pending") return view as Record<string, unknown>
  }
  throw new Error("attempt never settled")
}

describe("createLoginAttemptRegistry", () => {
  it("start → pending; succeed → ok with plan; fail → failed with error", () => {
    const reg = createLoginAttemptRegistry({ idFactory: () => "a1" })
    const id = reg.start()
    expect(id).toBe("a1")
    expect(reg.read(id)).toEqual({ state: "pending" })
    reg.succeed(id, "plus")
    expect(reg.read(id)).toEqual({ state: "ok", planType: "plus" })
    reg.fail(id, "boom")
    expect(reg.read(id)).toEqual({ state: "failed", error: "boom" })
  })

  it("BOUNDED: evicts the oldest attempt past the cap (no unbounded daemon map)", () => {
    let n = 0
    const reg = createLoginAttemptRegistry({
      cap: 2,
      idFactory: () => {
        n += 1
        return `a${n}`
      },
    })
    const first = reg.start()
    const second = reg.start()
    const third = reg.start()
    expect(reg.read(first)).toBeUndefined()
    expect(reg.read(second)).toEqual({ state: "pending" })
    expect(reg.read(third)).toEqual({ state: "pending" })
  })

  it("unknown id reads as undefined", () => {
    expect(createLoginAttemptRegistry().read("nope")).toBeUndefined()
  })
})

const makeDeps = (over: Partial<LoginStartDeps> = {}): LoginStartDeps => ({
  isConfigured: () => true,
  beginFlow: async (opener) => {
    opener("https://auth.example/authorize?x=1")
    return { planType: "plus" }
  },
  registry: createLoginAttemptRegistry({ idFactory: () => "att-1" }),
  ...over,
})

describe("handleAuthLoginStart — attempt lifecycle", () => {
  it("returns authorizeUrl + attemptId and the attempt settles OK when the flow completes", async () => {
    const deps = makeDeps()
    const res = await handleAuthLoginStart(deps)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.authorizeUrl).toBe("https://auth.example/authorize?x=1")
    expect(body.attemptId).toBe("att-1")
    expect(await settled(deps.registry, "att-1")).toEqual({ state: "ok", planType: "plus" })
  })

  it("a failure AFTER the URL was handed out lands in the attempt (was console-only)", async () => {
    const deps = makeDeps({
      beginFlow: async (opener) => {
        opener("https://auth.example/authorize?x=1")
        throw new Error("exchange_code 400")
      },
    })
    const res = await handleAuthLoginStart(deps)
    expect(res.status).toBe(200) // URL already delivered — HTTP contract unchanged
    expect(await settled(deps.registry, "att-1")).toEqual({
      state: "failed",
      error: "exchange_code 400",
    })
  })

  it("a failure BEFORE any URL keeps the 500 contract AND marks the attempt failed", async () => {
    const deps = makeDeps({
      beginFlow: async () => {
        throw new Error("loopback bind failed")
      },
    })
    const res = await handleAuthLoginStart(deps)
    expect(res.status).toBe(500)
    expect((await json(res)).error).toBe("login_setup_failed")
    expect(await settled(deps.registry, "att-1")).toEqual({
      state: "failed",
      error: "loopback bind failed",
    })
  })

  it("unconfigured client id keeps the existing 400 contract (no attempt minted)", async () => {
    const deps = makeDeps({ isConfigured: () => false })
    const res = await handleAuthLoginStart(deps)
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe("client_id_missing")
    expect(deps.registry.read("att-1")).toBeUndefined()
  })
})

describe("handleAuthLoginAttemptStatus — GET /auth/login/status", () => {
  const url = (attempt?: string): URL =>
    new URL(
      attempt === undefined
        ? "http://127.0.0.1:4096/auth/login/status"
        : `http://127.0.0.1:4096/auth/login/status?attempt=${attempt}`,
    )

  it("reads pending / ok / failed states back", async () => {
    const reg = createLoginAttemptRegistry({ idFactory: () => "att-2" })
    const id = reg.start()
    expect(await json(await handleAuthLoginAttemptStatus(url(id), reg))).toEqual({
      state: "pending",
    })
    reg.succeed(id, null)
    expect(await json(await handleAuthLoginAttemptStatus(url(id), reg))).toEqual({
      state: "ok",
      planType: null,
    })
    reg.fail(id, "boom")
    expect(await json(await handleAuthLoginAttemptStatus(url(id), reg))).toEqual({
      state: "failed",
      error: "boom",
    })
  })

  it("missing attempt param → 400; unknown attempt → 404", async () => {
    const reg = createLoginAttemptRegistry()
    expect((await handleAuthLoginAttemptStatus(url(undefined), reg)).status).toBe(400)
    const res = await handleAuthLoginAttemptStatus(url("ghost"), reg)
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe("unknown_attempt")
  })
})
