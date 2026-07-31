import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
} from "@/../src/apps/agent/search-pipeline-wire"

interface StoredDoc {
  readonly id: string
  readonly vector: readonly number[]
  readonly metadata: Readonly<Record<string, unknown>>
}

interface RecordedCall {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

interface LanceRestFixture {
  readonly baseURL: string
  readonly calls: RecordedCall[]
  resetCalls(): void
  tableIds(table: string): readonly string[]
  tableTexts(table: string): readonly string[]
  close(): Promise<void>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async <T>(
  ready: () => T | Promise<T>,
  timeoutMs = 5_000,
  label = "condition",
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await ready()
    if (value) return value
    await wait(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const dot = (a: readonly number[], b: readonly number[]): number => {
  let out = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) out += (a[i] ?? 0) * (b[i] ?? 0)
  return out
}

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const respond = (res: ServerResponse<IncomingMessage>, status: number, body: unknown): void => {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.setHeader("content-length", Buffer.byteLength(json))
  res.end(json)
}

const startLanceRestFixture = async (): Promise<LanceRestFixture> => {
  const calls: RecordedCall[] = []
  const tables = new Map<string, Map<string, StoredDoc>>()
  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET"
    const path = req.url ?? "/"
    const body = method === "POST" ? await readJsonBody(req) : undefined
    calls.push({ path, method, body })
    const parts = path.split("/").filter((part) => part.length > 0)
    if (method !== "POST" || parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "table") {
      respond(res, 404, { error: "not-found" })
      return
    }
    const table = decodeURIComponent(parts[2] ?? "")
    const action = parts[3]
    const docs = tables.get(table) ?? new Map<string, StoredDoc>()
    tables.set(table, docs)
    if (action === "upsert") {
      const items = Array.isArray((body as { docs?: unknown[] }).docs)
        ? ((body as { docs: unknown[] }).docs as StoredDoc[])
        : []
      for (const doc of items) {
        docs.set(doc.id, {
          id: doc.id,
          vector: [...doc.vector],
          metadata: { ...(doc.metadata ?? {}) },
        })
      }
      respond(res, 200, { ok: true })
      return
    }
    if (action === "delete") {
      const ids = Array.isArray((body as { ids?: unknown[] }).ids)
        ? ((body as { ids: unknown[] }).ids as string[])
        : []
      for (const id of ids) docs.delete(id)
      respond(res, 200, { ok: true })
      return
    }
    if (action === "query") {
      const vector = Array.isArray((body as { vector?: unknown[] }).vector)
        ? (((body as { vector: unknown[] }).vector as number[]).map((v) => Number(v)) as number[])
        : []
      const kRaw = (body as { k?: unknown }).k
      const k = typeof kRaw === "number" ? kRaw : 10
      const hits = [...docs.values()]
        .map((doc) => ({
          id: doc.id,
          score: dot(doc.vector, vector),
          metadata: doc.metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
      respond(res, 200, { hits })
      return
    }
    respond(res, 404, { error: "unknown-action" })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    calls,
    resetCalls() {
      calls.length = 0
    },
    tableIds(table: string): readonly string[] {
      return [...(tables.get(table)?.keys() ?? [])].sort()
    },
    tableTexts(table: string): readonly string[] {
      return [...(tables.get(table)?.values() ?? [])]
        .map((doc) => String(doc.metadata.text ?? ""))
        .sort()
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) reject(err)
          else resolve()
        })
      })
    },
  }
}

const exportLines = (prefix: string, count: number): string =>
  `${Array.from(
    { length: count },
    (_, i) => `export const ${prefix}_${String(i + 1).padStart(3, "0")} = ${i + 1}`,
  ).join("\n")}\n`

const expectedInitialIds = [
  "src/main.ts:1-50",
  "src/main.ts:31-80",
  "src/main.ts:61-110",
  "src/main.ts:91-120",
]

const deleteIds = (call: RecordedCall): readonly string[] => {
  const ids = (call.body as { ids?: unknown[] }).ids
  return Array.isArray(ids) ? (ids as string[]) : []
}

const rewriteTextSeen = (call: RecordedCall): boolean => {
  const docs = (call.body as { docs?: Array<{ metadata?: { text?: unknown } }> }).docs
  return Array.isArray(docs) && docs[0]?.metadata?.text === "export const gamma = 3"
}

