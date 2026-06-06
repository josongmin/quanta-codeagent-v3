/**
 * PERMANENT GUARD — the tool NO-THROW contract (`src/tool/types.ts` §2),
 * enforced as a STATIC RATCHET over EVERY tool's `execute` body.
 *
 * THE BUG CLASS THIS CLOSES (round-3, jun-06). A tool `execute` is an async
 * generator (or returns an async iterable). When its body does:
 *
 *     async *execute(input, ctx) {
 *       const r = await port.doThing(...)   // ⛔ NO try/catch
 *       …
 *     }
 *
 * and the INJECTED `port` REJECTS (throws) instead of returning a typed
 * `{ok:false}` result, the rejection escapes the iterator. The dispatch loop
 * `for await`-ing that iterator then either HANGS (no terminal result) or
 * CORRUPTS (an exception where it expected a `ToolResult`). Round-3 found 16
 * such unguarded port-await paths (pty / mcp_resources / mcp_connector /
 * side_agent / communicate / image_gen). The contract (`types.ts` §2) requires
 * every port call be mapped to a typed `ToolResult`, NEVER thrown out of the
 * iterator.
 *
 * WHY A STATIC RATCHET (not only the runtime conformance hellgate). The
 * companion `session-tools-contract-conformance-hellgate.test.ts` drives a
 * FIXED, HAND-MAINTAINED LIST of tools through a throwing port. Its gap: a NEW
 * tool can ship an unguarded port-await with ZERO coverage — nobody remembers
 * to add it to the list. This ratchet has NO list to forget: it AST-walks every
 * `src/tool/**` `execute` body and FAILS on any unguarded injected-port await,
 * so a future violation breaks CI the moment it lands.
 *
 * HOW IT CLASSIFIES (deterministic, AST-based, no type resolution):
 *   - SCOPE: only `await` expressions LEXICALLY inside an async-generator
 *     `execute` method OR a `[Symbol.asyncIterator]` async generator (the
 *     iterator object an `execute` returns). Awaits inside nested helper
 *     functions are NOT in scope HERE — a throw there does not escape the
 *     iterator unless it is itself awaited at a site this walk DOES see.
 *   - DANGEROUS shape: `await <receiver>.<method>(...)` (a member CALL) whose
 *     root receiver is a FUNCTION PARAMETER of the enclosing file (the injected
 *     dependency — `port`, `registry`, `session`, …) or `this.<port>` — i.e. an
 *     injected seam, not a pure local computation.
 *   - SAFE (not flagged):
 *       1. the await is lexically inside a `try { … }` block (the catch maps the
 *          throw to a typed result), OR
 *       2. the await's callee is a known NO-THROW WRAPPER (`fromPort` /
 *          `callPort`) that try/catches internally and returns a typed result.
 *
 * THE ALLOWLIST. A handful of pre-existing tools still carry this shape; each is
 * listed in {@link ALLOWLIST} with a reason and a stable count. The allowlist is
 * VISIBLE and SHRINKING — a guarded fix removes its entry; an UNLISTED violation
 * fails; and a listed file whose violation count DROPS to below its recorded
 * number also fails (forcing the entry to be tightened/removed, so it can never
 * silently absorb a NEW violation in an already-listed file).
 *
 * Read-only, bounded (one AST parse per tool file), deterministic — no flake.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const REPO_ROOT = join(import.meta.dir, "../..")
const TOOL_DIR = join(REPO_ROOT, "src", "tool")

/** Known no-throw wrappers: `await <name>(…)` whose callee is one of these is
 *  the SAFE boundary (the helper try/catches internally and returns a typed
 *  result). Adding a wrapper here is a deliberate, reviewed widening. */
const SAFE_WRAPPERS: ReadonlySet<string> = new Set(["fromPort", "callPort"])

export interface PortAwaitFinding {
  /** Repo-relative path. */
  readonly file: string
  /** 1-based line of the offending `await`. */
  readonly line: number
  /** First ~80 chars of the offending expression (single-spaced). */
  readonly text: string
}

/** Is `name` the `execute` identifier OR a computed `[Symbol.asyncIterator]`? */
const isIteratorMemberName = (name: ts.PropertyName | undefined): boolean => {
  if (!name) return false
  if (ts.isIdentifier(name)) return name.text === "execute"
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression
    return (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "Symbol" &&
      e.name.text === "asyncIterator"
    )
  }
  return false
}

