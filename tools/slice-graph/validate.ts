/**
 * tools/slice-graph/validate.ts — rule-based validator over a `SliceGraph`.
 *
 * `SLICE_RULES` is a closed list of forbidden edges expressed as
 * `{ from, to: [...slices], reason }`. Each rule names ONE source slice and
 * a set of destination slices it must NOT import. Plane-clean sub-slice
 * rules (`agent/subagent-resume → agent/loop`) are represented as
 * "<slice>/<sub>" strings on either side, matched against per-file source
 * paths AND the raw import specifiers already captured by `build-graph.ts`
 * on its `sources[]` array — no file I/O happens here.
 *
 * Plane-clean: imports `node:path` only (for sub-slice path matching) and
 * `./build-graph.ts` for the graph type + builder. No `@/*`, no fs/promises.
 *
 * Bun-runnable: `bun tools/slice-graph/validate.ts` builds the live graph
 * + prints violations (non-zero exit code if any).
 */

import { relative, resolve } from "node:path"
import { buildSliceGraph, type SliceGraph, type SliceGraphViolation } from "./build-graph"

export type { SliceGraphViolation }

export interface ForbiddenEdge {
  readonly from: string
  readonly to: ReadonlyArray<string>
  readonly reason: string
  /** Import specifiers (exact, or `prefix/`-matched) that are EXEMPT from this
   *  rule — an ADR-blessed pure primitive that physically lives in a `to` slice
   *  but is declared surface-agnostic and safe to consume from any slice. The
   *  carve-out is narrow: every OTHER specifier under the same `to` still fails. */
  readonly except?: ReadonlyArray<string>
}

/** ADR-0440: `@/runner/diff-ops` is the surface-agnostic pure line-LCS/diff-math
 *  primitive (only depends on `@/shared`), hoisted into `runner/` so the CLI ANSI
 *  preview AND the web-daemon canvas emitter AND the review-anchor tool consume ONE
 *  implementation. It is a pure leaf, not a Layer-2 runner concern — so importing
 *  it is NOT a reverse-layering up-import. Every non-diff-ops `@/runner/*` import
 *  from a lower slice still violates. */
const ADR0440_PURE_RUNNER: ReadonlyArray<string> = ["@/runner/diff-ops"]

/** Forbidden edges. Slice names without `/` match top-level slices (e.g.
 *  `agent`). Slash-form names (`agent/subagent-resume`) match per-file
 *  paths for the source side and raw `@/<slice>/<sub>` specifiers for the
 *  destination side. */
