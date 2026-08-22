import type { IdentityMode } from "@/agent/identity"
import type { ModeVariantKey, SystemPromptVariantRegistry } from "@/agent/system-prompt"
import type { ToolProfileName, ToolProfileResolver } from "@/agent/tool-profile"
import type { PermissionMode } from "@/permission"
import { errMessage } from "@/shared"

export interface SystemSource {
  get(): string
  set(next: string): void
}

/** Pure rebuild port for a mutable session system prompt. The mode reader is
 * deliberately live: a slash surface updates the same session cell before the
 * next turn reads SystemSource.get(). */
export interface SystemPromptRebuilderPort {
  rebuild(): string
}

export interface CreateSystemPromptRebuilderArgs {
  readonly mode: () => IdentityMode | undefined
  readonly cwd: string
  readonly baseBuilder: (mode: IdentityMode | undefined, cwd: string) => string
}

export const SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX = "(prompt rebuild failed: "

const formatSystemPromptRebuildFallback = (reason: string): string =>
  `${SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX}${reason.replace(/[\r\n]+/g, " ")})`

/** The runner owns the mutable session state and this no-throw recompute
 * contract. Host composition supplies prompt policy through baseBuilder. */
export const createSystemPromptRebuilder = (
  args: CreateSystemPromptRebuilderArgs,
): SystemPromptRebuilderPort => ({
  rebuild: (): string => {
    try {
      return args.baseBuilder(args.mode(), args.cwd)
    } catch (error) {
      return formatSystemPromptRebuildFallback(errMessage(error))
    }
  },
})

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
  get(): IdentityMode
  /** Project the current identity posture onto the prompt-variant registry's
   *  closed key space. `onboarding` is identity-only, so it falls back to the
   *  session's default prompt mode instead of widening `identityModeVariant`. */
  getPromptMode(): ModeVariantKey
  set(next: IdentityMode): void
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
  readonly initialMode?: IdentityMode
  readonly perTurnReminderEnabled?: boolean
}): IdentityModeSessionState => {
  let current: IdentityMode = args.initialMode ?? args.defaultMode
  return {
    registry: args.registry,
    defaultMode: args.defaultMode,
    ...(args.perTurnReminderEnabled !== undefined
      ? { perTurnReminderEnabled: args.perTurnReminderEnabled }
      : {}),
    get: (): IdentityMode => current,
    getPromptMode: (): ModeVariantKey => (current === "onboarding" ? args.defaultMode : current),
    set: (next: IdentityMode): void => {
      current = next
    },
  }
}
