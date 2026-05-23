import type * as readline from "node:readline/promises"
import type { IdleMonitor } from "../idle-monitor"
import type { ImageQueue } from "../image-queue"
import type { PromptHistory } from "../prompt-history"
import { AbortError, readLine } from "../raw-line-reader"
import { describeSlashCommand, type SkillRow, slashCompleter } from "../slash-commands"
import { tryRunReplSlash } from "./prompt-source"

/** Interactive REPL loop: each line continues the same conversation.
 *
 *  Slash commands routed in-REPL (Codex `forceReloadSkills` parity for
 *  `/skills` and `/reload-skills`): when the user types `/<letter>…`,
 *  short-circuit to {@link runSlashCommand} with `slashCtx` instead of sending
 *  it to the model. `/exit` / `/quit` keep their existing meaning (loop break)
 *  and are checked BEFORE the slash dispatch so they cannot be hijacked by a
 *  future registered command of the same name. Empty `slashCtx` ⇒ commands
 *  that need session state print "not wired" and exit 0 (default-OFF). */
export const runReplLoop = async (
  rl: readline.Interface,
  signal: AbortSignal,
  turn: (text: string) => Promise<void>,
  slashCtx?: Partial<{
    skills: () => Promise<SkillRow[]>
    idle: IdleMonitor
    imageQueue: ImageQueue
  }>,
): Promise<void> => {
  while (!signal.aborted) {
    const input = (await rl.question("\nquanta› ")).trim()
    if (input === "") continue
    if (input === "/exit" || input === "/quit") break
    if (await tryRunReplSlash(input, slashCtx)) continue
    await turn(input)
  }
}

/** Production REPL loop with REAL `<Tab>` autocompletion.
 *
 *  Bun's `node:readline` polyfill ignores the `completer` option (probe-
 *  verified 2026-05), so this variant bypasses readline entirely and reads
 *  lines via raw-mode keypress events through {@link readLine}. Sibling
 *  prompts (permission confirm) that don't need completion still go through
 *  an ad-hoc `readline/promises` `question()` — see `runRepl`.
 *
 *  Kept separate from {@link runReplLoop} so the existing readline-based
 *  test harness (`tests/unit/apps/cli/skills-slash-hellgate.test.ts`) is
 *  unaffected: tests inject a fake readline through `runReplLoop`; the CLI
 *  entry point dispatches to `runReplLoopRaw` instead. */
export interface RunReplLoopRawOptions {
  readonly signal: AbortSignal
  readonly turn: (text: string) => Promise<void>
  readonly slashCtx?: Partial<{
    skills: () => Promise<SkillRow[]>
    idle: IdleMonitor
    imageQueue: ImageQueue
  }>
  /** Meta line painted under the prompt (Codex-style composer). Typical
   *  content: `provider · model · ~/cwd`. Absent ⇒ no meta row. */
  readonly meta?: string
  /** Optional bash-style prompt history. Default OFF when undefined —
   *  raw-line-reader stays byte-identical to the no-history path. */
  readonly history?: PromptHistory
  /** Heredoc multiline mode. Default OFF; opt-in via QUANTA_MULTILINE. */
  readonly multiline?: boolean
}

/** Read one raw-mode line for the runReplLoopRaw inner loop. Split off so
 *  the loop body stays under the biome cognitive-complexity budget. Returns
 *  the trimmed input, or `null` when the read was aborted via `signal`. */
const readRawReplLine = async (opts: RunReplLoopRawOptions): Promise<string | null> => {
  const { signal, meta, history, multiline } = opts
  try {
    const raw = await readLine({
      prompt: "› ",
      completer: (line) => slashCompleter(line)[0],
      describe: describeSlashCommand,
      ...(meta !== undefined ? { meta } : {}),
      ...(history !== undefined ? { history } : {}),
      ...(multiline === true ? { multiline: true } : {}),
      signal,
    })
    return raw.trim()
  } catch (e) {
    if (e instanceof AbortError) return null
    throw e
  }
}

export const runReplLoopRaw = async (opts: RunReplLoopRawOptions): Promise<void> => {
  const { signal, turn, slashCtx } = opts
  process.stderr.write("\n")
  while (!signal.aborted) {
    const input = await readRawReplLine(opts)
    if (input === null) return
    if (input === "") {
      process.stderr.write("\n")
      continue
    }
    if (input === "/exit" || input === "/quit") break
    if (await tryRunReplSlash(input, slashCtx)) {
      process.stderr.write("\n")
      continue
    }
    await turn(input)
    process.stderr.write("\n")
  }
}