export const SLICE_RULES: ReadonlyArray<ForbiddenEdge> = [
  // === Port → consumer (reverse layering) ===
  {
    from: "llm",
    to: ["agent"],
    reason: "LLM port is consumed by agent; reverse import violates layering (ADR-0001)",
  },
  {
    from: "tool",
    to: ["agent"],
    reason: "Tool port consumed by agent (ADR-0001)",
  },
  {
    from: "permission",
    to: ["agent"],
    reason: "Permission consumed by agent (ADR-0001)",
  },
  {
    from: "storage",
    to: ["agent"],
    reason: "Storage consumed by agent (ADR-0001)",
  },
  {
    from: "runtime",
    to: ["agent"],
    reason: "Runtime consumed by agent (ADR-0001)",
  },
  {
    from: "lsp",
    to: ["agent", "tool"],
    reason: "LSP port consumed by tool layer (ADR-0001)",
  },
  {
    from: "mcp",
    to: ["agent", "tool"],
    reason: "MCP consumed by agent + tool (ADR-0001)",
  },
  {
    from: "observability",
    to: ["agent"],
    reason: "Observability is sink for agent; reverse violates (ADR-0001)",
  },
  {
    from: "security",
    to: ["agent", "tool", "llm"],
    reason: "Security is pure primitives; consumed not consumer (ADR-0001)",
  },

  // === Up-import bar: Layer-0/1 libraries + leaves MUST NOT reach UP into the
  //     Layer-2 composition / surface slices (runner / host / ipc / apps).
  //     The composition root assembles these lower slices; a lower slice that
  //     imports a Layer-2 slice is a reverse-layering inversion (the same CLASS
  //     of bug as storage→tool). Each rule names one lower slice; the
  //     destination set is the full Layer-2 surface. (build-graph collapses
  //     `@/apps/...` specifiers under the `apps` slice, so `apps` here also
  //     covers `src/apps/**`.) ===
  ...(
    [
      "memory",
      "agent",
      "session",
      "subagent",
      "skill",
      "llm",
      "mcp",
      "tool",
      "storage",
      "permission",
      "lsp",
      "stream",
      "git",
      "browser",
      "scheduler",
      "rules",
      "security",
      "observability",
    ] as const
  ).map((from) => ({
    from,
    to: ["runner", "host", "ipc", "apps"],
    reason: `${from} is a lower layer; importing a Layer-2 surface (runner/host/ipc/apps) is a reverse-layering up-import (ADR-0001)`,
    except: ADR0440_PURE_RUNNER,
  })),

  // === Plane-clean sub-slice rules (helper primitives cannot pull the loop) ===
  {
    from: "agent/subagent-resume",
    to: ["agent/loop", "agent/dispatch"],
    reason: "Resume primitive is a helper; cannot depend on loop/dispatch (plane-clean)",
  },
  {
    from: "agent/conversation-checkpoint",
    to: ["agent/loop", "agent/dispatch"],
    reason: "Checkpoint primitive is a helper; cannot depend on loop/dispatch (plane-clean)",
  },
  {
    from: "agent/plan-queue",
    to: ["agent/loop", "agent/dispatch"],
    reason: "Plan-queue primitive is a helper; cannot depend on loop/dispatch (plane-clean)",
  },
  {
    from: "agent/budget-ledger",
    to: ["agent/loop", "agent/dispatch"],
    reason: "Budget-ledger primitive is a helper; cannot depend on loop/dispatch (plane-clean)",
  },
  {
    from: "agent/streaming-cancellation",
    to: ["agent/loop", "agent/dispatch"],
    reason:
      "Streaming-cancellation primitive is a helper; cannot depend on loop/dispatch (plane-clean)",
  },
]

/** Split `agent/subagent-resume` → `{ slice: "agent", sub: "subagent-resume" }`. */
const splitSlash = (name: string): { slice: string; sub: string | null } => {
  const idx = name.indexOf("/")
  if (idx === -1) return { slice: name, sub: null }
  return { slice: name.slice(0, idx), sub: name.slice(idx + 1) }
}

/** True iff `file` is under `<root>/<slice>/<sub>.ts` or `<root>/<slice>/<sub>/...`
 *  for any configured src root. */
const fileMatchesSubSlice = (
  file: string,
  slice: string,
  sub: string,
  srcRoots: ReadonlyArray<string>,
): boolean => {
  for (const root of srcRoots) {
    const rel = relative(root, file)
    if (rel.startsWith("..")) continue
    const norm = rel.replace(/\\/g, "/")
    const wantedFile = `${slice}/${sub}.ts`
    const wantedDir = `${slice}/${sub}/`
    if (norm === wantedFile) return true
    if (norm.startsWith(wantedDir)) return true
  }
  return false
}

/** True iff `spec` is `@/<slice>` (top-level) OR `@/<slice>/<sub>` /
 *  `@/<slice>/<sub>/...` when `sub` is provided. */
const specMatchesDest = (spec: string, dest: string): boolean => {
  if (!spec.startsWith("@/")) return false
  const rest = spec.slice(2)
  const { slice: destSlice, sub: destSub } = splitSlash(dest)
  if (destSub === null) {
    // Top-level match — accept `@/<slice>` exactly OR any deeper path.
    return rest === destSlice || rest.startsWith(`${destSlice}/`)
  }
  // Sub-slice match — accept exact `@/<slice>/<sub>` or deeper.
  return rest === `${destSlice}/${destSub}` || rest.startsWith(`${destSlice}/${destSub}/`)
}

