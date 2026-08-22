import { afterAll, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
} from "@/../src/apps/agent/search-pipeline-wire"
import { requireContract } from "./_guard"

const PYTHON_CANDIDATES = [
  process.env.QUANTA_LANCE_PYTHON,
  "/opt/homebrew/opt/python@3.11/Frameworks/Python.framework/Versions/3.11/bin/python3.11",
  "python3",
  "python",
].filter((value): value is string => value !== undefined && value !== "")

const probePython = async (command: string): Promise<boolean> => {
  try {
    const proc = Bun.spawn([command, "-c", "import lancedb"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    const exit = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5_000)),
    ])
    try {
      proc.kill()
    } catch {
      // already exited
    }
    return exit === 0
  } catch {
    return false
  }
}

const resolvePython = async (): Promise<string | null> => {
  for (const command of PYTHON_CANDIDATES) {
    if (await probePython(command)) return command
  }
  return null
}

const python = await resolvePython()
const available = requireContract("python+lancedb", python !== null)

const tmpDirs: string[] = []
const makeTmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-lance-contract-"))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  clearSearchPipelineWireForTests()
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async <T>(
  ready: () => T | Promise<T>,
  timeoutMs = 10_000,
  label = "condition",
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await ready()
    if (value) return value
    await wait(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const parseJsonLines = <T>(raw: string): T[] => {
  const lines = raw.split("\n")
  const complete = raw.endsWith("\n") ? lines : lines.slice(0, -1)
  const out: T[] = []
  for (const line of complete) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    out.push(JSON.parse(trimmed) as T)
  }
  return out
}

const nextPort = async (): Promise<number> => {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failed to allocate port")
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err !== undefined) reject(err)
      else resolve()
    })
  })
  return port
}

const readLog = (path: string): ReadonlyArray<{ path: string; body: unknown }> => {
  return parseJsonLines<{ path: string; body: unknown }>(readFileSync(path, "utf8"))
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

const buildWireEnv = (baseURL: string, manifestPath?: string): Record<string, string> => {
  const env: Record<string, string> = {
    QUANTA_INDEX: "on",
    QUANTA_PIPELINE: "semantic-only",
    QUANTA_INDEX_INTERVAL_MS: "200",
    QUANTA_INDEX_GLOB: "**/*.ts",
    QUANTA_EMBED_PROVIDER: "headless",
    QUANTA_VECTOR_STORE: "lance",
    QUANTA_LANCE_BASE_URL: baseURL,
    QUANTA_LANCE_TABLE: "docs",
  }
  if (manifestPath !== undefined) env.QUANTA_INDEX_DB_PATH = manifestPath
  return env
}

const deleteIds = (entry: { body: unknown }): readonly string[] => {
  const ids = (entry.body as { ids?: unknown[] }).ids
  return Array.isArray(ids) ? (ids as string[]) : []
}

const rewriteTextSeen = (entry: { body: unknown }): boolean => {
  const docs = (entry.body as { docs?: Array<{ metadata?: { text?: unknown } }> }).docs
  return Array.isArray(docs) && docs[0]?.metadata?.text === "export const gamma = 3"
}

const startLanceShim = async (
  pythonCommand: string,
  dbDir: string,
  logPath: string,
): Promise<{ readonly baseURL: string; stop(): Promise<void> }> => {
  const port = await nextPort()
  const scriptPath = join(makeTmpDir(), "lance-rest-shim.py")
  writeFileSync(
    scriptPath,
    [
      "import json",
      "import os",
      "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
      "from urllib.parse import unquote, urlparse",
      "import lancedb",
      "PORT = int(os.environ['PORT'])",
      "DB_DIR = os.environ['DB_DIR']",
      "LOG_PATH = os.environ['LOG_PATH']",
      "db = lancedb.connect(DB_DIR)",
      "def q(s):",
      '    return s.replace("\'", "\'\'")',
      "def table_names():",
      "    return set(db.table_names())",
      "def ensure_table(name, docs):",
      "    if name in table_names():",
      "        return db.open_table(name)",
      "    if not docs:",
      "        return None",
      "    return db.create_table(name, data=docs)",
      "def open_table(name):",
      "    if name not in table_names():",
      "        return None",
      "    return db.open_table(name)",
      "def delete_ids(table, ids):",
      "    if not ids:",
      "        return",
      "    joined = ', '.join(f\"'{q(v)}'\" for v in ids)",
      '    table.delete(f"id IN ({joined})")',
      "def normalize_doc(doc):",
      "    meta = doc.get('metadata') or {}",
      "    return {",
      "        'id': doc['id'],",
      "        'vector': [float(x) for x in doc['vector']],",
      "        'metadata_json': json.dumps(meta, ensure_ascii=False, sort_keys=True),",
      "    }",
      "class Handler(BaseHTTPRequestHandler):",
      "    def log_message(self, format, *args):",
      "        return",
      "    def _send(self, status, payload):",
      "        body = json.dumps(payload).encode()",
      "        self.send_response(status)",
      "        self.send_header('content-type', 'application/json')",
      "        self.send_header('content-length', str(len(body)))",
      "        self.end_headers()",
      "        self.wfile.write(body)",
      "    def do_POST(self):",
      "        parsed = urlparse(self.path)",
      "        parts = [p for p in parsed.path.split('/') if p]",
      "        length = int(self.headers.get('content-length', '0'))",
      "        raw = self.rfile.read(length)",
      "        body = json.loads(raw or b'{}')",
      "        with open(LOG_PATH, 'a', encoding='utf-8') as f:",
      "            f.write(json.dumps({'path': parsed.path, 'body': body}, ensure_ascii=False) + '\\n')",
      "        if len(parts) != 4 or parts[:2] != ['v1', 'table']:",
      "            self._send(404, {'error': 'not-found'})",
      "            return",
      "        table_name = unquote(parts[2])",
      "        action = parts[3]",
      "        try:",
      "            if action == 'upsert':",
      "                docs = [normalize_doc(doc) for doc in body.get('docs', [])]",
      "                table = ensure_table(table_name, docs)",
      "                if table is None:",
      "                    self._send(200, {'ok': True})",
      "                    return",
      "                delete_ids(table, [doc['id'] for doc in docs])",
      "                if docs:",
      "                    table.add(docs)",
      "                self._send(200, {'ok': True})",
      "                return",
      "            table = open_table(table_name)",
      "            if table is None:",
      "                if action == 'query':",
      "                    self._send(200, {'hits': []})",
      "                    return",
      "                if action == 'delete':",
      "                    self._send(200, {'ok': True})",
      "                    return",
      "                self._send(404, {'error': 'table-not-found'})",
      "                return",
      "            if action == 'query':",
      "                vector = [float(x) for x in body.get('vector', [])]",
      "                k = int(body.get('k', 10))",
      "                rows = table.search(vector).limit(k).to_list()",
      "                hits = []",
      "                for row in rows:",
      "                    meta = json.loads(row.get('metadata_json') or '{}')",
      "                    hits.append({'id': row['id'], 'score': float(1.0 / (1.0 + float(row.get('_distance', 0.0)))), 'metadata': meta})",
      "                self._send(200, {'hits': hits})",
      "                return",
      "            if action == 'delete':",
      "                delete_ids(table, [str(v) for v in body.get('ids', [])])",
      "                self._send(200, {'ok': True})",
      "                return",
      "            self._send(404, {'error': 'unknown-action'})",
      "        except Exception as e:",
      "            self._send(500, {'error': type(e).__name__, 'detail': str(e)})",
      "server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)",
      "server.serve_forever()",
    ].join("\n"),
    "utf8",
  )

  const proc = Bun.spawn([pythonCommand, scriptPath], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_DIR: dbDir,
      LOG_PATH: logPath,
    },
    stdout: "ignore",
    stderr: "ignore",
  })

  await waitUntil(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${port}`)
        return true
      } catch {
        return false
      }
    },
    10_000,
    "real Lance shim listen",
  )

  return {
    baseURL: `http://127.0.0.1:${port}`,
    async stop() {
      try {
        proc.kill()
      } catch {
        // already exited
      }
      await proc.exited.catch(() => undefined)
    },
  }
}

