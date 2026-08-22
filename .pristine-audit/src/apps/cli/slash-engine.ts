import type { SlashCommand, SlashContext } from "./slash-contract"

export interface CreateSlashRuntimeOpts {
  readonly virtualCommands?: readonly string[]
}

export interface SlashRuntime {
  readonly describe: (name: string) => string | undefined
  readonly complete: (line: string) => [string[], string]
  readonly run: (line: string, ctx: SlashContext) => Promise<number>
}

const tokenizeSlashCommand = (line: string): readonly string[] =>
  line
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)

/** Recognize a CLI argv token as a slash invocation. `/foo` matches;
 *  `/path/to/file` does not, so path-mode resume arguments still fall through
 *  to the non-slash path. */
export const isSlashCommand = (input: string): boolean => {
  if (input.length < 2 || input[0] !== "/") return false
  const second = input[1]
  if (second === undefined) return false
  if (!/[a-z]/i.test(second)) return false
  return !input.slice(1).includes("/")
}

/** Pure dispatch/completion runtime for a concrete slash registry. Registry
 *  assembly stays with the surface owner; this module owns the mechanics. */
export const createSlashRuntime = (
  commands: readonly SlashCommand[],
  opts: CreateSlashRuntimeOpts = {},
): SlashRuntime => {
  const byName: ReadonlyMap<string, SlashCommand> = new Map(
    commands.map((command) => [command.name, command]),
  )
  const vocabulary = [...commands.map((command) => command.name), ...(opts.virtualCommands ?? [])]
  return {
    describe: (name: string): string | undefined => byName.get(name)?.describe,
    complete: (line: string): [string[], string] => {
      if (line === "" || line[0] !== "/") return [[], line]
      const matches = vocabulary.filter((name) => name.startsWith(line)).sort()
      return [matches, line]
    },
    run: async (line: string, ctx: SlashContext): Promise<number> => {
      const tokens = tokenizeSlashCommand(line)
      const name = tokens[0]
      if (name === undefined) {
        ctx.err("slash: empty command\n")
        return 1
      }
      const command = byName.get(name)
      if (command === undefined) {
        ctx.err(`slash: unknown command: ${name}\n`)
        ctx.out("Available:\n")
        for (const candidate of commands) {
          ctx.out(`  ${candidate.name.padEnd(12)} ${candidate.describe}\n`)
        }
        return 1
      }
      return command.run(tokens.slice(1), ctx)
    },
  }
}