const isAsyncGenerator = (node: ts.Node): node is ts.MethodDeclaration => {
  if (!ts.isMethodDeclaration(node)) return false
  if (!node.body || !ts.isBlock(node.body)) return false
  const isAsync = (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  return isAsync && node.asteriskToken !== undefined
}

/** A function-like node that opens a NEW scope; we never descend into one while
 *  walking an iterator body (a throw inside it does not escape the iterator
 *  unless awaited at a site this walk already sees). */
const isNestedScope = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

/** Collect every function-parameter identifier in the file — the universe of
 *  injected dependencies. A member-call await rooted at one of these is a
 *  "port call". */
const collectParamNames = (sf: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) names.add(node.name.text)
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return names
}

/** `await SAFE_WRAPPER(…)` — a known no-throw boundary (catches internally). */
const isSafeWrapperAwait = (arg: ts.Expression): boolean =>
  ts.isCallExpression(arg) &&
  ts.isIdentifier(arg.expression) &&
  SAFE_WRAPPERS.has(arg.expression.text)

/** If `arg` is `await <root>.….method(…)` whose root receiver is an injected
 *  param (or `this`), return that root identifier text (or `"this"`); else null. */
const injectedCallRoot = (arg: ts.Expression, params: ReadonlySet<string>): string | null => {
  if (!ts.isCallExpression(arg) || !ts.isPropertyAccessExpression(arg.expression)) return null
  let root: ts.Expression = arg.expression.expression
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  if (root.kind === ts.SyntaxKind.ThisKeyword) return "this"
  if (ts.isIdentifier(root) && params.has(root.text)) return root.text
  return null
}

/** Shared context for one file's scan, threaded through {@link visitIterBody}. */
interface ScanCtx {
  readonly sf: ts.SourceFile
  readonly relPath: string
  readonly params: ReadonlySet<string>
  readonly findings: PortAwaitFinding[]
}

const recordFinding = (ctx: ScanCtx, node: ts.Node): void => {
  const { line } = ctx.sf.getLineAndCharacterOfPosition(node.getStart())
  ctx.findings.push({
    file: ctx.relPath,
    line: line + 1,
    text: node.getText().slice(0, 80).replace(/\s+/g, " ").trim(),
  })
}

/** Recurse a TRY node, propagating guarded-ness: tryBlock is guarded;
 *  catch/finally are NOT (a throw there still escapes the iterator). */
const visitTry = (ctx: ScanCtx, node: ts.TryStatement): void => {
  visitIterBody(ctx, node.tryBlock, true)
  if (node.catchClause) ts.forEachChild(node.catchClause, (c) => visitIterBody(ctx, c, false))
  if (node.finallyBlock) visitIterBody(ctx, node.finallyBlock, false)
}

/** Walk ONE iterator body. `inTry` tracks lexical try-block guarding. We never
 *  descend into nested scopes (their throws don't escape this iterator). */
function visitIterBody(ctx: ScanCtx, node: ts.Node, inTry: boolean): void {
  if (isNestedScope(node)) return
  if (ts.isTryStatement(node)) {
    visitTry(ctx, node)
    return
  }
  if (
    ts.isAwaitExpression(node) &&
    !isSafeWrapperAwait(node.expression) &&
    !inTry &&
    injectedCallRoot(node.expression, ctx.params) !== null
  ) {
    recordFinding(ctx, node)
  }
  ts.forEachChild(node, (c) => visitIterBody(ctx, c, inTry))
}

/**
 * Scan ONE tool source for unguarded injected-port awaits inside iterator
 * bodies. Pure: takes `(relPath, text)`, returns findings — so the red-on-
 * injection proof can feed a synthetic source string with no filesystem.
 */
export const scanToolSource = (relPath: string, text: string): PortAwaitFinding[] => {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true)
  const ctx: ScanCtx = { sf, relPath, params: collectParamNames(sf), findings: [] }
  // Find every iterator body: `async *execute` AND `async *[Symbol.asyncIterator]`.
  const walk = (node: ts.Node): void => {
    if (isAsyncGenerator(node) && isIteratorMemberName(node.name) && node.body) {
      visitIterBody(ctx, node.body, false)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return ctx.findings
}

const listToolTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listToolTsFiles(full))
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.includes(".test.")) {
      out.push(full)
    }
  }
  return out
}

