import { z } from "zod"
import { errMessage } from "@/shared"
import { defaultFileSystemPort, type FileSystemPort, FsJailError } from "@/storage"
import { freshHashNote, refreshStaleReadBaseline } from "./_shared/fresh-hash"
import { writeBudgetDeny } from "./_shared/exfil-rail-guards"
import { gitWriteGuardDeny } from "./git-write-guard-result"
import { guardWrite } from "./stale-read-guard"
import type { EditToolContext, Tool, ToolEvent, ToolFailure, ToolResult } from "./types"
import { resolveEditBase } from "./worktree/cwd-override"

/**
 * Phase 4 Codex absorption — `scripted_replace` (Codex
 * `tool-routing-and-triggering.md`: "patch is for local + stable context;
 * scripted replace is for duplicated blocks, bulk substitution, or patch
 * context mismatch"). Sibling of `edit` — same FS-jail discipline, the same
 * ADR-0398 ATOMIC commit (the port's `writeFileAtomic` temp+fsync+rename,
 * mode-preserving), the same ADR-0474 stale-read guard (`guardWrite` pre-commit
 * deny ⇒ typed `stale_read` rejection) and the same ticket-11 worktree
 * edit-fence (`resolveEditBase`) — but optimized for the duplicated/bulk case
 * where `edit` would either refuse as ambiguous or be too noisy to use
 * one-occurrence-at-a-time. (T-403 / jun-10 silent-failure finding #1: this
 * tool previously committed via a plain truncating write with NO stale guard —
 * the write-class mirror rule now holds: edit / write / apply_patch /
 * scripted_replace.)
 *
 * Default-OFF posture: the tool is registered, but the LLM only routes to it
 * when the prompt / strategy-hint surface explicitly calls for it. No behavior
 * change for sessions that never invoke it.
 */
const schema = z.object({
  file: z.string().describe("File path (absolute or relative to cwd)"),
  pattern: z.string().describe("Literal substring by default; a JS regex source when isRegex=true"),
  replacement: z
    .string()
    .describe("Replacement string. In regex mode, `$1`/`$&` capture refs are honoured."),
  count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on number of replacements. Omit ⇒ replace ALL matches."),
  isRegex: z
    .boolean()
    .optional()
    .describe("Interpret `pattern` as a JS regex source (compiled with the `g` flag)."),
})

type Input = z.infer<typeof schema>

/** Escape every regex metacharacter so a literal substring is safe to drop
 *  into a `RegExp` constructor. */
const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Maximum allowed pattern length. A user-supplied pattern longer than this
 *  is rejected — both as a sanity check (no legitimate workflow needs a
 *  256-char regex) and as a cheap upper bound on ReDoS surface area. */
const MAX_PATTERN_LEN = 256

/** Wall-clock timeout for one regex application. The replace is wrapped in
 *  `Promise.race` against this timer so a catastrophic backtracker
 *  (`(a+)+$`, `(a|a?)*$`, etc.) cannot hang the agent turn. */
// Removed `REDOS_TIMEOUT_MS` along with the Promise.race wrapper — see the
// long NOTE near the bottom of this file. The remaining defense is the
// static `isReDoSSuspicious` heuristic + `MAX_PATTERN_LEN`.

/**
 * Heuristic ReDoS sanity check on a user-supplied regex source. Catches two
 * documented catastrophic-backtracking signatures plus a length cap:
 *
 * 1. Nested-quantifier: an UNBOUNDED quantifier (`+`/`*`/`{n,}`) INSIDE a
 *    group whose close-paren is itself followed by an unbounded quantifier.
 *    `(a+)+`, `(a*)*`, `((ab)+)+`, `(a{1,})+` all share this shape — the
 *    inner quantifier pumps multiple ways to match the same input, the
 *    outer quantifier multiplies them.
 * 2. Alternation-with-overlap: a group containing `|` followed by an
 *    unbounded quantifier (`(a|a)+`, `(\w|\d)+b`). When alternatives overlap
 *    in their match set the backtracking blows up the same way. This was a
 *    Round 2 finding — the first heuristic missed it because there is no
 *    inner quantifier.
 *
 * Anything > {@link MAX_PATTERN_LEN} characters is rejected outright as a
 * cheap upper bound on ReDoS surface area. There is NO wall-clock backstop:
 * `Promise.race` over a synchronous regex match cannot fire (the engine
 * pins the event loop), so the static heuristic + length cap is the entire
 * defense. See the bottom-of-file NOTE for the worker-thread / re2 path
 * if a future workload requires hard isolation.
 */
