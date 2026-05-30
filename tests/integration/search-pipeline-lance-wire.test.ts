import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
} from "@/../src/apps/agent/search-pipeline-wire"

const waitUntil = async (ready: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for Lance search wire activity")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("search pipeline Lance wire", () => {
  let dir = ""
  let prevFetch: typeof globalThis.fetch

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "search-lance-wire-"))
    prevFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = prevFetch
    clearSearchPipelineWireForTests()
    await rm(dir, { recursive: true, force: true })
  })

  test("QUANTA_VECTOR_STORE=lance wires semantic search through Lance REST upsert + query", async () => {
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "main.ts"), "export const alpha = 1\n")

    const calls: Array<{ url: string; method: string; body: unknown }> = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method as string | undefined) ?? "GET"
      const bodyRaw = init?.body as string | undefined
      const body = bodyRaw === undefined ? undefined : JSON.parse(bodyRaw)
      calls.push({ url: String(url), method, body })
      if (String(url).endsWith("/upsert")) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (String(url).endsWith("/delete")) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (String(url).endsWith("/query")) {
        return new Response(
          JSON.stringify({
            hits: [
              {
                id: "src/main.ts:1-1",
                score: 0.99,
                metadata: {
                  path: "src/main.ts",
                  startLine: 1,
                  endLine: 1,
                  text: "export const alpha = 1",
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response("missing", { status: 404 })
    }) as typeof globalThis.fetch

    const wired = buildSearchPipelineFromEnv(
      {
        QUANTA_INDEX: "on",
        QUANTA_PIPELINE: "semantic-only",
        QUANTA_INDEX_INTERVAL_MS: "1000000",
        QUANTA_INDEX_GLOB: "**/*.ts",
        QUANTA_EMBED_PROVIDER: "headless",
        QUANTA_VECTOR_STORE: "lance",
        QUANTA_LANCE_BASE_URL: "http://lance.test",
        QUANTA_LANCE_TABLE: "docs",
      },
      dir,
    )
    expect(wired).not.toBeNull()
    await waitUntil(() => calls.some((c) => c.url === "http://lance.test/v1/table/docs/upsert"))
    const r = await wired?.pipeline.search({ text: "alpha", k: 1 })
    expect(r?.ok).toBe(true)
    if (r?.ok) expect(r.value[0]?.metadata?.path).toBe("src/main.ts")
    expect(calls.some((c) => c.url === "http://lance.test/v1/table/docs/query")).toBe(true)
  })
})
