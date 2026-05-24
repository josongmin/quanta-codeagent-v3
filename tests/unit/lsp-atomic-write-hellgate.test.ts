/**
 * Hellgate — ADR-0155 `FileWriteStrategy` port.
 *
 * Seals the two bundled adapters AND the `LspClient.applyWorkspaceEdit`
 * integration that consumes them. All cases run against REAL filesystem via
 * `node:fs/promises` + `Bun.write` under a per-test tmpdir, so the strategy's
 * commit/rollback semantics are exercised end-to-end (the unit-level fakery
 * in `lsp-applyworkspaceedit-atomicity-hellgate.test.ts` covers the in-process
 * mock path).
 *
 * Sealed slices:
 *   A. sequentialFileWriteStrategy (4) — happy / partial fail / abort / empty
 *   B. atomicFileWriteStrategy Phase A (5) — happy / fail-rollback / commit /
 *      abort-mid-A / tempPrefix opt
 *   C. atomicFileWriteStrategy Phase B (3) — rename-fail mid-commit / EXDEV
 *      fallback flagged / empty batch
 *   D. base.ts integration (4) — default strategy / injected sequential /
 *      outcomes propagated / tool-level `lsp_rename_apply` translation
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { RenameApplyPort, RenameWorkspaceEdit } from "@/lsp"
import { LspClient, type LspClientSpec } from "@/lsp"
import { atomicFileWriteStrategy } from "@/lsp/adapters/file-write-atomic"
import { sequentialFileWriteStrategy } from "@/lsp/adapters/file-write-sequential"
import type {
  FileWriteBatch,
  FileWriteFs,
  FileWriteOutcome,
} from "@/lsp/adapters/file-write-strategy"
import { lspRenameApplyTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Allocate a fresh tmpdir per-test so parallel runs never collide. The
 *  directory is recursively removed at the end of the test — even on failure
 *  (each test awaits the cleanup in a try/finally). */
const mkTmp = async (): Promise<string> => {
  return mkdtemp(join(tmpdir(), "quanta-fws-"))
}

const cleanup = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true })
}

const filesIn = async (dir: string): Promise<string[]> => {
  return readdir(dir).catch(() => [])
}

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

/* ------------------------------------------------------------------ */
/* A. sequentialFileWriteStrategy                                      */
/* ------------------------------------------------------------------ */

