/**
 * GOAL-05A — `/goal` argv parser. PURE and policy-free: it turns the slash
 * argv into exactly one typed {@link GoalCommand} or one typed error. It never
 * reads the authority, never decides a transition, and never predicts a
 * status — `goal-control.ts` owns the single commit per command and
 * `goal-render.ts` owns the report.
 *
 * Grammar (verbs are the first token):
 *   /goal                                  show
 *   /goal <text…>                          create (refused later if one exists)
 *   /goal edit [--keep-contract] <text…>   replace (fresh generation)
 *   /goal pause | stop | resume | clear    explicit status / deletion (stop = pause)
 *   /goal criterion add <description…>
 *   /goal criterion edit <criterionId> <description…>
 *   /goal criterion remove|complete|reopen <criterionId>
 *   /goal check add <description…> [--timeout-ms N] [--success-exit N,…] -- <argv…>
 *   /goal check edit <checkId> <description…> [options] -- <argv…>
 *   /goal check remove <checkId>
 *   /goal budget --max-turns=N --max-tokens=N   (`--flag N` form accepted too)
 *   /goal verify
 *   /goal work <instruction…>
 *
 * Rail 9: a check needs the `--` separator, a non-empty bounded argv, bounded
 * element length, and a timeout within the verifier's ceiling — all refused
 * HERE, before any store is consulted.
 */

import { type CheckSpecDeclaration, MAX_CHECK_TIMEOUT_MS } from "@/objective"

/** Upper bound on argv elements one check may carry (CLI input cap). */
export const MAX_CHECK_ARGV_ITEMS = 64
/** Upper bound on one argv element's length (CLI input cap). */
export const MAX_CHECK_ARGV_ITEM_CHARS = 1024
/** A check without `--timeout-ms` runs under the verifier's own ceiling —
 *  the flag only TIGHTENS it. */
export const DEFAULT_CHECK_TIMEOUT_MS = MAX_CHECK_TIMEOUT_MS
/** A check without `--success-exit` passes on exit code 0 only. */
export const DEFAULT_CHECK_SUCCESS_EXIT_CODES: readonly number[] = Object.freeze([0])

export type GoalCommand =
  | { readonly kind: "show" }
  | { readonly kind: "create"; readonly text: string }
  | { readonly kind: "edit"; readonly text: string; readonly keepContract: boolean }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "clear" }
  | { readonly kind: "criterion-add"; readonly text: string }
  | { readonly kind: "criterion-edit"; readonly criterionId: string; readonly text: string }
  | { readonly kind: "criterion-remove"; readonly criterionId: string }
  | { readonly kind: "criterion-complete"; readonly criterionId: string }
  | { readonly kind: "criterion-reopen"; readonly criterionId: string }
  | { readonly kind: "check-add"; readonly text: string; readonly check: CheckSpecDeclaration }
  | {
      readonly kind: "check-edit"
      readonly checkId: string
      readonly text: string
      readonly check: CheckSpecDeclaration
    }
  | { readonly kind: "check-remove"; readonly checkId: string }
  | {
      readonly kind: "budget"
      readonly budget: { readonly maxTurns?: number; readonly maxTokens?: number }
    }
  | { readonly kind: "verify" }
  | { readonly kind: "work"; readonly instruction: string }

export type GoalParse =
  | { readonly ok: true; readonly command: GoalCommand }
  | { readonly ok: false; readonly error: string }

const fail = (error: string): GoalParse => ({ ok: false, error })
const done = (command: GoalCommand): GoalParse => ({ ok: true, command })

const joined = (parts: readonly string[]): string => parts.join(" ").trim()

const parseNonNegInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

// ── criterion ────────────────────────────────────────────────────────────────