const inspectRealTable = (
  pythonCommand: string,
  dbDir: string,
): { rowCount: number; ids: string[]; texts: string[] } => {
  const proc = Bun.spawnSync(
    [
      pythonCommand,
      "-c",
      [
        "import json, os, lancedb",
        "db = lancedb.connect(os.environ['DB_DIR'])",
        "tbl = db.open_table('docs')",
        "rows = tbl.to_arrow().to_pylist()",
        "print(json.dumps({",
        "  'rowCount': tbl.count_rows(),",
        "  'ids': sorted(row['id'] for row in rows),",
        "  'texts': [json.loads(row['metadata_json'])['text'] for row in rows],",
        "}))",
      ].join("\n"),
    ],
    { env: { ...process.env, DB_DIR: dbDir } },
  )
  if (proc.exitCode !== 0) {
    throw new Error(`real Lance inspect failed: ${proc.stderr.toString()}`)
  }
  return JSON.parse(proc.stdout.toString()) as { rowCount: number; ids: string[]; texts: string[] }
}

describe("search pipeline Lance wire (real LanceDB backing via compatible REST shim)", () => {
  if (!available || python === null) {
    test.skip("python+lancedb unavailable — skipping real LanceDB-backed shim round trip", () => {})
    return
  }

  test("real Lance-backed wire rewrites a multi-chunk file down to one chunk and deletes stale ids", async () => {
    const root = makeTmpDir()
    const workspace = join(root, "workspace")
    const dbDir = join(root, "db")
    const logPath = join(root, "lance-rest.jsonl")
    mkdirSync(join(workspace, "src"), { recursive: true })
    mkdirSync(dbDir, { recursive: true })
    writeFileSync(logPath, "", "utf8")
    const shim = await startLanceShim(python, dbDir, logPath)
    try {
      writeFileSync(join(workspace, "src", "main.ts"), exportLines("alpha", 120), "utf8")

      const wired = buildSearchPipelineFromEnv(buildWireEnv(shim.baseURL), workspace)
      expect(wired).not.toBeNull()

      await waitUntil(
        () => {
          const entries = readLog(logPath)
          return entries.filter((entry) => entry.path === "/v1/table/docs/upsert").length >= 4
        },
        15_000,
        "initial real Lance upserts",
      )

      const first = await wired?.pipeline.search({ text: "alpha_001", k: 1 })
      expect(first?.ok).toBe(true)
      if (first?.ok) expect(first.value[0]?.metadata?.path).toBe("src/main.ts")

      await wait(25)
      writeFileSync(join(workspace, "src", "main.ts"), "export const gamma = 3\n", "utf8")

      await waitUntil(
        () => {
          const entries = readLog(logPath)
          const sawRewrite = entries.some(
            (entry) =>
              entry.path === "/v1/table/docs/upsert" &&
              (entry.body as { docs?: Array<{ metadata?: { text?: unknown } }> }).docs?.[0]
                ?.metadata?.text === "export const gamma = 3",
          )
          const sawDelete = entries.some((entry) => entry.path === "/v1/table/docs/delete")
          return sawRewrite && sawDelete
        },
        15_000,
        "real Lance rewrite delete + upsert",
      )

      const second = await wired?.pipeline.search({ text: "gamma", k: 1 })
      expect(second?.ok).toBe(true)
      if (second?.ok) expect(second.value[0]?.metadata?.path).toBe("src/main.ts")

      const entries = readLog(logPath)
      const deleteCall = entries.find((entry) => entry.path === "/v1/table/docs/delete")
      expect(deleteCall).toBeDefined()
      if (deleteCall !== undefined) {
        expect([...deleteIds(deleteCall)].sort()).toEqual(expectedInitialIds)
      }

      const table = inspectRealTable(python, dbDir)
      expect(table.rowCount).toBe(1)
      expect(table.ids).toEqual(["src/main.ts:1-1"])
      expect(table.texts).toEqual(["export const gamma = 3"])
    } finally {
      clearSearchPipelineWireForTests()
      await shim.stop()
    }
  }, 30_000)

  test("real Lance-backed wire keeps stale-chunk cleanup restart-safe when QUANTA_INDEX_DB_PATH is set", async () => {
    const root = makeTmpDir()
    const workspace = join(root, "workspace")
    const dbDir = join(root, "db")
    const manifestPath = join(root, "manifest.sqlite")
    const logPath = join(root, "lance-rest.jsonl")
    mkdirSync(join(workspace, "src"), { recursive: true })
    mkdirSync(dbDir, { recursive: true })
    writeFileSync(logPath, "", "utf8")
    const shim = await startLanceShim(python, dbDir, logPath)
    try {
      writeFileSync(join(workspace, "src", "main.ts"), exportLines("alpha", 120), "utf8")
      const env = buildWireEnv(shim.baseURL, manifestPath)

      const firstWire = buildSearchPipelineFromEnv(env, workspace)
      expect(firstWire).not.toBeNull()
      await waitUntil(
        () => {
          const entries = readLog(logPath)
          return entries.filter((entry) => entry.path === "/v1/table/docs/upsert").length >= 4
        },
        15_000,
        "initial persisted-manifest real Lance upserts",
      )
      expect(inspectRealTable(python, dbDir).ids).toEqual(expectedInitialIds)

      const baseline = readLog(logPath).length
      clearSearchPipelineWireForTests()

      await wait(25)
      writeFileSync(join(workspace, "src", "main.ts"), "export const gamma = 3\n", "utf8")

      const secondWire = buildSearchPipelineFromEnv(env, workspace)
      expect(secondWire).not.toBeNull()

      const restartDelete = await waitUntil(
        () => {
          const entries = readLog(logPath).slice(baseline)
          const deleteCall = entries.find((entry) => entry.path === "/v1/table/docs/delete")
          const rewriteCall = entries.find(
            (entry) => entry.path === "/v1/table/docs/upsert" && rewriteTextSeen(entry),
          )
          const table = inspectRealTable(python, dbDir)
          if (deleteCall === undefined || rewriteCall === undefined) return null
          return table.rowCount === 1 && table.ids[0] === "src/main.ts:1-1" ? deleteCall : null
        },
        15_000,
        "restart-safe stale delete",
      )
      if (restartDelete === null) throw new Error("unreachable")

      expect([...deleteIds(restartDelete)].sort()).toEqual(expectedInitialIds)
      const table = inspectRealTable(python, dbDir)
      expect(table.rowCount).toBe(1)
      expect(table.ids).toEqual(["src/main.ts:1-1"])
      expect(table.texts).toEqual(["export const gamma = 3"])

      const query = await secondWire?.pipeline.search({ text: "gamma", k: 1 })
      expect(query?.ok).toBe(true)
      if (query?.ok) expect(query.value[0]?.metadata?.path).toBe("src/main.ts")
    } finally {
      clearSearchPipelineWireForTests()
      await shim.stop()
    }
  }, 30_000)
})