const isReDoSSuspicious = (pattern: string): boolean => {
  if (pattern.length > MAX_PATTERN_LEN) return true
  // 1. Nested quantifier — close-paren immediately followed by an unbounded
  //    quantifier (optionally lazy via `?`), preceded by another unbounded
  //    quantifier inside.
  const Q = String.raw`(?:[+*]|\{\d+,\d*\})`
  if (new RegExp(`${Q}\\)\\??${Q}`).test(pattern)) return true
  // 2. Alternation under an unbounded quantifier — `(…|…)` immediately
  //    followed by `+` / `*` / `{n,}`. We deliberately match `(…|…)` flat
  //    (no nested groups inside) since nested alternation cases already get
  //    caught by rule #1's nested quantifier signature.
  if (new RegExp(String.raw`\([^()]*\|[^()]*\)\??${Q}`).test(pattern)) return true
  return false
}

interface ApplyOutcome {
  ok: boolean
  message: string
  next?: string
  replacements?: number
  /** Discriminant on the `ok:false` path so the tool can map to a TYPED
   *  {@link ToolFailure} without regex-sniffing `message`. `not_found` ⇒ the
   *  pattern matched nothing; `rejected` ⇒ a bad/unsafe pattern was refused
   *  (empty / ReDoS-suspicious / uncompilable). Absent on the ok:true path. */
  failureKind?: "not_found" | "rejected"
}

/** Pure replacement core. Returns the new source plus the count actually
 *  applied, or an `ok:false` outcome with a clear message. Extracted from the
 *  tool body so tests / callers can exercise it without filesystem I/O. */
export const applyScriptedReplace = (
  source: string,
  input: Pick<Input, "pattern" | "replacement" | "count" | "isRegex">,
): ApplyOutcome => {
  if (input.pattern === "") {
    return { ok: false, message: "pattern must not be empty", failureKind: "rejected" }
  }
  // SECURITY: reject patterns that look like ReDoS bait BEFORE compiling.
  // A regex like `(a+)+$` is syntactically valid but pumps backtracking
  // exponentially on non-matching input; we never want it to reach the
  // engine. Only checked in regex mode — literal-mode patterns are escaped
  // so the source string cannot smuggle a quantifier in.
  if (input.isRegex === true && isReDoSSuspicious(input.pattern)) {
    return {
      ok: false,
      message:
        "rejected pattern: looks like a catastrophic-backtracking regex " +
        "(nested unbounded quantifier or > 256 chars). Rewrite without " +
        "nested quantifiers, or pass `isRegex: false` for a literal match.",
      failureKind: "rejected",
    }
  }
  let regex: RegExp
  try {
    const body = input.isRegex === true ? input.pattern : escapeForRegex(input.pattern)
    regex = new RegExp(body, "g")
  } catch (e) {
    const reason = errMessage(e)
    return { ok: false, message: `invalid regex: ${reason}`, failureKind: "rejected" }
  }
  const cap = input.count ?? Number.POSITIVE_INFINITY
  let applied = 0
  // String.prototype.replace with a function callback gives us a per-match
  // hook that can both COUNT and ENFORCE the cap; passing the raw replacement
  // string would honour `$1` automatically but couldn't be capped.
  const next = source.replace(regex, (...args) => {
    if (applied >= cap) return args[0] as string
    applied += 1
    // Expand `$&` / `$1`..`$9` against the actual match. `replace`'s function
    // form does NOT auto-expand, so we do it explicitly to keep parity with
    // the documented behaviour.
    return expandReplacement(input.replacement, args)
  })
  if (applied === 0) {
    return { ok: false, message: `pattern not found in file`, failureKind: "not_found" }
  }
  return { ok: true, message: `Replaced ${applied} occurrence(s)`, next, replacements: applied }
}

