import type { Tool, ToolContext, ToolEvent } from "../types"
import { isNotARepo, safeRun } from "./_shared"
import { type GitBlameInput, type GitRunner, gitBlameInputSchema } from "./types"

const isNoSuchPath = (stderr: string): boolean =>
  /no such (path|file)/i.test(stderr) || /does not exist/i.test(stderr)
const isLineOutOfRange = (stderr: string): boolean =>
  /has only \d+ lines?/i.test(stderr) || /out of range/i.test(stderr)

interface BlameFrame {
  hash: string
  author: string
  authorTime: string // unix seconds
  summary: string
  content: string
}

/** Parse the first porcelain frame from `git blame --porcelain -L line,line`.
 *  Format (one commit, one line):
 *    <hash> <orig_line> <final_line> <count>
 *    key value
 *    …
 *    \t<actual line content>
 */
const parsePorcelain = (stdout: string): BlameFrame | null => {
  const lines = stdout.split("\n")
  const headerIdx = lines.findIndex((l) => /^[0-9a-f]{40}\s/.test(l))
  if (headerIdx < 0) return null
  const header = lines[headerIdx]
  if (!header) return null
  const frame: BlameFrame = {
    hash: header.split(" ")[0] ?? "",
    author: "",
    authorTime: "",
    summary: "",
    content: "",
  }
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    if (line.startsWith("\t")) {
      frame.content = line.slice(1)
      break
    }
    applyKv(line, frame)
  }
  return frame
}

const applyKv = (line: string, frame: BlameFrame): void => {
  const sp = line.indexOf(" ")
  const key = sp < 0 ? line : line.slice(0, sp)
  const value = sp < 0 ? "" : line.slice(sp + 1)
  if (key === "author") frame.author = value
  else if (key === "author-time") frame.authorTime = value
  else if (key === "summary") frame.summary = value
}

const toIsoDate = (unixSeconds: string): string => {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return "unknown-date"
  return new Date(n * 1000).toISOString().slice(0, 10)
}

const classifyBlameError = (
  stderr: string,
  exitCode: number,
  file: string,
  line: number,
): string => {
  const trimmed = stderr.trim()
  if (isNotARepo(stderr)) return trimmed || "not a git repository"
  if (isNoSuchPath(stderr)) return trimmed || `no such file: ${file}`
  if (isLineOutOfRange(stderr)) return trimmed || `line ${line} out of range`
  return trimmed || `git blame exited ${exitCode}`
}

const formatFrame = (frame: BlameFrame, file: string, line: number): string => {
  const short = frame.hash.slice(0, 8)
  const date = toIsoDate(frame.authorTime)
  const header = `${file}:${line}  ${short}  (${frame.author}, ${date})  ${frame.summary}`
  return `${header}\n  > ${frame.content}`
}

export const gitBlameTool = (runner: GitRunner): Tool<GitBlameInput> => ({
  name: "git_blame",
  description: "Show commit, author and date that last touched one line.",
  inputSchema: gitBlameInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitBlameInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitBlameInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { file, line } = parsed.data
    const args = ["blame", "-L", `${line},${line}`, "--porcelain", "--", file]
    yield { type: "progress", message: `git blame ${file}:${line}` }

    const out = await safeRun(runner, args, ctx.cwd, "git blame")
    if (out.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: out.message } }
      return
    }
    const r = out.result
    if (r.exitCode !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: classifyBlameError(r.stderr, r.exitCode, file, line) },
      }
      return
    }
    const frame = parsePorcelain(r.stdout)
    if (!frame) {
      yield { type: "result", result: { ok: false, output: "could not parse blame output" } }
      return
    }
    yield { type: "result", result: { ok: true, output: formatFrame(frame, file, line) } }
  },
})