describe("search pipeline Lance wire", () => {
  let dir = ""
  let fixture: LanceRestFixture | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "search-lance-wire-"))
    fixture = await startLanceRestFixture()
  })

  afterEach(async () => {
    clearSearchPipelineWireForTests()
    if (fixture !== null) await fixture.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("QUANTA_VECTOR_STORE=lance drives upsert, query, rewrite, and stale delete through the live wire", async () => {
    if (fixture === null) throw new Error("fixture missing")
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "main.ts"), exportLines("alpha", 120))

    const wired = buildSearchPipelineFromEnv(
      {
        QUANTA_INDEX: "on",
        QUANTA_PIPELINE: "semantic-only",
        QUANTA_INDEX_INTERVAL_MS: "200",
        QUANTA_INDEX_GLOB: "**/*.ts",
        QUANTA_EMBED_PROVIDER: "headless",
        QUANTA_VECTOR_STORE: "lance",
        QUANTA_LANCE_BASE_URL: fixture.baseURL,
        QUANTA_LANCE_TABLE: "docs",
      },
      dir,
    )
    expect(wired).not.toBeNull()

    await waitUntil(
      () => (fixture?.tableIds("docs").length === 4 ? fixture.tableIds("docs") : null),
      10_000,
      "initial Lance upserts",
    )
    expect(fixture.tableIds("docs")).toEqual(expectedInitialIds)

    const initial = await wired?.pipeline.search({ text: "alpha_001", k: 1 })
    expect(initial?.ok).toBe(true)
    if (initial?.ok) expect(initial.value[0]?.metadata?.path).toBe("src/main.ts")

    await wait(25)
    await writeFile(join(dir, "src", "main.ts"), "export const gamma = 3\n")

    const rewrite = await waitUntil(
      () => {
        const deleteCall = fixture?.calls.find((call) => call.path === "/v1/table/docs/delete")
        const rewriteCall = fixture?.calls.find(
          (call) => call.path === "/v1/table/docs/upsert" && rewriteTextSeen(call),
        )
        if (deleteCall === undefined || rewriteCall === undefined) return null
        const ids = fixture?.tableIds("docs") ?? []
        return ids.length === 1 && ids[0] === "src/main.ts:1-1" ? { deleteCall, rewriteCall } : null
      },
      10_000,
      "rewrite delete + single-chunk upsert",
    )
    if (rewrite === null) throw new Error("unreachable")

    expect([...deleteIds(rewrite.deleteCall)].sort()).toEqual(expectedInitialIds)
    expect(fixture.tableTexts("docs")).toEqual(["export const gamma = 3"])

    const afterRewrite = await wired?.pipeline.search({ text: "gamma", k: 1 })
    expect(afterRewrite?.ok).toBe(true)
    if (afterRewrite?.ok) expect(afterRewrite.value[0]?.metadata?.path).toBe("src/main.ts")
  })

  test("QUANTA_INDEX_DB_PATH keeps the Lance manifest restart-safe across wire rebuilds", async () => {
    if (fixture === null) throw new Error("fixture missing")
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "main.ts"), exportLines("alpha", 120))
    const dbPath = join(dir, "manifest.sqlite")

    const env = {
      QUANTA_INDEX: "on",
      QUANTA_PIPELINE: "semantic-only",
      QUANTA_INDEX_INTERVAL_MS: "200",
      QUANTA_INDEX_GLOB: "**/*.ts",
      QUANTA_EMBED_PROVIDER: "headless",
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: fixture.baseURL,
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_INDEX_DB_PATH: dbPath,
    }

    const firstWire = buildSearchPipelineFromEnv(env, dir)
    expect(firstWire).not.toBeNull()
    await waitUntil(
      () => (fixture?.tableIds("docs").length === 4 ? true : null),
      10_000,
      "initial persisted-manifest upserts",
    )
    expect(fixture.tableIds("docs")).toEqual(expectedInitialIds)

    clearSearchPipelineWireForTests()
    fixture.resetCalls()

    await wait(25)
    await writeFile(join(dir, "src", "main.ts"), "export const gamma = 3\n")

    const secondWire = buildSearchPipelineFromEnv(env, dir)
    expect(secondWire).not.toBeNull()
    const deleteCall = await waitUntil(
      () => {
        const call = fixture?.calls.find((entry) => entry.path === "/v1/table/docs/delete")
        if (call === undefined) return null
        const ids = fixture?.tableIds("docs") ?? []
        return ids.length === 1 && ids[0] === "src/main.ts:1-1" ? call : null
      },
      10_000,
      "restart-safe stale delete",
    )
    if (deleteCall === null) throw new Error("unreachable")

    expect([...deleteIds(deleteCall)].sort()).toEqual(expectedInitialIds)
    expect(fixture.tableTexts("docs")).toEqual(["export const gamma = 3"])

    const query = await secondWire?.pipeline.search({ text: "gamma", k: 1 })
    expect(query?.ok).toBe(true)
    if (query?.ok) expect(query.value[0]?.metadata?.path).toBe("src/main.ts")
  })
})