const parseCriterion = (rest: readonly string[]): GoalParse => {
  const [verb, ...tail] = rest
  switch (verb) {
    case "add": {
      const text = joined(tail)
      return text === ""
        ? fail("/goal criterion add: requires <description>")
        : done({ kind: "criterion-add", text })
    }
    case "edit": {
      const [criterionId, ...desc] = tail
      if (criterionId === undefined) return fail("/goal criterion edit: requires <criterionId>")
      const text = joined(desc)
      return text === ""
        ? fail("/goal criterion edit: requires <description>")
        : done({ kind: "criterion-edit", criterionId, text })
    }
    case "remove":
    case "complete":
    case "reopen": {
      const criterionId = tail[0]
      if (criterionId === undefined || tail.length !== 1) {
        return fail(`/goal criterion ${verb}: requires <criterionId>`)
      }
      return done({ kind: `criterion-${verb}`, criterionId })
    }
    default:
      return fail(
        `/goal criterion: unknown criterion verb '${verb ?? ""}' (expected add|edit|remove|complete|reopen)`,
      )
  }
}

// ── check ────────────────────────────────────────────────────────────────────

type CheckArgv =
  | { readonly ok: true; readonly argv: string[] }
  | { readonly ok: false; readonly error: string }

/** Rail 9 bounds on the argv after `--`: non-empty, bounded count, bounded element length. */
const parseCheckArgv = (verb: string, argv: readonly string[]): CheckArgv => {
  if (argv.length === 0) {
    return { ok: false, error: `/goal check ${verb}: argv must not be empty after \`--\`` }
  }
  if (argv.length > MAX_CHECK_ARGV_ITEMS) {
    return {
      ok: false,
      error: `/goal check ${verb}: argv has ${argv.length} elements (max ${MAX_CHECK_ARGV_ITEMS})`,
    }
  }
  if (argv.some((a) => a.length === 0 || a.length > MAX_CHECK_ARGV_ITEM_CHARS)) {
    return {
      ok: false,
      error: `/goal check ${verb}: argv element must be 1..${MAX_CHECK_ARGV_ITEM_CHARS} chars`,
    }
  }
  return { ok: true, argv: [...argv] }
}

type CheckOptions =
  | {
      readonly ok: true
      readonly words: string[]
      readonly timeoutMs: number
      readonly successExitCodes: number[]
    }
  | { readonly ok: false; readonly error: string }

const parseTimeoutFlag = (verb: string, raw: string | undefined): number | string => {
  const n = parseNonNegInt(raw)
  return n === undefined || n <= 0 || n > MAX_CHECK_TIMEOUT_MS
    ? `/goal check ${verb}: --timeout-ms must be 1..${MAX_CHECK_TIMEOUT_MS}`
    : n
}

const parseSuccessExitFlag = (verb: string, raw: string | undefined): number[] | string => {
  const codes = raw?.split(",").map((c) => parseNonNegInt(c.trim()))
  return codes === undefined || codes.length === 0 || codes.some((c) => c === undefined)
    ? `/goal check ${verb}: --success-exit expects a comma-separated list of exit codes`
    : (codes as number[])
}

/** The words + option flags BEFORE `--`. Defaults come from the verifier ceiling. */
const parseCheckOptions = (verb: string, head: readonly string[]): CheckOptions => {
  let timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
  let successExitCodes: number[] = [...DEFAULT_CHECK_SUCCESS_EXIT_CODES]
  const words: string[] = []
  for (let i = 0; i < head.length; i += 1) {
    const tok = head[i] as string
    if (tok === "--timeout-ms") {
      const parsed = parseTimeoutFlag(verb, head[i + 1])
      if (typeof parsed === "string") return { ok: false, error: parsed }
      timeoutMs = parsed
      i += 1
    } else if (tok === "--success-exit") {
      const parsed = parseSuccessExitFlag(verb, head[i + 1])
      if (typeof parsed === "string") return { ok: false, error: parsed }
      successExitCodes = parsed
      i += 1
    } else {
      words.push(tok)
    }
  }
  return { ok: true, words, timeoutMs, successExitCodes }
}

type CheckHead =
  | { readonly ok: true; readonly text: string; readonly check: CheckSpecDeclaration }
  | { readonly ok: false; readonly error: string }