/**
 * NOTE — there is no `applyScriptedReplaceBounded` async wrapper here.
 *
 * An earlier revision raced `applyScriptedReplace` against a `setTimeout`
 * in a `Promise.race`. That was security theater: V8's regex engine is
 * synchronous and cannot be aborted mid-execution from JS, so a true
 * catastrophic-backtracking match would pin the event loop and prevent the
 * timer callback from firing in the first place. The "timeout" only ever
 * fired for cases where the engine was already going to return quickly.
 *
 * Real ReDoS defense lives in two upstream guards on `applyScriptedReplace`:
 *
 *   1. {@link isReDoSSuspicious} — static heuristic catching nested
 *      quantifiers (`(a+)+`) and alternation-with-overlap (`(a|a)+`), plus
 *      a {@link MAX_PATTERN_LEN} length cap. Patterns flagged here never
 *      reach `new RegExp` at all.
 *   2. The lexical scope of `applyScriptedReplace` — the engine matches
 *      against a single in-memory string the tool just `readFile`'d, so
 *      worst-case input size is bounded by file size and FS jail.
 *
 * If a future workload needs hard wall-clock isolation (untrusted patterns
 * on multi-MB files) the right move is a worker thread or `re2-wasm` /
 * `node-re2`, NOT a Promise.race over a synchronous call.
 */

/** Extract the capture-group list from `String.prototype.replace`'s function-
 *  callback arg tuple. Args layout: [match, p1, p2, ..., offset, string,
 *  groups?]. Returns one entry per group; undefined is preserved so
 *  in-range-but-didn't-participate vs out-of-range stay distinguishable. */
const extractGroups = (args: unknown[]): (string | undefined)[] => {
  let offsetIdx = args.length - 1
  while (offsetIdx >= 0 && typeof args[offsetIdx] !== "number") offsetIdx -= 1
  const groups: (string | undefined)[] = []
  for (let i = 1; i < offsetIdx; i++) {
    const g = args[i]
    groups.push(g === undefined ? undefined : String(g))
  }
  return groups
}

/** Resolve a single `$<next>` placeholder. Returns the expansion text plus
 *  whether the `<next>` char was consumed (true) or should be re-emitted as
 *  a literal `$<next>` (false, native out-of-range behaviour). */
const resolveDollar = (
  nxt: string | undefined,
  match: string,
  groups: readonly (string | undefined)[],
): { text: string; consumed: boolean } => {
  if (nxt === "$") return { text: "$", consumed: true }
  if (nxt === "&") return { text: match, consumed: true }
  if (nxt !== undefined && nxt >= "1" && nxt <= "9") {
    const idx = Number(nxt) - 1
    if (idx < groups.length) {
      // In-range: undefined participating-group ⇒ empty (native behaviour).
      return { text: groups[idx] ?? "", consumed: true }
    }
    // Out-of-range: keep the `$N` token literal (native behaviour).
    return { text: "", consumed: false }
  }
  return { text: "", consumed: false }
}

/** Expand `$&` (whole match) and `$1`..`$9` (capture groups) against the
 *  `replace` callback's argument tuple. `$$` escapes a literal `$`.
 *
 *  Behavior MATCHES JS native `String.prototype.replace` with a string
 *  replacement template:
 *   - `$N` where N is a valid capture index but the group did NOT participate
 *     in the match (e.g. `(a)|(b)` matched the `(a)` branch, `$2` is
 *     undefined) ⇒ empty string. This was already correct.
 *   - `$N` where N is OUT OF RANGE (e.g. `$5` in a regex with two groups)
 *     ⇒ the substring stays LITERAL `$5`. The prior behaviour returned
 *     empty string, which is non-standard (Codex-style "out-of-range =
 *     empty") and surprised callers used to native semantics.
 */
const expandReplacement = (template: string, args: unknown[]): string => {
  const match = String(args[0])
  const groups = extractGroups(args)
  let out = ""
  for (let i = 0; i < template.length; i++) {
    const ch = template[i] as string
    if (ch !== "$" || i === template.length - 1) {
      out += ch
      continue
    }
    const r = resolveDollar(template[i + 1], match, groups)
    if (r.consumed) {
      out += r.text
      i += 1
    } else {
      out += ch
    }
  }
  return out
}

