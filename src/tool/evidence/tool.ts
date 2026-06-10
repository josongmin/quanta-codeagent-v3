/**
 * Keystone `collect_evidence` — ONE call that assembles the unified
 * {@link EvidencePacket} for a failing test: detect toolchain → run suite →
 * enrich the top failure with LSP static + DAP runtime → add repo context. The
 * value is fusion: instead of the LLM orchestrating run_tests + lsp_nav +
 * debug_inspect by hand, it gets the whole picture in one shot.
 *
 * Same-slice sources (detect / runTests / git changed-files) are wired here;
 * cross-slice sources (LSP static, DAP runtime) are INJECTED ports the host
 * supplies (slice isolation — @/tool may not import @/lsp). Absent ⇒ that
 * section degrades to null, the packet is still built.
 *
 * HIGH RISK: it RUNS the test suite (project code) ⇒ default-OFF
 * (QUANTA_EVIDENCE) + always-confirm. NEVER throws.
 */
import { z } from "zod"
import { defaultFileSystemPort, type FileSystemPort } from "@/storage"
import { detectToolchain, defaultTestRunPort, runToolchain, type TestRunPort, type Toolchain } from "../testrun"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { buildEvidence, type EvidenceSources } from "./builder"
import { defaultRuntimePort } from "./runtime"
import type { EvidencePacket, FailureEvidence, RuntimeEvidence, StaticEvidence } from "./types"

const schema = z.object({
  cwd: z.string().optional().describe("Project root (defaults to session cwd)."),
  publicApiChangeAllowed: z.boolean().optional().describe("Patch constraint: may the fix change a public API? Default false."),
  style: z.string().optional().describe("Patch constraint: style guidance (e.g. 'match surrounding')."),
  // Per-section toggles — each defaults ON. `runtime` is the expensive one (it
  // re-runs the suite under a debugger), so turn it OFF for a fast failure+static
  // packet; turn `static` off to skip the LSP query.
  includeRuntime: z.boolean().optional().describe("Capture runtime stack+locals by re-running the failing test under a debugger (DAP). Default true; set false to skip the extra debugger run."),
  includeStatic: z.boolean().optional().describe("Capture static context (LSP definitions/refs/types) at the failure site. Default true."),
})
type Input = z.infer<typeof schema>

/** Cross-slice enrichment the host wires in (LSP/DAP live in other slices). */
export interface EvidenceToolDeps {
  readonly fs?: FileSystemPort
  readonly testPort?: TestRunPort
  /** LSP static at a failure site (host-injected, e.g. via lsp-bridge). */
  readonly lspStatic?: (file: string, line: number, cwd: string) => Promise<StaticEvidence | null>
  /** DAP runtime for the failing test. Default: `defaultRuntimePort` (python/
   *  debugpy, in-slice). Host may override. */
  readonly runtime?: (failure: FailureEvidence, tc: Toolchain, cwd: string, signal?: AbortSignal) => Promise<RuntimeEvidence | null>
  /** Changed-files probe (default: `git diff --name-only HEAD`). */
  readonly changedFiles?: (cwd: string) => Promise<readonly string[]>
}

/** Parse `git status --porcelain` into changed file paths. Handles renames
 *  (`R  old -> new` → new), quoted paths with spaces, and untracked (`??`).
 *  Pure + NEVER-throws. */
export const parseGitPorcelain = (text: string): readonly string[] => {
  const out: string[] = []
  const unquote = (s: string): string =>
    s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s
  for (const raw of text.split("\n")) {
    if (raw.length < 4) continue // "XY path" is ≥4 chars
    let path = raw.slice(3) // strip the 2-char XY status + the space
    const arrow = path.indexOf(" -> ")
    if (arrow !== -1) path = path.slice(arrow + 4) // rename/copy: keep the NEW path
    const trimmed = unquote(path.trim())
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/** Default git changed-files: working-tree + index status, plus untracked. */
const gitChangedFiles = async (cwd: string): Promise<readonly string[]> => {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return parseGitPorcelain(out)
  } catch {
    return []
  }
}

const render = (pkt: EvidencePacket): string => JSON.stringify(pkt, null, 2)

export const makeCollectEvidenceTool = (deps: EvidenceToolDeps = {}): Tool<Input> => {
  const fs = deps.fs ?? defaultFileSystemPort
  const testPort = deps.testPort ?? defaultTestRunPort
  return {
    name: "collect_evidence",
    description:
      "Assemble a unified DEBUGGING EVIDENCE PACKET for the current failure: detects the project toolchain, " +
      "runs the test suite, and fuses the top failing test with its static context (definitions/refs/types/" +
      "diagnostics), runtime state, and repo changed-files into one JSON. Use this FIRST when a test is failing " +
      "to get the whole picture in one call instead of running run_tests + lsp_nav + debug_inspect separately.",
    inputSchema: schema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: (): "always-confirm" => "always-confirm",

    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      if (ctx.signal?.aborted === true) {
        yield { type: "result", result: { ok: false, output: "aborted before start" } }
        return
      }
      const cwd = input.cwd ?? ctx.cwd
      const sources: EvidenceSources = {
        detect: (c) => detectToolchain(c, { fileExists: (name) => fs.fileExists(name, c) }),
        runTests: (tc, c) => runToolchain(tc, c, testPort, ctx.signal),
        changedFiles: deps.changedFiles ?? gitChangedFiles,
        // static (LSP): wired unless the caller opted out. Host-injected port.
        ...(input.includeStatic !== false && deps.lspStatic !== undefined ? { lspStatic: deps.lspStatic } : {}),
        // runtime (DAP): default ON (python/debugpy + rust/lldb, in-slice),
        // degrades to null when the toolchain/adapter is absent. Opt OUT with
        // includeRuntime:false to skip the expensive extra debugger run.
        ...(input.includeRuntime !== false ? { runtime: deps.runtime ?? defaultRuntimePort } : {}),
      }
      const pkt = await buildEvidence(cwd, sources, {
        patchConstraints: {
          public_api_change_allowed: input.publicApiChangeAllowed ?? false,
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })
      // ok mirrors run_tests: a green suite ⇒ ok:true; a suite with a failure ⇒
      // ok:false (the packet — with `failure` + enrichment — is the payload
      // either way). Consistent with the harness convention (ok:false = red).
      yield { type: "result", result: { ok: pkt.failure === null, output: render(pkt) } }
    },
  }
}

export const collectEvidenceTool: Tool<Input> = makeCollectEvidenceTool()
