import type { ModeVariantKey, SystemPromptVariantRegistry } from "@/agent/system-prompt"
import type { ToolProfileName, ToolProfileResolver } from "@/agent/tool-profile"

export interface SystemSource {
  get(): string
  set(next: string): void
}

export interface ToolProfileSessionState {
  readonly resolver: ToolProfileResolver
  readonly defaultName?: ToolProfileName
  get(): ToolProfileName
  set(next: ToolProfileName): void
}

export interface IdentityModeSessionState {
  readonly registry: SystemPromptVariantRegistry
  readonly defaultMode?: ModeVariantKey
  readonly perTurnReminderEnabled?: boolean
  get(): ModeVariantKey
  set(next: ModeVariantKey): void
}

export const createSystemSource = (initial: string): SystemSource => {
  let current = initial
  return {
    get: (): string => current,
    set: (next: string): void => {
      if (next === current) return
      current = next
    },
  }
}

export const createToolProfileSessionState = (args: {
  readonly resolver: ToolProfileResolver
  readonly defaultName: ToolProfileName
}): ToolProfileSessionState => {
  let current = args.defaultName
  return {
    resolver: args.resolver,
    defaultName: args.defaultName,
    get: (): ToolProfileName => current,
    set: (next: ToolProfileName): void => {
      current = next
    },
  }
}

export const createIdentityModeSessionState = (args: {
  readonly registry: SystemPromptVariantRegistry
  readonly defaultMode: ModeVariantKey
  readonly perTurnReminderEnabled?: boolean
}): IdentityModeSessionState => {
  let current = args.defaultMode
  return {
    registry: args.registry,
    defaultMode: args.defaultMode,
    ...(args.perTurnReminderEnabled !== undefined
      ? { perTurnReminderEnabled: args.perTurnReminderEnabled }
      : {}),
    get: (): ModeVariantKey => current,
    set: (next: ModeVariantKey): void => {
      current = next
    },
  }
}