describe("sequentialFileWriteStrategy (ADR-0155)", () => {
  test("ATOMW-A1: happy — 3 files → all 3 outcomes kind:'ok' + on-disk content", async () => {
    const dir = await mkTmp()
    try {
      const s = sequentialFileWriteStrategy()
      const batch: FileWriteBatch[] = [
        { path: join(dir, "a.txt"), content: "alpha\n" },
        { path: join(dir, "b.txt"), content: "beta\n" },
        { path: join(dir, "c.txt"), content: "gamma\n" },
      ]
      const out = await s.applyBatch(batch)
      expect(out.map((o) => o.kind)).toEqual(["ok", "ok", "ok"])
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("alpha\n")
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("beta\n")
      expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("gamma\n")
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-A2: 2 succeed + 3rd unwritable → [ok, ok, failed]; best-effort continuation", async () => {
    const dir = await mkTmp()
    try {
      // Force the 3rd write to fail by pointing it at an existing directory
      // path (EISDIR — Bun.write cannot replace a dir with bytes). The first
      // two writes hit real files; the third has no possible success.
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(dir, "is-a-dir"))
      const s = sequentialFileWriteStrategy()
      const out = await s.applyBatch([
        { path: join(dir, "a.txt"), content: "A" },
        { path: join(dir, "b.txt"), content: "B" },
        { path: join(dir, "is-a-dir"), content: "C" },
      ])
      expect(out[0]?.kind).toBe("ok")
      expect(out[1]?.kind).toBe("ok")
      expect(out[2]?.kind).toBe("failed")
      // Loop continued past failure — files 1+2 are on disk despite the failure.
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("A")
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("B")
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-A3: signal aborted pre-start → all outcomes failed w/ reason mentioning 'abort'", async () => {
    const dir = await mkTmp()
    try {
      const ac = new AbortController()
      ac.abort()
      const s = sequentialFileWriteStrategy()
      const out = await s.applyBatch(
        [
          { path: join(dir, "x.txt"), content: "x" },
          { path: join(dir, "y.txt"), content: "y" },
        ],
        ac.signal,
      )
      expect(out).toHaveLength(2)
      for (const o of out) {
        expect(o.kind).toBe("failed")
        if (o.kind === "failed") expect(o.reason).toMatch(/abort/i)
      }
      // Nothing landed on disk.
      expect(await filesIn(dir)).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-A4: empty batch → empty outcomes (no FS reach)", async () => {
    const s = sequentialFileWriteStrategy()
    const out = await s.applyBatch([])
    expect(out).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* B. atomicFileWriteStrategy — Phase A                                */
/* ------------------------------------------------------------------ */

describe("atomicFileWriteStrategy — Phase A prepare (ADR-0155)", () => {
  test("ATOMW-B5: happy — 3 files committed; no temp file remains on disk", async () => {
    const dir = await mkTmp()
    try {
      const s = atomicFileWriteStrategy()
      const batch: FileWriteBatch[] = [
        { path: join(dir, "a.txt"), content: "A1\n" },
        { path: join(dir, "b.txt"), content: "B1\n" },
        { path: join(dir, "c.txt"), content: "C1\n" },
      ]
      const out = await s.applyBatch(batch)
      expect(out.map((o) => o.kind)).toEqual(["ok", "ok", "ok"])
      // Originals hold the patched bytes.
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("A1\n")
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("B1\n")
      expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("C1\n")
      // No leftover quanta-tmp files in the dir.
      const left = (await filesIn(dir)).filter((n) => n.includes(".quanta-tmp"))
      expect(left).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-B6: Phase A fails on file 2 → ALL outcomes failed; all temps cleaned up", async () => {
    const dir = await mkTmp()
    try {
      // Inject an FS shim that fails the SECOND write — emulates Phase A mid-
      // batch failure. The 1st write's temp must be unlinked in rollback (we
      // BOTH record + actually remove so the on-disk assertion holds).
      let writeCount = 0
      const unlinks: string[] = []
      const shim: FileWriteFs = {
        write: async (path, content) => {
          writeCount++
          if (writeCount === 2) throw new Error("simulated disk full")
          await writeFile(path, content)
        },
        rename: async () => {},
        copyFile: async () => {},
        unlink: async (path) => {
          unlinks.push(path)
          await rm(path, { force: true })
        },
        listDir: async (d) => filesIn(d),
      }
      const s = atomicFileWriteStrategy({ fs: shim, tempPrefix: "qb6" })
      const out = await s.applyBatch([
        { path: join(dir, "a.txt"), content: "A" },
        { path: join(dir, "b.txt"), content: "B" },
        { path: join(dir, "c.txt"), content: "C" },
      ])
      expect(out.every((o) => o.kind === "failed")).toBe(true)
      // The 1st prepared temp was unlinked in rollback.
      expect(unlinks.length).toBeGreaterThanOrEqual(1)
      // Originals untouched (we never wrote anything to them — Phase A only).
      expect(await filesIn(dir)).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-B7: Phase A all OK + Phase B all OK → all 'ok'; final content matches", async () => {
    const dir = await mkTmp()
    try {
      // Pre-seed the originals so we can assert that they were ATOMICALLY
      // replaced (not just created from scratch).
      await writeFile(join(dir, "a.txt"), "old-A\n")
      await writeFile(join(dir, "b.txt"), "old-B\n")
      const s = atomicFileWriteStrategy()
      const out = await s.applyBatch([
        { path: join(dir, "a.txt"), content: "new-A\n" },
        { path: join(dir, "b.txt"), content: "new-B\n" },
      ])
      expect(out.map((o) => o.kind)).toEqual(["ok", "ok"])
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new-A\n")
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("new-B\n")
      // No leftover temps.
      const left = (await filesIn(dir)).filter((n) => n.includes(".quanta-tmp"))
      expect(left).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-B8: signal aborted mid-Phase-A → all outcomes failed; temps cleaned", async () => {
    const dir = await mkTmp()
    try {
      const ac = new AbortController()
      const unlinks: string[] = []
      const shim: FileWriteFs = {
        write: async (path, content) => {
          await writeFile(path, content)
          // Abort right after the first write so the loop bails on the next
          // iteration's `signal.aborted` check.
          ac.abort()
        },
        rename: async () => {},
        copyFile: async () => {},
        unlink: async (path) => {
          unlinks.push(path)
          await rm(path, { force: true })
        },
        listDir: async (d) => filesIn(d),
      }
      const s = atomicFileWriteStrategy({ fs: shim, tempPrefix: "qb8" })
      const out = await s.applyBatch(
        [
          { path: join(dir, "a.txt"), content: "A" },
          { path: join(dir, "b.txt"), content: "B" },
        ],
        ac.signal,
      )
      expect(out.every((o) => o.kind === "failed")).toBe(true)
      // The first-prepared temp was unlinked when the loop noticed the abort.
      expect(unlinks.length).toBeGreaterThanOrEqual(1)
      // And no leftover temps on disk.
      const left = (await filesIn(dir)).filter((n) => n.includes(".qb8-"))
      expect(left).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-B9: tempPrefix opt — temps use the supplied prefix during Phase A", async () => {
    const dir = await mkTmp()
    try {
      // Use a shim so we can peek at the temp path AT THE WRITE — by the time
      // applyBatch returns, the temps are gone. We capture every path the
      // strategy writes to.
      const writtenPaths: string[] = []
      const renamed: string[] = []
      const shim: FileWriteFs = {
        write: async (path, content) => {
          writtenPaths.push(path)
          await writeFile(path, content)
        },
        rename: async (from, to) => {
          renamed.push(from)
          // Real rename so the temp is gone post-commit.
          await Bun.write(to, await Bun.file(from).text())
          // No FS unlink here — strategy will not unlink renamed temps.
        },
        copyFile: async () => {},
        unlink: async () => {},
        listDir: async (d) => filesIn(d),
      }
      const s = atomicFileWriteStrategy({ fs: shim, tempPrefix: "MARKER-99" })
      await s.applyBatch([{ path: join(dir, "x.txt"), content: "x" }])
      expect(writtenPaths).toHaveLength(1)
      expect(writtenPaths[0]).toContain(".MARKER-99-")
      // Same prefix surfaces in the rename source too.
      expect(renamed[0]).toContain(".MARKER-99-")
    } finally {
      await cleanup(dir)
    }
  })
})

/* ------------------------------------------------------------------ */
/* C. atomicFileWriteStrategy — Phase B                                */
/* ------------------------------------------------------------------ */

describe("atomicFileWriteStrategy — Phase B commit (ADR-0155)", () => {
  test("ATOMW-C10: Phase B rename fails on file 2 → file 1 committed; file 2+3 failed; temps remain", async () => {
    const dir = await mkTmp()
    try {
      // Pre-seed originals so we can observe the partial-commit state.
      await writeFile(join(dir, "a.txt"), "orig-A")
      await writeFile(join(dir, "b.txt"), "orig-B")
      await writeFile(join(dir, "c.txt"), "orig-C")
      let renameCount = 0
      const shim: FileWriteFs = {
        write: async (path, content) => {
          await writeFile(path, content)
        },
        rename: async (from, to) => {
          renameCount++
          if (renameCount === 2) throw new Error("simulated rename failure")
          await Bun.write(to, await Bun.file(from).text())
          await rm(from, { force: true })
        },
        copyFile: async () => {},
        unlink: async () => {
          /* no rollback in Phase B — strategy explicitly leaves remaining
             temps on disk for caller recovery */
        },
        listDir: async (d) => filesIn(d),
      }
      const s = atomicFileWriteStrategy({ fs: shim, tempPrefix: "qc10" })
      const out = await s.applyBatch([
        { path: join(dir, "a.txt"), content: "new-A" },
        { path: join(dir, "b.txt"), content: "new-B" },
        { path: join(dir, "c.txt"), content: "new-C" },
      ])
      expect(out[0]?.kind).toBe("ok")
      expect(out[1]?.kind).toBe("failed")
      expect(out[2]?.kind).toBe("failed")
      // File 1 was committed; files 2+3 still hold their original bytes.
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new-A")
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("orig-B")
      expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("orig-C")
      // Remaining temps (file 2 + 3) were NOT cleaned — caller can recover.
      const temps = (await filesIn(dir)).filter((n) => n.includes(".qc10-"))
      expect(temps.length).toBeGreaterThanOrEqual(1)
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-C11: cross-FS EXDEV → copyFile fallback; outcome carries 'non-atomic-fallback' warning", async () => {
    const dir = await mkTmp()
    try {
      let copyCalled = false
      const shim: FileWriteFs = {
        write: async (path, content) => {
          await writeFile(path, content)
        },
        rename: async () => {
          // Simulate cross-FS by surfacing EXDEV.
          const err = new Error("cross-device link") as NodeJS.ErrnoException
          err.code = "EXDEV"
          throw err
        },
        copyFile: async (from, to) => {
          copyCalled = true
          await Bun.write(to, await Bun.file(from).text())
        },
        unlink: async (path) => {
          await rm(path, { force: true })
        },
        listDir: async (d) => filesIn(d),
      }
      const s = atomicFileWriteStrategy({ fs: shim, tempPrefix: "qc11" })
      const out = await s.applyBatch([{ path: join(dir, "x.txt"), content: "X" }])
      expect(out).toHaveLength(1)
      expect(out[0]?.kind).toBe("ok")
      const ok = out[0]
      if (ok?.kind === "ok") {
        expect(ok.warning).toBeDefined()
        expect(ok.warning).toMatch(/non-atomic-fallback/)
      }
      expect(copyCalled).toBe(true)
      expect(await readFile(join(dir, "x.txt"), "utf8")).toBe("X")
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-C12: empty batch → no rename calls; empty outcomes", async () => {
    let renameCalled = false
    const shim: FileWriteFs = {
      write: async () => {},
      rename: async () => {
        renameCalled = true
      },
      copyFile: async () => {},
      unlink: async () => {},
      listDir: async () => [],
    }
    const s = atomicFileWriteStrategy({ fs: shim })
    const out = await s.applyBatch([])
    expect(out).toEqual([])
    expect(renameCalled).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* D. base.ts integration                                              */
/* ------------------------------------------------------------------ */

const fakeSpec: LspClientSpec = {
  defaultCommand: ["unused"],
  languageIdFor: () => "typescript",
}

class IntegrationLspClient extends LspClient {
  /** Capture each `start()` would spawn a real process — skip it in tests. */
  override async start(): Promise<void> {
    return
  }
}

describe("LspClient.applyWorkspaceEdit — strategy DI (ADR-0155)", () => {
  test("ATOMW-D13: no strategy injection → atomic default (commits via temp+rename)", async () => {
    const dir = await mkTmp()
    try {
      const a = join(dir, "a.ts")
      await writeFile(a, "hello\n")
      const c = new IntegrationLspClient(fakeSpec, {})
      const outcomes = await c.applyWorkspaceEdit({
        changes: [
          {
            uri: pathToFileURL(a).href,
            edits: [{ range: range(0, 0, 0, 5), newText: "HELLO" }],
          },
        ],
      })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.kind).toBe("ok")
      expect(await readFile(a, "utf8")).toBe("HELLO\n")
      // No temp leftover — default is atomic, both phases succeeded.
      const left = (await filesIn(dir)).filter((n) => n.includes(".quanta-tmp"))
      expect(left).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-D14: sequentialFileWriteStrategy injected → writes go directly to target (no temp)", async () => {
    const dir = await mkTmp()
    try {
      const a = join(dir, "a.ts")
      await writeFile(a, "hello\n")
      const c = new IntegrationLspClient(fakeSpec, {
        fileWriteStrategy: sequentialFileWriteStrategy(),
      })
      const outcomes = await c.applyWorkspaceEdit({
        changes: [
          {
            uri: pathToFileURL(a).href,
            edits: [{ range: range(0, 0, 0, 5), newText: "WORLD" }],
          },
        ],
      })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.kind).toBe("ok")
      expect(await readFile(a, "utf8")).toBe("WORLD\n")
      // Sequential writes don't produce temp files at all.
      const tempLeft = (await filesIn(dir)).filter((n) => n.includes(".quanta-tmp"))
      expect(tempLeft).toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-D15: applyWorkspaceEdit propagates outcomes (no throw) on per-file failure", async () => {
    const dir = await mkTmp()
    try {
      const a = join(dir, "a.ts")
      await writeFile(a, "AAA\n")
      // Inject a bespoke strategy that fails the only entry. The client MUST
      // surface this as a `failed` outcome (not throw) — that's the new contract.
      const stub = {
        name: "stub-fail",
        applyBatch: async (_batch: ReadonlyArray<FileWriteBatch>) =>
          [{ kind: "failed" as const, path: a, reason: "stub: forced failure" }] as const,
      }
      const c = new IntegrationLspClient(fakeSpec, { fileWriteStrategy: stub })
      const outcomes = await c.applyWorkspaceEdit({
        changes: [
          {
            uri: pathToFileURL(a).href,
            edits: [{ range: range(0, 0, 0, 3), newText: "BBB" }],
          },
        ],
      })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.kind).toBe("failed")
      if (outcomes[0]?.kind === "failed") {
        expect(outcomes[0].reason).toContain("stub: forced failure")
      }
      // Original untouched (the stub never actually wrote).
      expect(await readFile(a, "utf8")).toBe("AAA\n")
    } finally {
      await cleanup(dir)
    }
  })

  test("ATOMW-D16: lsp_rename_apply — ANY failed outcome → tool ok:false; ALL ok → ok:true", async () => {
    // Two parallel checks against the rename-apply tool, both via a port that
    // delegates `applyEdit` to a hand-rolled outcome translator (mirrors the
    // real `DefaultCodeActionAdapter.applyEdit` semantics: any failed ⇒ throw).
    const renameEdit: RenameWorkspaceEdit = {
      changes: [
        {
          uri: pathToFileURL("/work/x.ts").href,
          edits: [{ range: range(0, 0, 0, 3), newText: "Bar" }],
        },
      ],
    }
    const okOutcomes: ReadonlyArray<FileWriteOutcome> = [{ kind: "ok", path: "/work/x.ts" }]
    const failedOutcomes: ReadonlyArray<FileWriteOutcome> = [
      { kind: "failed", path: "/work/x.ts", reason: "io error" },
    ]
    const portFor = (outs: ReadonlyArray<FileWriteOutcome>): RenameApplyPort => ({
      computeRename: async () => renameEdit,
      applyEdit: async () => {
        const failed = outs.filter((o) => o.kind === "failed")
        if (failed.length === 0) return
        const summary = failed
          .map((f) => `${f.path}: ${(f as { reason: string }).reason}`)
          .join("; ")
        throw new Error(
          `LSP applyWorkspaceEdit: ${failed.length} of ${outs.length} file(s) failed: ${summary}`,
        )
      },
    })

    const ctx: ToolContext = {
      cwd: "/work",
      signal: new AbortController().signal,
    }
    const collect = async (port: RenameApplyPort): Promise<ToolResult> => {
      const tool = lspRenameApplyTool(port)
      let result: ToolResult | undefined
      const it = tool.execute(
        { path: "/work/x.ts", line: 1, character: 1, newName: "Bar" },
        ctx,
      ) as AsyncIterable<ToolEvent>
      for await (const ev of it) {
        if (ev.type === "result") result = ev.result
      }
      if (!result) throw new Error("no terminal result")
      return result
    }

    const okResult = await collect(portFor(okOutcomes))
    expect(okResult.ok).toBe(true)
    expect(okResult.output).toContain("Renamed symbol at /work/x.ts:1:1")

    const failResult = await collect(portFor(failedOutcomes))
    expect(failResult.ok).toBe(false)
    expect(failResult.output).toContain("applyEdit failed")
    expect(failResult.output).toContain("io error")
  })
})
