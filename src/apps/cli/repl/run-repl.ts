import { assembleReplContext } from "./assemble-context"
import { runInteractiveRepl } from "./interactive-driver"
import { runOneShotTurn } from "./oneshot-driver"

/**
 * Main REPL/one-shot entry: assembles the agent stack, resolves the resume
 * state machine, and dispatches to either `runInteractive` (interactive REPL)
 * or a single `runOneShotTurn` call (one-shot when argv carries a positional
 * prompt).
 *
 * Verbatim relocation of the post-routing body of `main()` from the prior
 * `repl.ts` monolith — every observable line, branch, and log statement is
 * preserved. The caller (`apps/cli/index.ts::main`) is responsible for the
 * argv-routing short-circuits (`session` subcommand / `/<slash>` / `--help`)
 * BEFORE delegating here.
 */
export const runRepl = async (): Promise<void> => {
  const ctx = await assembleReplContext()
  try {
    if (ctx.argPrompt) {
      await runOneShotTurn(ctx, ctx.argPrompt)
    } else {
      await runInteractiveRepl(ctx)
    }
  } finally {
    ctx.lifecyclePills.dispose()
    await ctx.shutdownMcp()
  }
}
