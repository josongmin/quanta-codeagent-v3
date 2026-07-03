/**
 * A2 (rich inline) — the injectable artifact-bytes fetch PORT.
 *
 * The rich inline renderers need the artifact bytes as text. That single
 * network touch is isolated behind `makeFetchText(fetchImpl)` so components take
 * a `fetchText(url) => Promise<string>` port they can be driven with a stub in a
 * DOM-free / network-free test. Here we verify the DEFAULT port's contract with
 * an injected `fetch` double (node vitest has no real `fetch`).
 */

import { describe, expect, it, vi } from "vitest"
import { makeFetchText } from "./artifact-fetch"

const okResponse = (body: string) =>
  ({ ok: true, status: 200, text: async () => body }) as unknown as Response

describe("makeFetchText — default artifact-bytes port", () => {
  it("resolves the response body text for a 2xx response", async () => {
    const fetchImpl = vi.fn(async () => okResponse("a,b\n1,2"))
    const fetchText = makeFetchText(fetchImpl as unknown as typeof fetch)
    await expect(fetchText("/artifact/x")).resolves.toBe("a,b\n1,2")
    expect(fetchImpl).toHaveBeenCalledWith("/artifact/x")
  })

  it("REJECTS on a non-2xx response (so the caller degrades to a download card)", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 404, text: async () => "" }) as unknown as Response,
    )
    const fetchText = makeFetchText(fetchImpl as unknown as typeof fetch)
    await expect(fetchText("/artifact/missing")).rejects.toThrow(/404/)
  })

  it("propagates a transport rejection (network down ⇒ caller degrades)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const fetchText = makeFetchText(fetchImpl as unknown as typeof fetch)
    await expect(fetchText("/artifact/x")).rejects.toThrow(/ECONNREFUSED/)
  })
})
