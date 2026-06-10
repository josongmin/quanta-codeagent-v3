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
import { detectToolchain, defaultTestRunPort, runToolchain, type TestRunPort } from "../testrun"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { buildEvidence, type EvidenceSources } from "./builder"
import type { EvidencePacket, RuntimeEvidence, StaticEvidence } from "./types"

const schema = z.object({
  cwd: z.string().optional().describe("Project root (defaults to session cwd)."),
  publicApiChangeAllowed: z.boolean().optional().describe("Patch constraint: may the fix change a public API? Default false."),
  style: z.string().optional().describe("Patch constraint: style guidance (e.g. 'match surrounding')."),
})
type Input = z.infer<typeof schema>

/** Cross-slice enrichment the host wires in (LSP/DAP live in other slices). */
export interface EvidenceToolDeps {
  readonly fs?: FileSystemPort
  readonly testPort?: TestRunPort
  /** LSP static at a failure site (host-injected, e.g. via lsp-bridge). */
  readonly lspStatic?: (file: string, line: number, cwd: string) => Promise<StaticEvidence | null>
  /** DAP runtime for the failing test (host-injected). */
  readonly runtime?: (failure: { test_name: string; file?: string; line?: number }, cwd: string) => Promise<RuntimeEvidence | null>
  /** Changed-files probe (default: `git diff --name-only HEAD`). */
  readonly changedFiles?: (cwd: string) => Promise<readonly string[]>
}

/** Default git changed-files: union of unstaged+staged vs HEAD, plus untracked. */
const gitChangedFiles = async (cwd: string): Promise<readonly string[]> => {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
      .split("\n")
      .map((l) => l.slice(3).trim()) // strip the 2-char status + space
      .filter((l) => l.length > 0)
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
        ...(deps.lspStatic !== undefined ? { lspStatic: deps.lspStatic } : {}),
        ...(deps.runtime !== undefined ? { runtime: deps.runtime } : {}),
      }
      const pkt = await buildEvidence(cwd, sources, {
        patchConstraints: {
          public_api_change_allowed: input.publicApiChangeAllowed ?? false,
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
      })
      // ok reflects the SUITE: a clean (no-failure) packet is ok; a packet with
      // a failure is the normal "here's what's broken" payload (ok:true — the
      // TOOL succeeded; the suite's redness lives in `failure`).
      yield { type: "result", result: { ok: true, output: render(pkt) } }
    },
  }
}

export const collectEvidenceTool: Tool<Input> = makeCollectEvidenceTool()