/** Split `<words… [options] -- argv…>` into a description + a check declaration. */
const parseCheckHead = (verb: string, rest: readonly string[]): CheckHead => {
  const sep = rest.indexOf("--")
  if (sep === -1) {
    return { ok: false, error: `/goal check ${verb}: requires \`--\` before the command argv` }
  }
  const argv = parseCheckArgv(verb, rest.slice(sep + 1))
  if (!argv.ok) return argv
  const options = parseCheckOptions(verb, rest.slice(0, sep))
  if (!options.ok) return options
  const text = joined(options.words)
  if (text === "") return { ok: false, error: `/goal check ${verb}: requires <description>` }
  return {
    ok: true,
    text,
    check: {
      kind: "command",
      argv: argv.argv,
      timeoutMs: options.timeoutMs,
      successExitCodes: options.successExitCodes,
    },
  }
}

const parseCheck = (rest: readonly string[]): GoalParse => {
  const [verb, ...tail] = rest
  if (verb === "add") {
    const head = parseCheckHead(verb, tail)
    return head.ok
      ? done({ kind: "check-add", text: head.text, check: head.check })
      : fail(head.error)
  }
  if (verb === "edit") {
    const [checkId, ...more] = tail
    if (checkId === undefined || checkId === "--")
      return fail("/goal check edit: requires <checkId>")
    const head = parseCheckHead(verb, more)
    return head.ok
      ? done({ kind: "check-edit", checkId, text: head.text, check: head.check })
      : fail(head.error)
  }
  if (verb === "remove") {
    const checkId = tail[0]
    if (checkId === undefined || tail.length !== 1)
      return fail("/goal check remove: requires <checkId>")
    return done({ kind: "check-remove", checkId })
  }
  return fail(`/goal check: unknown check verb '${verb ?? ""}' (expected add|edit|remove)`)
}

// ── budget ───────────────────────────────────────────────────────────────────

const BUDGET_FLAGS: Record<string, "maxTurns" | "maxTokens"> = {
  "--max-turns": "maxTurns",
  "--max-tokens": "maxTokens",
}

const parseBudget = (rest: readonly string[]): GoalParse => {
  const budget: { maxTurns?: number; maxTokens?: number } = {}
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i] as string
    const eq = tok.indexOf("=")
    const flag = eq === -1 ? tok : tok.slice(0, eq)
    const key = BUDGET_FLAGS[flag]
    if (key === undefined)
      return fail(
        `/goal budget: unknown budget flag '${flag}' (expected --max-turns / --max-tokens)`,
      )
    const raw = eq === -1 ? rest[i + 1] : tok.slice(eq + 1)
    if (eq === -1) i += 1
    const n = parseNonNegInt(raw)
    if (n === undefined) return fail(`/goal budget: ${flag} expects a non-negative integer`)
    budget[key] = n
  }
  if (budget.maxTurns === undefined && budget.maxTokens === undefined) {
    return fail("/goal budget: requires --max-turns=N and/or --max-tokens=N")
  }
  return done({ kind: "budget", budget })
}

// ── entry ────────────────────────────────────────────────────────────────────

const SIMPLE: Record<string, GoalCommand> = {
  pause: { kind: "pause" },
  stop: { kind: "pause" },
  resume: { kind: "resume" },
  clear: { kind: "clear" },
  verify: { kind: "verify" },
  show: { kind: "show" },
}

export const parseGoalArgs = (args: readonly string[]): GoalParse => {
  const [verb, ...rest] = args
  if (verb === undefined || (args.length === 1 && verb === "")) return done({ kind: "show" })
  const simple = SIMPLE[verb]
  if (simple !== undefined) return done(simple)
  switch (verb) {
    case "edit": {
      const keepContract = rest[0] === "--keep-contract"
      const text = joined(keepContract ? rest.slice(1) : rest)
      return text === ""
        ? fail("/goal edit: requires <text>")
        : done({ kind: "edit", text, keepContract })
    }
    case "criterion":
      return parseCriterion(rest)
    case "check":
      return parseCheck(rest)
    case "budget":
      return parseBudget(rest)
    case "work": {
      const instruction = joined(rest)
      return instruction === ""
        ? fail("/goal work: requires <instruction>")
        : done({ kind: "work", instruction })
    }
    default:
      break
  }
  // Anything else is goal text (a one-word goal included — `/goal ship` has
  // always been a create; the verbs above are exact matches).
  return done({ kind: "create", text: joined(args) })
}
