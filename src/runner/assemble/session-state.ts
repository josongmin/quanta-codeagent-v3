import type { ModeVariantKey, SystemPromptVariantRegistry } from "@/agent/system-prompt"
import type { ToolProfileName, ToolProfileResolver } from "@/agent/tool-profile"
import type { PermissionMode } from "@/permission"

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

/**
 * ADR-0303 — engine-owned permission posture, mirroring
 * {@link ToolProfileSessionState} / {@link IdentityModeSessionState}. Before
 * this, the CLI `shift+tab` mode-cycle held the next permission posture in a
 * slash-LOCAL store (`apps/cli/mode-cycle.ts`) that the runtime read ONLY at
 * `createSession` time — so a mid-session cycle applied to the NEXT session,
 * not the next turn (a §3.1 "slash-only mirror is not authority" violation).
 * Threading this mutable state through `boot → snapshot → per-turn base`
 * makes the engine the authority: `set()` is read by the very next turn.
 */
export interface PermissionModeSessionState {
  readonly defaultMode?: PermissionMode
  get(): PermissionMode
  set(next: PermissionMode): void
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

export const createPermissionModeSessionState = (args: {
  readonly defaultMode: PermissionMode
}): PermissionModeSessionState => {
  let current = args.defaultMode
  return {
    defaultMode: args.defaultMode,
    get: (): PermissionMode => current,
    set: (next: PermissionMode): void => {
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
