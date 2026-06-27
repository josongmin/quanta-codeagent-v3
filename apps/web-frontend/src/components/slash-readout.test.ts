import { afterEach, describe, expect, it, vi } from "vitest"
import { buildReadoutSlashCommands, READOUT_SLUGS } from "./slash-readout"

const realFetch = globalThis.fetch
const stubFetch = (impl: typeof fetch) => {
  globalThis.fetch = impl
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("buildReadoutSlashCommands", () => {
  it("fetches GET /readout/<name> with bearer auth and appends the output to the transcript", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const appended: string[] = []
    stubFetch(
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return {
          status: 200,
          json: async () => ({ name: "state", output: "session state\n  status        idle", wired: true, isError: false }),
        } as unknown as Response
      }) as unknown as typeof fetch,
    )
    const cmds = buildReadoutSlashCommands({
      httpUrl: "http://127.0.0.1:4096",
      token: "tok",
      appendSystem: (t) => appended.push(t),
    })
    const state = cmds.find((c) => c.slug === "state")
    expect(state).toBeDefined()
    await state?.action("")
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/readout/state")
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok")
    expect(appended[0]).toContain("session state")
  })

  it("still appends the graceful 'not wired' body for a pending readout (200, not an error)", async () => {
    const appended: string[] = []
    stubFetch(
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ name: "agents", output: "/agents: not wired in this web surface yet", wired: false, isError: false }),
      })) as unknown as typeof fetch,
    )
    const cmds = buildReadoutSlashCommands({ httpUrl: "http://h", appendSystem: (t) => appended.push(t) })
    await cmds.find((c) => c.slug === "agents")?.action("")
    expect(appended[0]).toContain("not wired")
  })

  it("routes a network failure to onError, not the transcript", async () => {
    const appended: string[] = []
    const errs: string[] = []
    stubFetch(
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    )
    const cmds = buildReadoutSlashCommands({
      httpUrl: "http://h",
      appendSystem: (t) => appended.push(t),
      onError: (m) => errs.push(m),
    })
    await cmds.find((c) => c.slug === "why")?.action("")
    expect(appended).toHaveLength(0)
    expect(errs[0]).toContain("why")
    expect(errs[0]).toContain("ECONNREFUSED")
  })

  it("omits the auth header when no token is configured", async () => {
    const calls: { init: RequestInit | undefined }[] = []
    stubFetch(
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ init })
        return { status: 200, json: async () => ({ output: "capabilities\n  tools yes" }) } as unknown as Response
      }) as unknown as typeof fetch,
    )
    const cmds = buildReadoutSlashCommands({ httpUrl: "http://h", appendSystem: () => {} })
    await cmds.find((c) => c.slug === "capabilities")?.action("")
    expect(calls[0]?.init?.headers).toEqual({})
  })

  it("READOUT_SLUGS matches the built command slugs (no drift)", () => {
    const cmds = buildReadoutSlashCommands({ httpUrl: "http://h", appendSystem: () => {} })
    expect([...cmds.map((c) => c.slug)].sort()).toEqual([...READOUT_SLUGS].sort())
  })
})
