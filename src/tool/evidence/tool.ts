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
 * (QUANTA_EVIDENCE) + always-confirm. NEVER throws. An UNDETECTED toolchain
 * (nothing ran) is an explicit ok:false error mirroring run_tests — never a
 * false-green empty packet (jun-10 silent-failure audit #5).
 */
import { z } from "zod"
import { defaultFileSystemPort, type FileSystemPort } from "@/storage"
import {
  commandRunsOk,
  defaultTestRunPort,
  detectToolchain,
  runToolchain,
  type TestRunPort,
  type Toolchain,
} from "../testrun"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { buildEvidence, type EvidenceSources } from "./builder"
import { defaultRuntimePort } from "./runtime"
import type { EvidencePacket, FailureEvidence, RuntimeEvidence, StaticEvidence } from "./types"

const schema = z.object({
  cwd: z.string().optional().describe("Project root (defaults to session cwd)."),
  publicApiChangeAllowed: z
    .boolean()
    .optional()
    .describe("Patch constraint: may the fix change a public API? Default false."),
  style: z
    .string()
    .optional()
    .describe("Patch constraint: style guidance (e.g. 'match surrounding')."),
  // Per-section toggles — each defaults ON. `runtime` is the expensive one (it
  // re-runs the suite under a debugger), so turn it OFF for a fast failure+static
  // packet; turn `static` off to skip the LSP query.
  includeRuntime: z
    .boolean()
    .optional()
    .describe(
      "Capture runtime stack+locals by re-running the failing test under a debugger (DAP). Default true; set false to skip the extra debugger run.",
    ),
  includeStatic: z
    .boolean()
    .optional()
    .describe(
      "Capture static context (LSP definitions/refs/types) at the failure site. Default true.",
    ),
})
type Input = z.infer<typeof schema>

/** Cross-slice enrichment the host wires in (LSP/DAP live in other slices). */
export interface EvidenceToolDeps {
  readonly fs?: FileSystemPort
  readonly testPort?: TestRunPort
  /** LSP static at a failure site (host-injected, e.g. via lsp-bridge).
   *  Receives the turn signal so an aborted turn bails out of the LSP
   *  indexing-retry budget promptly. */
  readonly lspStatic?: (
    file: string,
    line: number,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<StaticEvidence | null>
  /** DAP runtime for the failing test. Default: `defaultRuntimePort` (python/
   *  debugpy, in-slice). Host may override. */
  readonly runtime?: (
    failure: FailureEvidence,
    tc: Toolchain,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<RuntimeEvidence | null>
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
    const proc = Bun.spawn(["git", "-C", cwd, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return parseGitPorcelain(out)
  } catch {
    return []
  }
}

const render = (pkt: EvidencePacket): string => JSON.stringify(pkt, null, 2)

/** Explicit-error result (mirrors run_tests): ok:false + typed failure. */
const err = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output, failure: { mode: "error", modelVisibleError: output } },
})

/** What ACTUALLY happened during a packet build. The builder degrades an
 *  undetected toolchain to an empty packet by contract, so the packet alone
 *  cannot tell green from never-ran — only the source closures can, and they
 *  record it here. Mutable and passed by reference for exactly that reason. */
interface EvidenceRunTrace {
  detected: Toolchain | null
  suiteRan: boolean
}

/** Wire the packet's sources, recording detection + an actual suite run into
 *  `trace`. A unit because the same-slice sources and the two OPTIONAL
 *  cross-slice ports are one wiring decision — which sections the packet can
 *  even contain — and because it is where every `includeX` toggle is read. */
const buildEvidenceSources = (args: {
  readonly deps: EvidenceToolDeps
  readonly input: Input
  readonly fs: FileSystemPort
  readonly testPort: TestRunPort
  readonly signal: AbortSignal | undefined
  readonly trace: EvidenceRunTrace
}): EvidenceSources => ({
  detect: async (c) => {
    const detected = await detectToolchain(c, {
      fileExists: (name) => args.fs.fileExists(name, c),
      canRun: (cmd) => commandRunsOk(cmd, c), // prefer pytest over unittest when installed
    })
    args.trace.detected = detected
    return detected
  },
  runTests: async (tc, c) => {
    const result = await runToolchain(tc, c, args.testPort, args.signal) // NEVER throws (faults ⇒ synthesized failure)
    args.trace.suiteRan = true
    return result
  },
  changedFiles: args.deps.changedFiles ?? gitChangedFiles,
  // static (LSP): wired unless the caller opted out. Host-injected port.
  ...(args.input.includeStatic !== false && args.deps.lspStatic !== undefined
    ? { lspStatic: args.deps.lspStatic }
    : {}),
  // runtime (DAP): default ON (python/debugpy + rust/lldb, in-slice),
  // degrades to null when the toolchain/adapter is absent. Opt OUT with
  // includeRuntime:false to skip the expensive extra debugger run.
  ...(args.input.includeRuntime !== false
    ? { runtime: args.deps.runtime ?? defaultRuntimePort }
    : {}),
})

/** The anti-false-green gate (jun-10 silent-failure audit #5): `ok:true` must
 *  be reachable ONLY when the suite actually executed. Returns the refusal text
 *  when it did not, else `undefined`. A unit because the two refusals are one
 *  rule — "nothing ran is not green evidence" — stated for two different
 *  reasons, and they must stay in this order (an undetected toolchain explains
 *  the missing run, so it is the more useful message). */
const nothingRanRefusal = (trace: EvidenceRunTrace): string | undefined => {
  if (trace.detected === null) {
    return (
      "collect_evidence: no recognized test toolchain (looked for Cargo.toml / go.mod / pyproject.toml / setup.py / package.json) — " +
      "nothing was run, so there is no green evidence. Pass `cwd` pointing at a project root with one of those markers, " +
      "or use run_tests with an explicit `command`."
    )
  }
  if (!trace.suiteRan) {
    return "collect_evidence: the test suite never ran — refusing to report a green result."
  }
  return undefined
}

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

    async *execute(input: Input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
      if (ctx.signal?.aborted === true) {
        yield { type: "result", result: { ok: false, output: "aborted before start" } }
        return
      }
      const cwd = input.cwd ?? ctx.cwd
      const trace: EvidenceRunTrace = { detected: null, suiteRan: false }
      const sources = buildEvidenceSources({ deps, input, fs, testPort, signal: ctx.signal, trace })
      const pkt = await buildEvidence(cwd, sources, {
        patchConstraints: {
          public_api_change_allowed: input.publicApiChangeAllowed ?? false,
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })
      const refusal = nothingRanRefusal(trace)
      if (refusal !== undefined) {
        yield err(refusal)
        return
      }
      // ok mirrors run_tests: a green suite ⇒ ok:true; a suite with a failure ⇒
      // ok:false (the packet — with `failure` + enrichment — is the payload
      // either way). Consistent with the harness convention (ok:false = red).
      // Reachable ONLY when the suite actually executed (guards above).
      yield { type: "result", result: { ok: pkt.failure === null, output: render(pkt) } }
    },
  }
}

export const collectEvidenceTool: Tool<Input> = makeCollectEvidenceTool()
