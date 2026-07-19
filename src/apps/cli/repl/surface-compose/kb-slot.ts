import { parseEnvFlag } from "@/runner/assemble"
import type { SessionSetupResult } from "../session-setup"

/** Shared default-off vocabulary for REPL composition knobs. */
export const isEnvTruthy = (raw: string | undefined): boolean => parseEnvFlag(raw, false)

/** Build the read-only `/kb` surface over the host-owned projects store. */
export const buildKbSlashSlot = (
  store: SessionSetupResult["projectsKbStore"],
): import("../../slash/kb-cmd").KbSlashState | undefined =>
  store !== undefined
    ? { docCount: () => store.size(), knowledge: () => store.knowledge(false) }
    : undefined
