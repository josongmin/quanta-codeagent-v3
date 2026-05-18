import * as readline from "node:readline/promises"
import { type AgentConfig, type AgentOutcome, buildSystemPrompt, runAgent } from "@/agent"
import { AnthropicAdapter, type Message } from "@/llm"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { logger } from "@/shared"
import { StdoutStream } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const env = (k: string, fallback: string): string => process.env[k] ?? fallback

const main = async (): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY is not set")
    process.exit(1)
  }

  const model = env("QUANTA_MODEL", "claude-sonnet-4-6")
  const maxTurns = Number(env("QUANTA_MAX_TURNS", "40"))
  const mode = env("QUANTA_PERMISSION", "acceptEdits") as PermissionMode
  const cwd = process.cwd()

  const llm = new AnthropicAdapter({ apiKey, model })
  const registry = new ToolRegistry(defaultTools)
  const stream = new StdoutStream()
  const permission: PermissionContext = { mode }

  const abort = new AbortController()
  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    abort.abort()
  })

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const onConfirm = async (action: ToolAction): Promise<boolean> => {
    const ans = await rl.question(`Allow ${action.tool}? [y/N] `)
    return ans.trim().toLowerCase() === "y"
  }

  const session = (messages: Message[]): Promise<AgentOutcome> => {
    const config: AgentConfig = {
      llm,
      registry,
      stream,
      permission,
      messages,
      system: buildSystemPrompt(cwd),
      cwd,
      maxTurns,
      signal: abort.signal,
      onConfirm,
    }
    return runAgent(config)
  }

  const argPrompt = process.argv.slice(2).join(" ").trim()
  logger.info(`quanta ready (model=${model}, mode=${mode}, cwd=${cwd})`)

  let history: Message[] = []

  const turn = async (text: string): Promise<void> => {
    history.push({ role: "user", content: [{ type: "text", text }] })
    const outcome = await session(history)
    history = outcome.messages
  }

  if (argPrompt) {
    await turn(argPrompt)
    rl.close()
    return
  }

  // Interactive REPL: each line continues the same conversation.
  while (!abort.signal.aborted) {
    const input = (await rl.question("\nquanta› ")).trim()
    if (input === "") continue
    if (input === "/exit" || input === "/quit") break
    await turn(input)
  }
  rl.close()
}

main().catch((e) => {
  logger.error(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
