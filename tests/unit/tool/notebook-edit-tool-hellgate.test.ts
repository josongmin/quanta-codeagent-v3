/**
 * W6 hellgate — `notebook_edit` tool through an in-memory FS port. Proves the
 * wrapper: a valid cell edit writes the modified notebook back; every failure
 * mode (non-.ipynb path / unreadable file / malformed notebook / not-found
 * match) yields ok:false AND performs NO write (no partial-write window), never
 * throwing. red-on-injection: a wrapper that wrote on failure, or threw on a
 * malformed notebook, fails here.
 */
import { describe, expect, test } from "bun:test"
import type { FileInfo, FileSystemPort } from "@/storage"
import { makeNotebookEditTool } from "@/tool/notebook-edit/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const NB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3" } },
  cells: [
    {
      cell_type: "code",
      id: "a",
      source: ["x = 1\n", "print(x)\n"],
      metadata: {},
      execution_count: null,
      outputs: [],
    },
    { cell_type: "markdown", id: "b", source: ["# notes\n"], metadata: {} },
  ],
})

// Resolve like the real @/storage jail: a relative path joins the base dir.
const resolve = (path: string, base?: string): string =>
  path.startsWith("/") || base === undefined ? path : `${base}/${path}`

const makePort = (seed: Record<string, string>) => {
  const files = new Map(Object.entries(seed))
  const writes: { path: string; content: string }[] = []
  const port: FileSystemPort = {
    async readFile(path, base) {
      const v = files.get(resolve(path, base))
      if (v === undefined) throw new Error(`File not found: ${resolve(path, base)}`)
      return v
    },
    async writeFile(path, content, base) {
      const k = resolve(path, base)
      writes.push({ path: k, content })
      files.set(k, content)
    },
    async statFile(path): Promise<FileInfo> {
      return {
        path,
        size: 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path, base) {
      return files.has(resolve(path, base))
    },
  }
  return { port, files, writes }
}

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as ToolContext
const run = async (
  tool: ReturnType<typeof makeNotebookEditTool>,
  input: object,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") last = ev.result
  if (last === undefined) throw new Error("no result")
  return last
}

describe("notebook_edit tool — FS-jail wrapper hellgate", () => {
  test("str_replace ⇒ ok + notebook written back with the cell changed", async () => {
    const { port, files, writes } = makePort({ "/repo/nb.ipynb": NB })
    const r = await run(makeNotebookEditTool(port), {
      path: "nb.ipynb",
      mode: "str_replace",
      cell: 0,
      old_string: "x = 1",
      new_string: "x = 99",
    })
    expect(r.ok).toBe(true)
    expect(writes).toHaveLength(1)
    const written = JSON.parse(files.get("/repo/nb.ipynb")!) as { cells: { source: string[] }[] }
    expect(written.cells[0]!.source.join("")).toBe("x = 99\nprint(x)\n")
    expect(written.cells[1]!.source.join("")).toBe("# notes\n") // sibling intact
  })

  test("non-.ipynb path ⇒ ok:false, NO write", async () => {
    const { port, writes } = makePort({ "/repo/foo.py": "x=1" })
    const r = await run(makeNotebookEditTool(port), { path: "foo.py", mode: "delete", cell: 0 })
    expect(r.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  test("unreadable file ⇒ ok:false (no throw), NO write", async () => {
    const { port, writes } = makePort({})
    const r = await run(makeNotebookEditTool(port), {
      path: "missing.ipynb",
      mode: "delete",
      cell: 0,
    })
    expect(r.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  test("malformed notebook ⇒ ok:false, NO write", async () => {
    const { port, writes } = makePort({ "/repo/bad.ipynb": "{ not json" })
    const r = await run(makeNotebookEditTool(port), {
      path: "bad.ipynb",
      mode: "str_replace",
      cell: 0,
      old_string: "x",
      new_string: "y",
    })
    expect(r.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  test("str_replace not-found ⇒ ok:false, NO partial write", async () => {
    const { port, writes } = makePort({ "/repo/nb.ipynb": NB })
    const r = await run(makeNotebookEditTool(port), {
      path: "nb.ipynb",
      mode: "str_replace",
      cell: 0,
      old_string: "nonexistent",
      new_string: "z",
    })
    expect(r.ok).toBe(false)
    expect(writes).toHaveLength(0) // the notebook is untouched
  })

  test("missing required field for mode ⇒ ok:false usage error, NO write", async () => {
    const { port, writes } = makePort({ "/repo/nb.ipynb": NB })
    const r = await run(makeNotebookEditTool(port), {
      path: "nb.ipynb",
      mode: "str_replace",
      cell: 0,
    })
    expect(r.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  test("EDIT-PARITY: stale-read guard rejects a write over a changed-since-read notebook, NO write", async () => {
    const { port, writes } = makePort({ "/repo/nb.ipynb": NB })
    const staleCtx = {
      cwd: "/repo",
      signal: new AbortController().signal,
      readFileState: {
        checkFresh: () => ({ kind: "stale", recordedMtimeMs: 1, currentMtimeMs: 2 }),
      },
    } as unknown as ToolContext
    let last: ToolResult | undefined
    const tool = makeNotebookEditTool(port)
    for await (const ev of tool.execute(
      { path: "nb.ipynb", mode: "delete", cell: 0 } as never,
      staleCtx,
    ) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") last = ev.result
    expect(last?.ok).toBe(false)
    expect(writes).toHaveLength(0) // refused BEFORE any write
  })

  test("EDIT-PARITY: a successful edit records into the file-history sink (rewindable)", async () => {
    const { port } = makePort({ "/repo/nb.ipynb": NB })
    const recorded: { path: string; cwd: string; content: string }[] = []
    const histCtx = {
      cwd: "/repo",
      signal: new AbortController().signal,
      fileHistory: {
        record: (e: { path: string; cwd: string; content: string }) => recorded.push(e),
      },
    } as unknown as ToolContext
    let last: ToolResult | undefined
    const tool = makeNotebookEditTool(port)
    for await (const ev of tool.execute(
      { path: "nb.ipynb", mode: "delete", cell: 1 } as never,
      histCtx,
    ) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") last = ev.result
    expect(last?.ok).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.path).toBe("nb.ipynb")
  })
})
