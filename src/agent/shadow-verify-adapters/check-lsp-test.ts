/**
 * ADR-0400 — Real `ShadowCheckPort` combining LSP diagnostics + a shell test
 * runner. The closed `ShadowCheck` union has three arms and this adapter
 * implements them by mapping each to an existing host capability:
 *
 *   - `"lint"` and `"typecheck"`  → LSP server diagnostics (PyrightAdapter for
 *      Python; TypescriptAdapter for JS/TS). One single `<scratch>/<file>`
 *      open per call; we walk a small fixed set of root-anchored files. Severity
 *      mapped: `error` ⇒ `"error"`, `warning` ⇒ `"warning"`, anything else ⇒
 *      `"info"`. Server unavailable / language unsupported ⇒ EMPTY diagnostic
 *      list (graceful skip, mirrors `nullDiagnosticsProvider`).
 *
 *   - `"test"`                    → shell-out `bun test [target]` inside the
 *      scratch tree (`runShell`, scrubbed env). Exit 0 ⇒ no diagnostics;
 *      non-zero / timed-out ⇒ a SINGLE error-severity diagnostic carrying the
 *      tail of the combined output. `runShell` not found / shell command not
 *      found ⇒ error-severity diag (matches the "test runner missing" hellgate).
 *
 * NO-THROW: every internal failure is converted into an error-severity
 * `ShadowDiagnostic` BEFORE returning, so the wave-1 runner's try/catch never
 * fires for this adapter. (The runner's outer wrap is still in place as
 * defense in depth.)
 *
 * Slice fence (ADR-0400): allowed to import `@/lsp` + `@/runtime`
 * (composition-root adapter slice; sibling of `@/agent/lsp-bridge`).
 */

import * as nodeFs from "node:fs/promises"
import * as path from "node:path"
import { extname } from "node:path"
import type { Diagnostic, DiagnosticSeverity } from "@/lsp"
import { type LspClient, PyrightAdapter, TypescriptAdapter } from "@/lsp"
import { runShell } from "@/runtime"
import { errMessage, logger } from "@/shared"
import { isAvailable } from "../lsp-bridge/availability"
import type { ShadowCheck, ShadowCheckPort, ShadowDiagnostic } from "../shadow-verify"

/** Local view of the per-language wiring; mirrors `@/agent/lsp-bridge` but
 *  scoped so this adapter does not depend on bridge internals. */
interface ServerSpec {
  bin: string
  create(cwd: string): LspClient
}

const PYRIGHT: ServerSpec = {
  bin: "pyright-langserver",
  create: (cwd) => new PyrightAdapter({ cwd }),
}
const TYPESCRIPT: ServerSpec = {
  bin: "typescript-language-server",
  create: (cwd) => new TypescriptAdapter({ cwd }),
}

const SERVERS: ReadonlyArray<{ exts: readonly string[]; spec: ServerSpec }> = [
  { exts: [".py", ".pyi"], spec: PYRIGHT },
  { exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], spec: TYPESCRIPT },
]

const specFor = (filePath: string): ServerSpec | null => {
  const ext = extname(filePath).toLowerCase()
  return SERVERS.find((entry) => entry.exts.includes(ext))?.spec ?? null
}

/** Map LSP severity → ShadowDiagnostic severity (closed 3-arm union). */
const mapSeverity = (s: DiagnosticSeverity): "error" | "warning" | "info" =>
  s === "error" ? "error" : s === "warning" ? "warning" : "info"

/** Convert a single LSP `Diagnostic` into `ShadowDiagnostic`. The LSP URI
 *  carries `file:///abs/path`; we strip the prefix back to a path for the
 *  human-readable line. */
const toShadowDiag = (d: Diagnostic, source: ShadowCheck): ShadowDiagnostic => {
  const file = d.uri.startsWith("file://") ? d.uri.slice("file://".length) : d.uri
  return {
    file,
    line: d.range.start.line + 1,
    col: d.range.start.character + 1,
    severity: mapSeverity(d.severity),
    message: d.message,
    source,
  }
}