/** Scan the whole `src/tool/**` tree, returning findings keyed by repo path. */
export const scanToolTree = (): PortAwaitFinding[] => {
  const findings: PortAwaitFinding[] = []
  for (const file of listToolTsFiles(TOOL_DIR)) {
    const rel = relative(REPO_ROOT, file).split("\\").join("/")
    findings.push(...scanToolSource(rel, readFileSync(file, "utf8")))
  }
  return findings
}

/**
 * DOCUMENTED, SHRINKING ALLOWLIST of pre-existing tools that still carry an
 * unguarded injected-port await in an iterator body. `count` is the EXACT
 * number of such sites in that file today; the ratchet fails if a listed file's
 * count RISES (a new violation snuck into an already-listed file) OR FALLS (the
 * file was partially fixed — tighten/remove the entry so it can never silently
 * re-absorb a regression). Each entry MUST carry a reason.
 *
 * Goal: this map shrinks to `{}` over time. Adding an entry is a review event.
 */
const ALLOWLIST: ReadonlyArray<{
  readonly file: string
  readonly count: number
  readonly reason: string
}> = [
  {
    file: "src/tool/browser/index.ts",
    count: 15,
    reason:
      "Headless-browser tools: 15 `await port.<verb>(handle, …)` sites that " +
      "assume the `BrowserPort` returns a typed Result and never rejects. A " +
      "single shared `callBrowser` no-throw wrapper would close all 15 at once; " +
      "the mechanical wrap is deferred (large, stable slice outside this " +
      "session's scope) and tracked here so it cannot grow.",
  },
  {
    file: "src/tool/bash/kill.ts",
    count: 1,
    reason:
      "`await registry.kill(shell_id)` — the bash slice is USER IN-FLIGHT this " +
      "session (src/tool/bash/index.ts is modified in the working tree); not " +
      "touched to avoid a merge collision. Tracked so it cannot grow.",
  },
  {
    file: "src/tool/bash/await.ts",
    count: 1,
    reason:
      "`await registry.awaitHandle(shell_id, …)` — same bash in-flight slice as " +
      "bash/kill.ts; deferred to avoid colliding with the user's edits. Tracked.",
  },
]

const ALLOW_BY_FILE = new Map(ALLOWLIST.map((e) => [e.file, e]))

describe("tool NO-THROW contract — static ratchet", () => {
  test("no UNLISTED tool has an unguarded injected-port await in its iterator body", () => {
    const findings = scanToolTree()
    const offenders = findings.filter((f) => !ALLOW_BY_FILE.has(f.file))
    const msg =
      offenders.length === 0
        ? ""
        : "Unguarded injected-port await(s) escaping a tool iterator (NO-THROW " +
          "contract §2 violation — wrap the port call in try/catch or a " +
          "fromPort/callPort no-throw wrapper, or — if pre-existing & deferred — " +
          `add a justified ALLOWLIST entry):\n  ${offenders
            .map((o) => `${o.file}:${o.line}  ${o.text}`)
            .join("\n  ")}`
    expect(offenders, msg).toEqual([])
  })

  test("each ALLOWLIST file still has EXACTLY its recorded count (shrinking ratchet)", () => {
    const findings = scanToolTree()
    const byFile = new Map<string, number>()
    for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)

    for (const entry of ALLOWLIST) {
      const actual = byFile.get(entry.file) ?? 0
      expect(
        actual,
        actual > entry.count
          ? `${entry.file}: a NEW unguarded port-await landed in an allowlisted file ` +
              `(${actual} > recorded ${entry.count}). Fix it — the allowlist may not grow.`
          : `${entry.file}: now has ${actual} unguarded sites (recorded ${entry.count}). ` +
              "Some were fixed — LOWER the allowlist count (or remove the entry) so it " +
              "cannot silently re-absorb a regression.",
      ).toBe(entry.count)
    }
  })

  test("every ALLOWLIST entry is still a real file that still has the shape (no stale entries)", () => {
    const findings = scanToolTree()
    const filesWithFindings = new Set(findings.map((f) => f.file))
    for (const entry of ALLOWLIST) {
      expect(
        filesWithFindings.has(entry.file),
        `${entry.file}: allowlisted but the scanner finds NO violation — remove the stale entry.`,
      ).toBe(true)
    }
  })
})

