import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"

/**
 * `parse_test_failure` — Stage-3 fault-localization aid. Extracts `file:line`
 * locations from raw test/build output across common frameworks. Codex ranks
 * build/test logs at 8/9 trust (`docs/reviews-codex-agent/may-20-codex-signal.md`):
 * a stack-trace frame or assertion line is a HIGHER-trust edit-location signal
 * than any search hit, because it is where the code ACTUALLY failed.
 *
 * Pure function over the provided `output` string — no I/O, no shell, no cwd
 * use. Read-only and concurrency-safe by construction. The model pipes
 * `test_runner` / `bash` stderr (or a pasted CI log) in and gets a deduped,
 * ranked list of candidate edit locations out.
 *
 * Frameworks recognized (pattern-tagged): pytest / python-traceback / jest /
 * vitest / bun-test / go-test / cargo-test / generic `path:line:col`.
 */

const schema = z.object({
  output: z.string().describe("Raw test or build output (stdout+stderr) to parse"),
  max_results: z.number().int().positive().max(100).optional().describe("Cap rows (default 30)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_MAX = 30

/** Where a frame's file sits in the edit-likelihood hierarchy. Codex ranks the
 *  user-code assertion frame far above library/stdlib frames — the real edit
 *  location is almost never inside vendored code. `user` ranks above `test`
 *  because a failing assertion's CAUSE is usually in the code under test, not
 *  the test harness; both rank far above `vendored`. */
export type FrameTier = "user" | "test" | "vendored"

const TIER_RANK: Record<FrameTier, number> = { user: 0, test: 1, vendored: 2 }

/** Vendored / third-party / build-output / generator-noise path fragments. A
 *  frame whose file matches any of these is noise for fault localization — the
 *  edit goes in user code, not here. Covers JS (node_modules/.pnp), Python
 *  (site-packages/.venv/dist-packages), Rust (.cargo/target), system libs,
 *  common build output dirs, and (R-Phase10) generator/eval output dirs
 *  (runs/outputs), coverage trees (coverage/.nyc_output), and log dumps —
 *  these consistently outranked source files in localize per-query data. */
const VENDORED_RE =
  /(?:^|\/)(?:node_modules|\.pnp|site-packages|dist-packages|\.venv|venv|\.cargo|vendor|third_party|\.tox|__pycache__)(?:\/)|(?:^|\/)(?:dist|build|out|target\/(?:debug|release)|runs|outputs|coverage|\.nyc_output|logs)\/|^\/usr\/(?:lib|local\/lib)\//

/** Test-file path/name heuristics across ecosystems. */
const TEST_FILE_RE =
  /(?:^|\/)tests?\/|(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rs)$|(?:^|\/)test_[^/]*\.py$|Test\.java$|Tests?\.cs$/

/** Classify a file path into its edit-likelihood tier. */
export const classifyFrame = (file: string): FrameTier => {
  if (VENDORED_RE.test(file)) return "vendored"
  if (TEST_FILE_RE.test(file)) return "test"
  return "user"
}

export interface FailureFrame {
  file: string
  line: number
  framework: string
  message: string
  /** Edit-likelihood tier (user > test > vendored). R-Phase8 ranking. */
  tier: FrameTier
}

/** One regex rule: a framework tag + a matcher that yields {file,line,message}
 *  per match. Order matters — earlier (more specific) rules win the framework
 *  tag for a given file:line. */
interface Rule {
  framework: string
  re: RegExp
  map: (m: RegExpExecArray) => { file: string; line: number; message: string } | undefined
}

const num = (s: string | undefined): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : Number.NaN
}

/** Heuristic: a plausible source-file token (has an extension, no spaces). */
const looksLikeFile = (f: string): boolean => /\.[A-Za-z0-9]+$/.test(f) && !/\s/.test(f)

const RULES: Rule[] = [
  // Python traceback frame: `  File "path/x.py", line 42, in func`
  {
    framework: "python-traceback",
    re: /File "([^"]+)", line (\d+)(?:, in (\S+))?/g,
    map: (m) => ({
      file: m[1] as string,
      line: num(m[2]),
      message: m[3] ? `in ${m[3]}` : "",
    }),
  },
  // Rust panic (new + old): `panicked at src/lib.rs:42:9:` / `panicked at 'msg', src/lib.rs:42:9`
  {
    framework: "cargo-test",
    re: /panicked at (?:'([^']*)',\s*)?([^\s:]+\.rs):(\d+):\d+/g,
    map: (m) => ({
      file: m[2] as string,
      line: num(m[3]),
      message: m[1] ? `panic: ${m[1]}` : "panic",
    }),
  },
  // Go test: `    file_test.go:42: message`
  {
    framework: "go-test",
    re: /^\s*([^\s:]+\.go):(\d+):\s*(.*)$/gm,
    map: (m) => ({ file: m[1] as string, line: num(m[2]), message: (m[3] ?? "").trim() }),
  },
  // JS stack frame (jest/vitest/bun/node): `at fn (/path/x.ts:12:34)` or `(/path/x.ts:12:34)`
  {
    framework: "js-stack",
    re: /\(?([^\s():]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\)?/g,
    map: (m) => ({ file: m[1] as string, line: num(m[2]), message: "" }),
  },
  // pytest short form: `path/test_x.py:123: AssertionError` (line:col optional)
  {
    framework: "pytest",
    re: /^([^\s:]+\.py):(\d+):(?:\d+:)?\s*(.*)$/gm,
    map: (m) => ({ file: m[1] as string, line: num(m[2]), message: (m[3] ?? "").trim() }),
  },
  // Generic fallback: `path:line:col` or `path:line` anywhere on a line.
  {
    framework: "generic",
    re: /(?:^|\s)([^\s:]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?(?=[\s:]|$)/g,
    map: (m) => ({ file: m[1] as string, line: num(m[2]), message: "" }),
  },
]

/** Parse `output` into deduped failure frames, first-rule-wins on framework
 *  tag for a given `file:line` key, then RANK so the most-likely edit location
 *  surfaces first: user-code frames before test frames before vendored frames
 *  (stable within each tier to preserve discovery/stack order). The cap is
 *  applied AFTER ranking so a flood of `node_modules` frames can never push the
 *  real user-code frame past `maxResults` (R-Phase8 #1). Exported pure. */
export const parseTestFailure = (output: string, maxResults: number): FailureFrame[] => {
  const byKey = new Map<string, FailureFrame>()
  let discovery = 0
  const order = new Map<string, number>()
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null = rule.re.exec(output)
    while (m !== null) {
      const mapped = rule.map(m)
      if (mapped && Number.isFinite(mapped.line) && looksLikeFile(mapped.file)) {
        const key = `${mapped.file}:${mapped.line}`
        if (!byKey.has(key)) {
          byKey.set(key, { ...mapped, framework: rule.framework, tier: classifyFrame(mapped.file) })
          order.set(key, discovery++)
        } else if (mapped.message) {
          // Enrich an existing frame's empty message without changing its tag.
          const cur = byKey.get(key) as FailureFrame
          if (cur.message === "") cur.message = mapped.message
        }
      }
      m = rule.re.exec(output)
    }
  }
  const keyOf = (f: FailureFrame): string => `${f.file}:${f.line}`
  return [...byKey.values()]
    .sort((a, b) => {
      const t = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (t !== 0) return t
      return (order.get(keyOf(a)) ?? 0) - (order.get(keyOf(b)) ?? 0)
    })
    .slice(0, maxResults)
}

const render = (frames: FailureFrame[]): string => {
  if (frames.length === 0) return "(no file:line locations found in output)"
  // Tier marker only for non-user frames (user frames are the default / most
  // likely target — keeping them unmarked keeps the high-signal rows clean).
  const tierMark = (t: FrameTier): string => (t === "user" ? "" : `  «${t}»`)
  return frames
    .map(
      (f) =>
        `${f.file}:${f.line}  [${f.framework}]${tierMark(f.tier)}${f.message ? `  ${f.message}` : ""}`,
    )
    .join("\n")
}

export const parseTestFailureTool: Tool<Input> = {
  name: "parse_test_failure",
  description:
    "Extract + rank candidate edit locations (file:line) from raw test/build " +
    "output. Recognizes pytest, python traceback, jest/vitest/bun, go test, " +
    "cargo. Ranks user-code frames above test frames above vendored " +
    "(node_modules/site-packages/…) noise. Stage 3 of fault localization.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  // biome-ignore lint/correctness/useYield: single-result generator (pure parse, no progress)
  async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const frames = parseTestFailure(input.output, input.max_results ?? DEFAULT_MAX)
    yield { type: "result", result: { ok: true, output: render(frames) } }
  },
}