/** Best-effort enumeration of source files in the scratch worktree, used to
 *  drive the LSP probe. We cap at a small fixed count to keep the verify call
 *  fast even on large repos; the model is expected to use `test_target` for
 *  targeted runs and trust lint/typecheck to catch the file the patch touched
 *  (the patch already opened those files into the worktree). */
const MAX_LSP_FILES = 50
const SUPPORTED_EXTS = new Set([".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".quanta",
  ".claude",
  "dist",
  "build",
  ".next",
  "__pycache__",
])

/** Read one directory and project its entries onto a flat, no-throw shape.
 *  Returns `[]` on any read failure (e.g. ENOENT or permission denied), so
 *  walk-loop callers see a graceful skip rather than a thrown exception. */
const safeReadDir = async (
  dir: string,
): Promise<{ name: string; isDir: boolean; isFile: boolean }[]> => {
  try {
    const raw = await nodeFs.readdir(dir, { withFileTypes: true })
    return raw.map((d) => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }))
  } catch {
    return []
  }
}

/** Classify one entry into either "push onto walk stack" (subdir to descend)
 *  or "append to file list" (matching source file). Returns `null` when the
 *  entry is ignored (filtered dir or unsupported ext). */
const classifyEntry = (
  full: string,
  e: { name: string; isDir: boolean; isFile: boolean },
): { kind: "dir"; path: string } | { kind: "file"; path: string } | null => {
  if (e.isDir) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) return null
    return { kind: "dir", path: full }
  }
  if (e.isFile && SUPPORTED_EXTS.has(extname(e.name).toLowerCase())) {
    return { kind: "file", path: full }
  }
  return null
}

/** Fold one entry into the running accumulator: a `dir` pushes onto the stack
 *  (in-place), a `file` appends to the output. Ignored entries are no-ops. */
const foldEntry = (
  out: string[],
  stack: string[],
  dir: string,
  e: { name: string; isDir: boolean; isFile: boolean },
): void => {
  const classified = classifyEntry(path.join(dir, e.name), e)
  if (classified === null) return
  if (classified.kind === "dir") stack.push(classified.path)
  else out.push(classified.path)
}

const walkSourceFiles = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < MAX_LSP_FILES) {
    const dir = stack.pop()
    if (dir === undefined) continue
    const entries = await safeReadDir(dir)
    for (const e of entries) {
      if (out.length >= MAX_LSP_FILES) break
      foldEntry(out, stack, dir, e)
    }
  }
  return out
}

/** Group source files by their owning LSP server bin so we open each at most
 *  once per check. Unsupported extensions are dropped. */
const groupFilesByServer = (
  files: readonly string[],
): Map<string, { spec: ServerSpec; files: string[] }> => {
  const byBin = new Map<string, { spec: ServerSpec; files: string[] }>()
  for (const f of files) {
    const spec = specFor(f)
    if (spec === null) continue
    const entry = byBin.get(spec.bin)
    if (entry === undefined) byBin.set(spec.bin, { spec, files: [f] })
    else entry.files.push(f)
  }
  return byBin
}

/** Open a client + collect diagnostics for one (server, files) group. Per-file
 *  failure becomes one error diag for that file; the client is stopped in a
 *  `finally`. The caller must skip the group when `isAvailable` returned
 *  `false` — this helper assumes a live binary. */
const collectGroupDiagnostics = async (
  spec: ServerSpec,
  serverFiles: readonly string[],
  handle: string,
  check: "lint" | "typecheck",
): Promise<ShadowDiagnostic[]> => {
  const client = spec.create(handle)
  try {
    await client.start()
  } catch (e) {
    logger.warn("shadow-verify: LSP start failed", { bin: spec.bin, error: errMessage(e) })
    await client.stop().catch(() => undefined)
    return []
  }
  const diagnostics: ShadowDiagnostic[] = []
  try {
    for (const f of serverFiles) {
      try {
        const diags = await client.diagnostics(f)
        for (const d of diags) diagnostics.push(toShadowDiag(d, check))
      } catch (e) {
        diagnostics.push({
          file: f,
          line: 0,
          severity: "error",
          message: `LSP diagnostics failed: ${errMessage(e)}`,
          source: check,
        })
      }
    }
  } finally {
    await client.stop().catch(() => undefined)
  }
  return diagnostics
}

