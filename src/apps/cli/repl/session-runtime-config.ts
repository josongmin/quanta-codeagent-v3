import type { PermissionMode } from "@/permission"
import {
  argvImages,
  argvPrompt,
  DEFAULT_MODEL,
  env,
  newSessionFlag,
  observeDir,
  type Provider,
  pickProvider,
  titleFlag,
} from "../internal"

export interface SessionRuntimeConfig {
  readonly env: NodeJS.ProcessEnv
  readonly stdinIsTTY: boolean | undefined
  readonly stdoutIsTTY: boolean | undefined
  readonly cwd: string
  readonly homeDir: string
  readonly provider: Provider
  readonly model: string
  readonly mode: PermissionMode
  readonly maxTurns: number
  readonly mcpConfigPath: string | undefined
  readonly spinnerIntervalMs: string
  readonly observeDir: string | undefined
  readonly argPrompt: string | undefined
  readonly pendingImagePaths: readonly string[]
  readonly newSession: boolean
  readonly title: string | undefined
  readonly idleSuppressOn: boolean
  readonly idleMs: number
  readonly snoozeDefaultMs: number
  readonly rejectLimit: number
}

/** Consolidate the session surface's process/env/argv reads into one typed
 *  config object so bootstrap and host wiring consume plain data. */
export const readSessionRuntimeConfig = (): SessionRuntimeConfig => {
  const provider = pickProvider()
  return {
    env: process.env,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    cwd: process.cwd(),
    homeDir: process.env.HOME ?? "",
    provider,
    model: env("QUANTA_MODEL", DEFAULT_MODEL[provider]),
    mode: env("QUANTA_PERMISSION", "default") as PermissionMode,
    maxTurns: Number(env("QUANTA_MAX_TURNS", "40")),
    mcpConfigPath: process.env.QUANTA_MCP_CONFIG,
    spinnerIntervalMs: env("QUANTA_SPINNER_INTERVAL_MS", "80"),
    observeDir: observeDir(),
    argPrompt: argvPrompt(),
    pendingImagePaths: argvImages(),
    newSession: newSessionFlag(),
    title: titleFlag(),
    idleSuppressOn: env("QUANTA_IDLE_SUPPRESS", "1") !== "0",
    idleMs: Number(env("QUANTA_IDLE_MS", "60000")),
    snoozeDefaultMs: Number(env("QUANTA_SNOOZE_DEFAULT_MS", "300000")),
    rejectLimit: Number(env("QUANTA_REJECT_LIMIT", "20")),
  }
}