/** Map the pure core's `ok:false` outcome to a typed failure result.
 *  `not_found` ⇒ the pattern matched nothing (no path: the file IS there, the
 *  match isn't); `rejected` ⇒ an empty/uncompilable/ReDoS-suspicious pattern
 *  was refused (carry the reason). `output` is unchanged (byte-identical).
 *  Extracted so `execute` stays under the biome cognitive-complexity cap. */
const replaceFailureResult = (r: ApplyOutcome): ToolResult => {
  const failure: ToolFailure =
    r.failureKind === "rejected" ? { mode: "rejected", reason: r.message } : { mode: "not_found" }
  return { ok: false, output: r.message, failure }
}

/** ADR-0474 — stale-read-guard check for `scripted_replace` (T-403 write-class
 *  mirror rule: edit / write / apply_patch / scripted_replace). Returns a
 *  failure `ToolResult` when the target was READ this session and externally
 *  modified since (mtime advanced past the read-time baseline), else `null`.
 *  No-op (null) when the guard is unwired (`ctx.readFileState` absent — the
 *  kill-switch path) or the file has no baseline (unread ⇒ allowed). The UX is
 *  byte-identical to `write`'s `staleWriteGuard`: a typed `stale_read`
 *  rejection on the NO-THROW path, never a throw out of the iterator. */
const staleReplaceGuard = async (
  fs: FileSystemPort,
  ctx: EditToolContext,
  // ticket-11 — resolved write target (worktree-aware path + session jail base).
  target: { readonly path: string; readonly base: string },
): Promise<ToolResult | null> => {
  if (ctx.readFileState === undefined) return null
  const cur = await fs.statFile(target.path, target.base)
  const guard = guardWrite(ctx.readFileState, cur.path, cur.mtimeMs)
  if (guard.ok) return null
  return {
    ok: false,
    output: guard.error.message,
    failure: { mode: "rejected", reason: "stale_read" },
  }
}

/** ATOMIC commit (ADR-0398 / LANE 1 parity with `edit`/`write`) — route the
 *  scripted_replace commit through the port's crash-safe `writeFileAtomic`
 *  (temp+fsync+rename, mode-preserving) whenever the port provides it, falling
 *  back to the plain truncating `fs.writeFile` ONLY when the port lacks the
 *  atomic method (in-memory test fakes ⇒ byte-identical on-disk result). A
 *  crash mid-commit can never leave a torn / zero-length file under the final
 *  name, and an existing file's mode (e.g. `0o755`) is preserved.
 *
 *  jun-6 tool-interrupt-behavior — the commit runs inside the OPTIONAL critical
 *  section so an in-flight ESC cannot tear a half-written file. `begin?.()` is
 *  undefined when the seam is unwired ⇒ no behaviour change. */
const commitReplace = async (
  fs: FileSystemPort,
  ctx: EditToolContext,
  target: { readonly path: string; readonly base: string },
  next: string,
): Promise<void> => {
  const cs = ctx.criticalSection?.begin()
  try {
    if (fs.writeFileAtomic !== undefined) {
      await fs.writeFileAtomic(target.path, next, target.base)
      return
    }
    await fs.writeFile(target.path, next, target.base)
  } finally {
    cs?.end()
  }
}

/** Build the `scripted_replace` tool against an injected {@link FileSystemPort}
 *  (#13 — the same seam `edit`/`write` expose). `fs` defaults to the real
 *  `@/storage`-backed port, so the exported {@link scriptedReplaceTool} keeps
 *  its registry identity; tests pass a recording / fault-injecting port. */
