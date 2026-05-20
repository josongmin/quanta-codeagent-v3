import { z } from "zod"
import { FsJailError, fileExists, readFile, writeFile } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "./types"

/**
 * Phase 4 SOTA++ absorption — `scripted_replace` (Codex
 * `tool-routing-and-triggering.md`: "patch is for local + stable context;
 * scripted replace is for duplicated blocks, bulk substitution, or patch
 * context mismatch"). Sibling of `edit` — same FS-jail discipline + atomic
 * write — but optimized for the duplicated/bulk case where `edit` would either
 * refuse as ambiguous or be too noisy to use one-occurrence-at-a-time.
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
}

/** Pure replacement core. Returns the new source plus the count actually
 *  applied, or an `ok:false` outcome with a clear message. Extracted from the
 *  tool body so tests / callers can exercise it without filesystem I/O. */
export const applyScriptedReplace = (
  source: string,
  input: Pick<Input, "pattern" | "replacement" | "count" | "isRegex">,
): ApplyOutcome => {
  if (input.pattern === "") {
    return { ok: false, message: "pattern must not be empty" }
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
    }
  }
  let regex: RegExp
  try {
    const body = input.isRegex === true ? input.pattern : escapeForRegex(input.pattern)
    regex = new RegExp(body, "g")
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `invalid regex: ${reason}` }
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
    return { ok: false, message: `pattern not found in file` }
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

export const scriptedReplaceTool: Tool<Input> = {
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

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    try {
      // Pre-check existence so the error message is descriptive rather than
      // surfacing the raw `File not found` from readFile.
      if (!(await fileExists(input.file, ctx.cwd))) {
        yield { type: "result", result: { ok: false, output: `File not found: ${input.file}` } }
        return
      }
      const source = await readFile(input.file, ctx.cwd)
      const r = applyScriptedReplace(source, input)
      if (!r.ok || r.next === undefined) {
        yield { type: "result", result: { ok: false, output: r.message } }
        return
      }
      await writeFile(input.file, r.next, ctx.cwd)
      yield {
        type: "result",
        result: {
          ok: true,
          output: `${input.file}: ${r.message} (replacements=${r.replacements})`,
        },
      }
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
  },
}
