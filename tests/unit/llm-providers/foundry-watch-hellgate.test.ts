/**
 * ★ CONTRACT — ADR-0163 §foundry-watch:
 *   - `checkFoundrySdkAvailability()` NEVER throws. Worst case is
 *     `{installed:false, npmPublished:false}` (omitting `npmVersion`).
 *   - `installed` mirrors the adapter's `isFoundryAdapterReady()` predicate —
 *     today the package is unpublished, so it's false on the live path.
 *   - npm 404 ⇒ `npmPublished:false`, no `npmVersion`.
 *   - npm 200 with `dist-tags.latest` ⇒ `npmPublished:true` + `npmVersion`.
 *   - `fetcher` seam wins over global fetch.
 *   - Fetcher throw / network failure ⇒ graceful default (no rethrow).
 */
import { describe, expect, test } from "bun:test"
import { checkFoundrySdkAvailability, FOUNDRY_SDK_NPM_URL } from "@/llm/providers/foundry-watch"

/** Build a synthetic fetch that returns the supplied status + json body.
 *  Cast at the boundary — the real `typeof fetch` carries undocumented
 *  fields like `preconnect`, but the helper only ever invokes the call
 *  signature, so an `as unknown as typeof fetch` is honest narrowing. */
const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async (input: unknown) => {
    // Pin the URL the helper hits — proves we are routing at the correct
    // npm registry endpoint and not, say, the github mirror.
    const url = typeof input === "string" ? input : (input as { toString(): string }).toString()
    if (url !== FOUNDRY_SDK_NPM_URL) {
      throw new Error(`unexpected URL: ${url}`)
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

describe("foundry-watch — hellgate", () => {
  test("HELL-W1: npm 404 → both false, no npmVersion key", async () => {
    const r = await checkFoundrySdkAvailability({
      fetcher: fakeFetch(404, { error: "Not found" }),
    })
    expect(r.installed).toBe(false)
    expect(r.npmPublished).toBe(false)
    // exactOptional: the key MUST be absent (not `undefined`) when unknown.
    expect("npmVersion" in r).toBe(false)
  })

  test("HELL-W2: npm 200 with dist-tags.latest → published + version", async () => {
    const r = await checkFoundrySdkAvailability({
      fetcher: fakeFetch(200, {
        name: "@anthropic-ai/foundry-sdk",
        "dist-tags": { latest: "0.1.0" },
      }),
    })
    expect(r.npmPublished).toBe(true)
    expect(r.npmVersion).toBe("0.1.0")
    // `installed` still reflects the local resolve — the package is not in
    // node_modules even when the registry says it is published.
    expect(r.installed).toBe(false)
  })

  test("HELL-W3: fetcher injection wins — synthetic fetch is called, not global", async () => {
    let called = 0
    const fetcher = (async (input: unknown) => {
      called++
      const url = typeof input === "string" ? input : (input as { toString(): string }).toString()
      expect(url).toBe(FOUNDRY_SDK_NPM_URL)
      return new Response(JSON.stringify({ "dist-tags": { latest: "9.9.9" } }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const r = await checkFoundrySdkAvailability({ fetcher })
    expect(called).toBe(1)
    expect(r.npmPublished).toBe(true)
    expect(r.npmVersion).toBe("9.9.9")
  })

  test("HELL-W4: fetcher throws → graceful default (no rethrow)", async () => {
    const throwingFetch = (async () => {
      throw new Error("ENETUNREACH")
    }) as unknown as typeof fetch
    // The helper MUST NOT propagate. A status panel that crashes on offline
    // mode is worse than one that says "I don't know".
    const r = await checkFoundrySdkAvailability({ fetcher: throwingFetch })
    expect(r.installed).toBe(false)
    expect(r.npmPublished).toBe(false)
    expect("npmVersion" in r).toBe(false)
  })
})
