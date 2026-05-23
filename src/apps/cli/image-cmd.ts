import { resolve as resolvePath } from "node:path"
import { loadImageBlock } from "./image-loader"
import type { ImageQueue } from "./image-queue"

/**
 * In-REPL `/image` subcommand handler (ADR-0083 multi-modal extension).
 *
 * The slash command is in-REPL only (not a {@link BUILTINS} entry in
 * `slash-commands.ts` — those are one-shot / shell-entry commands that
 * have NO session context). `/image add|list|clear` mutates the live
 * {@link ImageQueue} owned by the REPL surface; the next user turn drains
 * the queue and attaches the {@link ImageBlock}s to that turn's user
 * message via {@link PromptSource}'s `{ text, images }` payload form.
 *
 * Slice discipline:
 *   - Runs in `apps/cli` only.
 *   - Uses `image-loader.ts` for path validation + base64 encoding +
 *     mediaType inference (no duplicate validation).
 *   - `out`/`err` are injected ports so tests don't touch stdio.
 *
 * Subcommands:
 *   - `/image add <path> [<path>...]` — enqueue one or more paths. Multiple
 *     paths in a single invocation are processed in order; the first invalid
 *     path stops processing and exits 1 with a clear message. Already-queued
 *     paths are reported with the queued filename so the user sees what's in
 *     queue.
 *   - `/image list` — print every queued entry as `<n>. <basename> (<path>)`.
 *     Empty queue prints "(none queued)".
 *   - `/image clear` — drop every queued entry (idempotent — a fresh queue
 *     prints "(none queued)").
 *   - `/image` (no args) — same as `list` (low-friction default).
 *
 * Default-OFF:
 *   - `QUANTA_IMAGE_QUEUE=0` ⇒ caller suppresses the queue allocation
 *     entirely (the slash never reaches this module). When this module IS
 *     called, the queue is assumed wired.
 */

export interface ImageCmdCtx {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
  readonly cwd: string
  readonly queue: ImageQueue
}

const basenameOf = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return idx >= 0 ? p.slice(idx + 1) : p
}

/** `/image list`. */
const runList = (ctx: ImageCmdCtx): number => {
  const items = ctx.queue.list()
  if (items.length === 0) {
    ctx.out("/image: (none queued)\n")
    return 0
  }
  ctx.out(`/image: ${items.length} queued\n`)
  for (let i = 0; i < items.length; i++) {
    const e = items[i] as (typeof items)[number]
    ctx.out(`  ${i + 1}. ${basenameOf(e.path)} (${e.path})\n`)
  }
  return 0
}

/** `/image clear`. */
const runClear = (ctx: ImageCmdCtx): number => {
  const n = ctx.queue.size()
  ctx.queue.clear()
  ctx.out(`/image: cleared (${n} dropped)\n`)
  return 0
}

/** `/image add <path> [<path>...]`. Returns 0 on full success, 1 if any
 *  path fails (load error or queue-over-cap). Successful prefix is preserved
 *  in the queue (we DON'T roll back) so the user can see partial progress
 *  via `/image list`. */
const runAdd = (ctx: ImageCmdCtx, paths: readonly string[]): number => {
  if (paths.length === 0) {
    ctx.err("/image add: expected one or more paths\n")
    return 1
  }
  for (const raw of paths) {
    const abs = resolvePath(ctx.cwd, raw)
    let block: ReturnType<typeof loadImageBlock>
    try {
      block = loadImageBlock(abs)
    } catch (e) {
      ctx.err(`/image add: ${(e as Error).message}\n`)
      return 1
    }
    const res = ctx.queue.add({ path: abs, block })
    if (res.kind === "over_cap") {
      ctx.err(`/image add: queue is full (cap=${res.cap}); use \`/image clear\` to free slots\n`)
      return 1
    }
    ctx.out(`/image: queued ${basenameOf(abs)}\n`)
  }
  return 0
}

/**
 * Dispatch entry: `runImageCmd("/image add foo.png", ctx)`.
 * Returns the slash exit code (0 success, 1 invalid usage / load error).
 * Unknown subcommands print the usage banner and exit 1.
 */
export const runImageCmd = (line: string, ctx: ImageCmdCtx): number => {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  // Drop the leading "/image"; tokens[0] is the subcommand.
  const sub = tokens[1]
  const rest = tokens.slice(2)
  if (sub === undefined || sub === "list") return runList(ctx)
  if (sub === "clear") return runClear(ctx)
  if (sub === "add") return runAdd(ctx, rest)
  ctx.err(
    `/image: unknown subcommand "${sub}" (use: /image add <path> | /image list | /image clear)\n`,
  )
  return 1
}