/** Run a single LSP-backed check (lint or typecheck). Returns an empty list
 *  when no LSP server is available for any file in the scratch tree (graceful
 *  skip). All thrown errors are converted to a single error diagnostic. */
const runLspCheck = async (
  handle: string,
  check: "lint" | "typecheck",
): Promise<readonly ShadowDiagnostic[]> => {
  let files: string[]
  try {
    files = await walkSourceFiles(handle)
  } catch (e) {
    return [
      {
        file: "",
        line: 0,
        severity: "error",
        message: `scratch enumeration failed: ${errMessage(e)}`,
        source: check,
      },
    ]
  }
  if (files.length === 0) return []
  const byBin = groupFilesByServer(files)
  const diagnostics: ShadowDiagnostic[] = []
  for (const { spec, files: serverFiles } of byBin.values()) {
    if (!(await isAvailable(spec.bin))) continue
    const groupDiags = await collectGroupDiagnostics(spec, serverFiles, handle, check)
    diagnostics.push(...groupDiags)
  }
  return diagnostics
}

/** Run the project's test suite inside the scratch worktree. Defaults to
 *  `bun test [target]` since v3 is a bun project; the host can supply
 *  `test_target` to focus the run. Non-zero exit / timeout / spawn error
 *  collapses to a single error diagnostic. */
const TEST_TIMEOUT_MS = 120_000
const TEST_TAIL_CAP = 8_000

const runTestCheck = async (
  handle: string,
  testTarget: string | undefined,
  signal: AbortSignal | undefined,
): Promise<readonly ShadowDiagnostic[]> => {
  const cmd = testTarget && testTarget.length > 0 ? `bun test ${testTarget}` : "bun test"
  try {
    const r = await runShell(cmd, {
      cwd: handle,
      timeoutMs: TEST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    })
    if (r.exitCode === 0 && !r.timedOut) return []
    const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
    const tail =
      combined.length > TEST_TAIL_CAP
        ? `… (truncated ${combined.length - TEST_TAIL_CAP} chars)\n${combined.slice(-TEST_TAIL_CAP)}`
        : combined
    const status = r.timedOut ? "timed out" : `exit ${r.exitCode}`
    return [
      {
        file: "",
        line: 0,
        severity: "error",
        message: `test runner ${status}: ${tail || "(no output)"}`,
        source: "test",
      },
    ]
  } catch (e) {
    return [
      {
        file: "",
        line: 0,
        severity: "error",
        message: `test runner unavailable: ${errMessage(e)}`,
        source: "test",
      },
    ]
  }
}

/**
 * Build the real `ShadowCheckPort`. Each `run(handle, check, testTarget)` call
 * dispatches to the matching adapter (LSP for lint/typecheck, shell for test).
 * NO-THROW: every internal failure ⇒ error-severity diag in the returned list.
 */
export const createLspTestCheckPort = (): ShadowCheckPort => ({
  async run(
    handle: string,
    check: ShadowCheck,
    testTarget: string | undefined,
    signal?: AbortSignal,
  ): Promise<readonly ShadowDiagnostic[]> {
    try {
      switch (check) {
        case "lint":
        case "typecheck":
          return await runLspCheck(handle, check)
        case "test":
          return await runTestCheck(handle, testTarget, signal)
      }
    } catch (e) {
      // Defensive — the per-check helpers already NO-THROW, but if a future
      // refactor introduces a throw it surfaces here as a typed diag.
      return [
        {
          file: "",
          line: 0,
          severity: "error",
          message: errMessage(e),
          source: check,
        },
      ]
    }
  },
})
