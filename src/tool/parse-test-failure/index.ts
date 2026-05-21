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

export interface FailureFrame {
  file: string
  line: number
  framework: string
  message: string
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
 *  tag for a given `file:line` key. Exported pure for unit tests. */
export const parseTestFailure = (output: string, maxResults: number): FailureFrame[] => {
  const byKey = new Map<string, FailureFrame>()
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null = rule.re.exec(output)
    while (m !== null) {
      const mapped = rule.map(m)
      if (mapped && Number.isFinite(mapped.line) && looksLikeFile(mapped.file)) {
        const key = `${mapped.file}:${mapped.line}`
        if (!byKey.has(key)) {
          byKey.set(key, { ...mapped, framework: rule.framework })
        } else if (mapped.message) {
          // Enrich an existing frame's empty message without changing its tag.
          const cur = byKey.get(key) as FailureFrame
          if (cur.message === "") cur.message = mapped.message
        }
      }
      m = rule.re.exec(output)
    }
  }
  return [...byKey.values()].slice(0, maxResults)
}

const render = (frames: FailureFrame[]): string => {
  if (frames.length === 0) return "(no file:line locations found in output)"
  return frames
    .map((f) => `${f.file}:${f.line}  [${f.framework}]${f.message ? `  ${f.message}` : ""}`)
    .join("\n")
}

export const parseTestFailureTool: Tool<Input> = {
  name: "parse_test_failure",
  description:
    "Extract candidate edit locations (file:line) from raw test/build output. " +
    "Recognizes pytest, python traceback, jest/vitest/bun, go test, cargo. " +
    "Use in Stage 3 of fault localization — log frames outrank search hits.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  // biome-ignore lint/correctness/useYield: single-result generator (pure parse, no progress)
  async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const frames = parseTestFailure(input.output, input.max_results ?? DEFAULT_MAX)
    yield { type: "result", result: { ok: true, output: render(frames) } }
  },
}
