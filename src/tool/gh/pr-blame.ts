/**
 * ADR-0103 — `gh_pr_blame` tool factory (argv + runner orchestration only).
 *
 * `git blame` answers "who last touched this line"; this tool answers
 * "what did reviewers say about this line" — by anchoring PR review-thread
 * comments to their file:line targets. Reviewers' authored words become
 * the blame body, in addition to (not replacing) the committer.
 *
 * Structural split (vs the original monolithic `index.ts` block):
 *   - `pr-blame-types.ts`    : `ReviewThread` / `RawPrViewJson` shape + proximity const.
 *   - `pr-blame-parser.ts`   : pure `extractThreads` / `matchesPrBlameFilter` /
 *                              `renderPrBlameThread` / `buildBlameBody`.
 *   - `pr-blame.ts`  (this)  : argv build + runner I/O + error envelope.
 *   - `index.ts`             : barrel — re-exports the factory.
 *
 * Boundary: this module is the ONLY place that knows about the
 * `gh pr view --json` argv shape for blame. The parser cannot see the
 * runner or the argv; the parser tests therefore exercise canned JSON
 * directly (no GhRunner round-trip) — a tighter unit boundary.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { DEFAULT_TIMEOUT_MS, type GhRunner, defaultGhRunner } from "./runner"
import { normalizeRef, refRejected } from "./ref"
import { buildBlameBody } from "./pr-blame-parser"
import type { RawPrViewJson } from "./pr-blame-types"

export const prBlameSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  file: z.string().optional().describe("Restrict to comments on this file path"),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Restrict to comments anchored within ±5 lines of this line"),
})
export type PrBlameInput = z.infer<typeof prBlameSchema>

export const ghPrBlameTool = (runner: GhRunner = defaultGhRunner): Tool<PrBlameInput> => ({
  name: "gh_pr_blame",
  description:
    "Anchor PR review-thread comments to file:line — like `git blame`, but with " +
    "reviewer comments instead of commit hashes. Filters by file path and ±5-line " +
    "proximity. Read-only.",
  inputSchema: prBlameSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: PrBlameInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const argv = ["gh", "pr", "view", ref, "--json", "url,headRefName,baseRefName,reviewThreads"]
    yield { type: "progress", message: `gh pr view #${input.pr} (reviewThreads)` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr view failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    let raw: RawPrViewJson
    try {
      raw = JSON.parse(r.stdout) as RawPrViewJson
    } catch (parseErr) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `gh pr view returned non-JSON: ${errMessage(parseErr)}`,
        },
      }
      return
    }
    const built = buildBlameBody(raw, input.file, input.line)
    if (built.kind === "empty") {
      yield { type: "result", result: { ok: true, output: built.reason } }
      return
    }
    const header = raw.url ? `PR: ${raw.url}` : `PR: ${ref}`
    yield { type: "result", result: { ok: true, output: `${header}\n\n${built.text}` } }
  },
})