// ── RED-ON-INJECTION PROOF — re-introduce a round-3 violation synthetically ──
//
// A fake tool whose `execute` awaits a throwing injected port with NO try/catch
// (the EXACT round-3 bug). The scanner MUST flag it. Then the GREEN counterpart
// (the same call guarded by a try/catch, and again by a `callPort` wrapper) MUST
// NOT be flagged. This proves the ratchet is sensitive to the bug and specific
// to the fix — it is not vacuously green.

describe("tool NO-THROW ratchet — red-on-injection proof", () => {
  const RED = `
    import type { Tool, ToolContext, ToolEvent } from "../types"
    interface ThingPort { doThing(x: string): Promise<{ ok: boolean }> }
    export const badTool = (port: ThingPort): Tool => ({
      name: "bad_tool",
      description: "",
      inputSchema: undefined as never,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async *execute(input: { x: string }, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        // ⛔ round-3 bug: a throwing port rejects this iterator.
        const r = await port.doThing(input.x)
        yield { type: "result", result: { ok: r.ok, output: "" } }
      },
    })
  `

  test("RED: an unguarded `await port.doThing(...)` in an execute body IS flagged", () => {
    const findings = scanToolSource("src/tool/__synthetic__/bad.ts", RED)
    expect(findings.length, "the synthetic round-3 violation must be caught").toBe(1)
    expect(findings[0]?.text).toContain("port.doThing")
  })

  test("GREEN (try/catch): the SAME call wrapped in try/catch is NOT flagged", () => {
    const GREEN_TRY = `
      import type { Tool, ToolContext, ToolEvent } from "../types"
      interface ThingPort { doThing(x: string): Promise<{ ok: boolean }> }
      export const okTool = (port: ThingPort): Tool => ({
        name: "ok_tool", description: "", inputSchema: undefined as never,
        isReadOnly: () => true, isConcurrencySafe: () => true,
        async *execute(input: { x: string }, _ctx: ToolContext): AsyncIterable<ToolEvent> {
          let r: { ok: boolean }
          try { r = await port.doThing(input.x) }
          catch { yield { type: "result", result: { ok: false, output: "err" } }; return }
          yield { type: "result", result: { ok: r.ok, output: "" } }
        },
      })
    `
    expect(scanToolSource("src/tool/__synthetic__/ok-try.ts", GREEN_TRY)).toEqual([])
  })

  test("GREEN (callPort wrapper): the SAME call behind a callPort boundary is NOT flagged", () => {
    const GREEN_WRAP = `
      import type { Tool, ToolContext, ToolEvent } from "../types"
      const callPort = async <T>(p: () => Promise<T>) => { try { return await p() } catch { return null } }
      interface ThingPort { doThing(x: string): Promise<{ ok: boolean }> }
      export const okTool = (port: ThingPort): Tool => ({
        name: "ok_tool", description: "", inputSchema: undefined as never,
        isReadOnly: () => true, isConcurrencySafe: () => true,
        async *execute(input: { x: string }, _ctx: ToolContext): AsyncIterable<ToolEvent> {
          const r = await callPort(() => port.doThing(input.x))
          yield { type: "result", result: { ok: r?.ok === true, output: "" } }
        },
      })
    `
    expect(scanToolSource("src/tool/__synthetic__/ok-wrap.ts", GREEN_WRAP)).toEqual([])
  })

  test("GREEN (helper-scoped): a port await inside a NESTED helper is out of scope for the iterator walk", () => {
    // A throw in a nested helper does not escape the iterator unless awaited at a
    // visible site; that visible await (`await run(port)`) is on a LOCAL, not a
    // param, so it is correctly not flagged here. (Helper internals are covered
    // by the helper's own callers / the runtime conformance hellgate.)
    const GREEN_HELPER = `
      import type { Tool, ToolContext, ToolEvent } from "../types"
      interface ThingPort { doThing(x: string): Promise<{ ok: boolean }> }
      const run = async (port: ThingPort) => { try { return await port.doThing("x") } catch { return { ok: false } } }
      export const okTool = (port: ThingPort): Tool => ({
        name: "ok_tool", description: "", inputSchema: undefined as never,
        isReadOnly: () => true, isConcurrencySafe: () => true,
        async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
          const r = await run(port)
          yield { type: "result", result: { ok: r.ok, output: "" } }
        },
      })
    `
    expect(scanToolSource("src/tool/__synthetic__/ok-helper.ts", GREEN_HELPER)).toEqual([])
  })
})
