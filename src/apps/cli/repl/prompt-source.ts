import type { PromptSource } from "@/runner"
import type { IdleMonitor } from "../idle-monitor"
import { runImageCmd } from "../image-cmd"
import type { ImageQueue } from "../image-queue"
import type { PromptHistory } from "../prompt-history"
import { AbortError, readLine } from "../raw-line-reader"
import {
  describeSlashCommand,
  isSlashCommand,
  runSlashCommand,
  type SkillRow,
  slashCompleter,
} from "../slash-commands"

/** Try to handle `input` as an in-REPL slash command. Returns true iff the
 *  input was routed (caller should `continue` the outer loop); false ⇒ the
 *  caller must send it to the model via `turn(...)`. Extracted from
 *  `runReplLoop` to keep that function under the biome cognitive-complexity
 *  budget. `isSlashCommand` rejects paths like `/path/to/x` so legacy
 *  file-resume tokens still fall through to the agent path. */
export const tryRunReplSlash = async (
  input: string,
  slashCtx?: Partial<{
    skills: () => Promise<SkillRow[]>
    idle: IdleMonitor
    imageQueue: ImageQueue
  }>,
): Promise<boolean> => {
  const head = input.split(/\s+/)[0] ?? ""
  if (!isSlashCommand(head)) return false
  // ADR-0083 multi-modal: `/image add|list|clear` is in-REPL only (the queue
  // is REPL-scoped surface state; the global `BUILTINS` table has no session
  // context). Short-circuit BEFORE delegating to the surface-agnostic
  // dispatcher so the queue mutation stays inside this surface.
  if (head === "/image" && slashCtx?.imageQueue !== undefined) {
    runImageCmd(input, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      cwd: process.cwd(),
      queue: slashCtx.imageQueue,
    })
    return true
  }
  await runSlashCommand(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    ...(slashCtx?.skills !== undefined ? { skills: slashCtx.skills } : {}),
    ...(slashCtx?.idle !== undefined ? { idle: slashCtx.idle } : {}),
  })
  return true
}

/** Read one trimmed line from the raw-mode reader. Returns `null` on
 *  AbortError (the prompt was aborted via `signal`). Other exceptions
 *  propagate to the caller. Extracted from {@link buildCliPromptSource} to
 *  keep its `next` closure under the biome cognitive-complexity budget. */
export const readReplLine = async (
  signal: AbortSignal | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): Promise<string | null> => {
  try {
    const raw = await readLine({
      prompt: "› ",
      completer: (line) => slashCompleter(line)[0],
      describe: describeSlashCommand,
      ...(signal !== undefined ? { signal } : {}),
      ...(uxOpts?.promptHistory !== undefined ? { history: uxOpts.promptHistory } : {}),
      ...(uxOpts?.multiline === true ? { multiline: true } : {}),
    })
    return raw.trim()
  } catch (e) {
    if (e instanceof AbortError) return null
    throw e
  }
}

/** Read one REPL line and classify it: `null` ⇒ loop exit, `undefined` ⇒
 *  caller should keep looping (blank line or in-REPL slash handled here),
 *  `string` ⇒ forward as the next user prompt. Extracted from the
 *  `PromptSource.next` closure to keep it under the biome complexity budget. */
export const classifyReplLine = async (
  signal: AbortSignal | undefined,
  slashCtx:
    | Partial<{ skills: () => Promise<SkillRow[]>; idle: IdleMonitor; imageQueue: ImageQueue }>
    | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): Promise<string | null | undefined> => {
  const input = await readReplLine(signal, uxOpts)
  if (input === null) return null
  if (input === "/exit" || input === "/quit") return null
  const handled = input === "" || (await tryRunReplSlash(input, slashCtx))
  if (handled) {
    process.stderr.write("\n")
    return undefined
  }
  return input
}

/** CLI `PromptSource` adapter for the Layer-2 `runInteractive` driver.
 *  Wraps the raw-mode line reader + resolves `/exit` + in-REPL slash dispatch
 *  + blank-line behavior inline — the driver only sees clean prompt strings
 *  (or `null` for loop exit). UI primitives (readline, status bar, Esc-Esc,
 *  shell-stream painter) stay in apps/cli per RFC 3.1 slice rules.
 *
 *  ADR-0083 multi-modal: when `slashCtx.imageQueue` is wired, `next()` drains
 *  the queue on every accepted prompt and returns the `{ text, images }`
 *  PromptPayload form so `runInteractive` attaches the images to THAT turn.
 *  Single-shot: the queue is emptied as a side-effect of `drain()` — the
 *  user re-queues with `/image add` for the following turn. Empty queue
 *  ⇒ returns the plain string form (backward-compat / byte-identical).
 *
 *  Extracted from `runRepl` so each closure stays under the biome cognitive-
 *  complexity budget. The trailing `\n` per branch matches the prior
 *  `runReplLoopRaw` post-line behavior byte-identically. */
export const buildCliPromptSource = (
  slashCtx:
    | Partial<{ skills: () => Promise<SkillRow[]>; idle: IdleMonitor; imageQueue: ImageQueue }>
    | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): PromptSource => ({
  next: async (signal) => {
    while (signal?.aborted !== true) {
      const next = await classifyReplLine(signal, slashCtx, uxOpts)
      if (next === undefined) continue
      if (next === null) return null
      // Drain the per-turn image queue if wired + non-empty. Single-shot:
      // `drain()` clears the queue as a side-effect so subsequent turns are
      // text-only unless the user re-queues with another `/image add`.
      const queued = slashCtx?.imageQueue?.drain() ?? []
      if (queued.length === 0) return next
      return { text: next, images: queued.map((e) => e.block) }
    }
    return null
  },
})