export const makeScriptedReplaceTool = (
  fs: FileSystemPort = defaultFileSystemPort,
): Tool<Input> => ({
  name: "scripted_replace",
  description:
    "Bulk substring/regex substitution across a file. Use when `edit` reports duplicated matches or context mismatch.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Mutates the filesystem; never run concurrently.
  isConcurrencySafe: () => false,
  // HITL secure-by-default (ADR-0020 follow-up): same workspace-write
  // posture as `edit`/`write` — pre-approval covers it. Required since the
  // fallback for mutating tools is now `always-confirm`.
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
  // jun-6 tool-interrupt-behavior — like `edit`/`write`, the commit is an
  // ATOMIC-intent window: declare `"block"` so the dispatch abort-router
  // withholds the turn abort ONLY while the rename/flush window inside
  // `commitReplace` is open (`ctx.criticalSection`). Default-OFF / inert
  // unless the host wired the seam AND `QUANTA_TOOL_INTERRUPT_BLOCK` is on.
  interruptBehavior: (): "block" => "block",

  async *execute(input: Input, ctx: EditToolContext): AsyncIterable<ToolEvent> {
    // ADR-0091 git-write-protection: a scripted_replace targeting
    // `.git/{hooks,config,config.worktree,info/attributes}` or `.vscode/**` is a
    // code-execution / policy-escape vector exactly as for `write`/`edit`.
    // Static-deny BEFORE any fs read/write, mirroring the FsJailError hard-stop
    // posture below — never a partial write. Default-OFF: when `ctx.gitWriteGuard`
    // is unwired the helper returns null and the path is byte-identical. Runs on
    // the RAW `input.file` (a path-shape matcher, not FS resolution) — same as edit.
    const guardDeny = gitWriteGuardDeny(input.file, ctx)
    if (guardDeny) {
      yield guardDeny
      return
    }
    // ticket-11 (P8 worktree edit-fence) — resolve the effective FS target
    // exactly as `edit` does: a RELATIVE path resolves against an active
    // worktree dir; an ABSOLUTE path STILL jails to the SESSION root. Absent
    // worktree ⇒ `{ path: input.file, base: ctx.cwd }` (byte-identical legacy).
    const target = resolveEditBase(input.file, ctx.cwd, ctx.activeWorktree)
    try {
      // Pre-check existence so the error message is descriptive rather than
      // surfacing the raw `File not found` from readFile.
      if (!(await fs.fileExists(target.path, target.base))) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `File not found: ${input.file}`,
            failure: { mode: "not_found", path: input.file },
          },
        }
        return
      }
      const source = await fs.readFile(target.path, target.base)
      const r = applyScriptedReplace(source, input)
      if (!r.ok || r.next === undefined) {
        // Map the pure-core discriminant to a typed failure (see
        // `replaceFailureResult`); `output` is unchanged (byte-identical).
        yield { type: "result", result: replaceFailureResult(r) }
        return
      }
      // ADR-0474 stale-read-guard — AFTER planning, BEFORE the commit (a deny
      // is never a partial write). Unwired guard ⇒ `null` ⇒ byte-identical.
      const staleDeny = await staleReplaceGuard(fs, ctx, target)
      if (staleDeny) {
        yield { type: "result", result: staleDeny }
        return
      }
      // Per-turn exfil write budget: this is the same pre-commit position as
      // write/edit. A denied replacement has completed all read/planning work
      // but must never enter the atomic commit window.
      const budgetDeny = writeBudgetDeny(ctx)
      if (budgetDeny) {
        yield { type: "result", result: budgetDeny }
        return
      }
      // ADR-0398 ATOMIC commit — temp+fsync+rename via the port (crash-safe,
      // mode-preserving), inside the OPTIONAL critical section.
      await commitReplace(fs, ctx, target, r.next)
      // jul-13 edit-fresh-hash (shared with edit/write): refresh the stale-read
      // guard baseline to the just-written mtime AND advertise the post-write
      // sha256 so the model can chain an edit to this file without a re-read.
      // Both gated by ctx.editFreshHash ⇒ byte-identical when off.
      await refreshStaleReadBaseline(fs, ctx, target)
      yield {
        type: "result",
        result: {
          ok: true,
          output: `${input.file}: ${r.message} (replacements=${r.replacements})${freshHashNote(ctx, r.next)}`,
        },
      }
    } catch (e) {
      if (e instanceof FsJailError) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: e.message,
            failure: { mode: "permission_denied", path: input.file, isReadonly: false },
          },
        }
        return
      }
      throw e
    }
  },
})

/** Default-port `scripted_replace` tool used by the registry. */
export const scriptedReplaceTool: Tool<Input> = makeScriptedReplaceTool()
