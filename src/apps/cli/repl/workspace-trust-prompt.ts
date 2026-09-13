/**
 * The interactive CLI's one question about the launch folder, asked before the session
 * starts anything the folder controls (see `@/agent/workspace-trust`).
 *
 * Asked only on a terminal, only when the folder is not already trusted, and answered
 * "no" by default. A yes is recorded in `~/.quanta/trust.json`, so it is asked once per
 * folder; a no is not recorded, so the next launch asks again (Claude Code's behaviour).
 * Piped and one-shot runs are never asked: they stay untrusted unless the folder was
 * granted before or is listed in `QUANTA_TRUSTED_PATHS`.
 */

import * as readline from "node:readline/promises"
import { isWorkspaceTrusted } from "@/agent/workspace-trust"
import { installResolvedWorkspaceTrust } from "@/host/workspace-trust"
import { runtimeConfig } from "@/shared"

export const renderWorkspaceTrustQuestion = (folder: string): string =>
  [
    "",
    `\x1b[1mDo you trust the files in this folder?\x1b[0m`,
    `  ${folder}`,
    "",
    "Quanta starts programs this folder's files choose: language servers run its code",
    "(a .venv python, its own tsserver, build.rs), and .mcp.json and .quanta/plugins name",
    "commands to launch. Until you trust it, none of them start.",
    "",
    "Trust this folder? [y/N] ",
  ].join("\n")

export const isTrustAnswer = (answer: string): boolean => /^y(es)?$/i.test(answer.trim())

const askOnTerminal = async (folder: string): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return isTrustAnswer(await rl.question(renderWorkspaceTrustQuestion(folder)))
  } finally {
    rl.close()
  }
}

export const maybeConfirmWorkspaceTrust = async (): Promise<void> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return
  const cwd = process.cwd()
  if (isWorkspaceTrusted(cwd)) return
  await installResolvedWorkspaceTrust({
    cwd,
    trustedPaths: runtimeConfig().trustedPaths,
    confirm: askOnTerminal,
    warn: (message) => process.stderr.write(`${message}\n`),
  })
}
