import type { IdentityMode } from "@/agent/identity"
import type { ModeVariantKey, SystemPromptVariantRegistry } from "@/agent/system-prompt"
import type { ToolProfileName, ToolProfileResolver } from "@/agent/tool-profile"
import { errMessage } from "@/shared"

// RFC-05 E3 — the permission-mode STATE CELL is retired. Its `{ get, set }`
// contract moved to the E3 posture builder as the delegating-ADAPTER type (a
// live view over the durable posture authority, no mutable mode state). It is
// re-exported here so existing consumers (`@/runner/assemble/session-state`)
// keep their import path; construction goes through `createPermissionModeAdapter`
// in `./session-authorities/build-posture`, never a surface-local mode cell.
export type { PermissionModeSessionState } from "./session-authorities/build-posture"

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