export interface ValidateOpts {
  /** Source roots that built the graph — needed to resolve per-file
   *  sub-slice matches. Defaults to `[<repo>/src]`. */
  readonly srcRoots?: ReadonlyArray<string>
  /** Optional custom rule list. Defaults to `SLICE_RULES`. */
  readonly rules?: ReadonlyArray<ForbiddenEdge>
}

interface MatchCtx {
  readonly src: { file: string; from: string; to: string; spec: string }
  readonly rule: ForbiddenEdge
  readonly seen: Set<string>
  readonly out: SliceGraphViolation[]
}

const isExempt = (spec: string, except: ReadonlyArray<string> | undefined): boolean =>
  except !== undefined && except.some((e) => spec === e || spec.startsWith(`${e}/`))

const tryMatchRuleDest = (ctx: MatchCtx, dest: string): void => {
  if (!specMatchesDest(ctx.src.spec, dest)) return
  // ADR-blessed pure primitive living in a `to` slice ⇒ not a reverse-layering edge.
  if (isExempt(ctx.src.spec, ctx.rule.except)) return
  const key = `${ctx.src.file}::${ctx.rule.from}->${dest}`
  if (ctx.seen.has(key)) return
  ctx.seen.add(key)
  ctx.out.push({
    file: ctx.src.file,
    from: ctx.rule.from,
    to: dest,
    reason: ctx.rule.reason,
  })
}

const sourceMatchesRule = (
  src: { file: string; from: string },
  ruleSlice: string,
  ruleSub: string | null,
  srcRoots: ReadonlyArray<string>,
): boolean => {
  if (src.from !== ruleSlice) return false
  if (ruleSub === null) return true
  return fileMatchesSubSlice(src.file, ruleSlice, ruleSub, srcRoots)
}

export const validateGraph = (
  graph: SliceGraph,
  opts?: ValidateOpts,
): ReadonlyArray<SliceGraphViolation> => {
  const rules = opts?.rules ?? SLICE_RULES
  const defaultRoot = resolve(import.meta.dir, "..", "..", "src")
  const srcRoots = opts?.srcRoots ?? [defaultRoot]
  const out: SliceGraphViolation[] = []
  const seen = new Set<string>()

  for (const rule of rules) {
    const { slice: ruleSlice, sub: ruleSub } = splitSlash(rule.from)
    for (const src of graph.sources) {
      if (!sourceMatchesRule(src, ruleSlice, ruleSub, srcRoots)) continue
      const ctx: MatchCtx = { src, rule, seen, out }
      for (const dest of rule.to) tryMatchRuleDest(ctx, dest)
    }
  }

  return out
}

const isDirectInvocation = (): boolean => {
  const meta = import.meta as unknown as { main?: boolean }
  if (typeof meta.main === "boolean") return meta.main
  const argv1 = typeof process !== "undefined" ? process.argv[1] : undefined
  return typeof argv1 === "string" && argv1.endsWith("validate.ts")
}

if (isDirectInvocation()) {
  buildSliceGraph().then((graph) => {
    const violations = validateGraph(graph)
    if (violations.length === 0) {
      // biome-ignore lint/suspicious/noConsole: CLI tool entry.
      console.log(
        `slice-graph: 0 violations across ${graph.slices.length} slices / ${graph.edges.length} edges.`,
      )
      process.exit(0)
    }
    // biome-ignore lint/suspicious/noConsole: CLI tool entry.
    console.log(`slice-graph: ${violations.length} violation(s):`)
    for (const v of violations) {
      // biome-ignore lint/suspicious/noConsole: CLI tool entry.
      console.log(`  ${v.file}: ${v.from} -> ${v.to}  (${v.reason})`)
    }
    process.exit(1)
  })
}
