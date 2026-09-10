import * as readline from "node:readline/promises"
import { runSessionCommand } from "@/runner/session-ops"
import { createCliImportHandler } from "./session-import-handler"
import { resolveCliSessionListEnv } from "./session-list-env"

/**
 * Focused production entry for `quanta session ...`.
 *
 * Session administration does not need the REPL, agent, LLM, or observability
 * composition graphs. Keeping this route in a leaf avoids loading those graphs
 * in every short-lived session subprocess while preserving the same command
 * dispatcher and adapters used by the public CLI.
 */
export const runSessionMain = async (argv: string[] = process.argv.slice(3)): Promise<number> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  const listEnv = resolveCliSessionListEnv()
  const worktreeDeps =
    argv[0] === "worktree"
      ? await Promise.all([
          import("@/runner/assemble/session-authorities"),
          import("./cli-knobs-accessor"),
        ]).then(([{ buildSessionAuthorities }, { readCliKnob }]) => ({
          activityStore: buildSessionAuthorities({ env: process.env }).activity,
          worktreeProgress: readCliKnob("QUANTA_WORKTREE_PROGRESS", "bool") ?? false,
        }))
      : {}
  try {
    return await runSessionCommand(argv, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      confirm: async (prompt) => {
        const ans = await rl.question(prompt)
        return ans.trim().toLowerCase() === "y"
      },
      importHandler: createCliImportHandler(),
      cwd: process.cwd(),
      ...worktreeDeps,
      ...(listEnv !== undefined ? { listEnv } : {}),
    })
  } finally {
    rl.close()
  }
}
