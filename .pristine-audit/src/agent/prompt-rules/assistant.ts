/**
 * Assistant pack (interactive mode).
 *
 * This is the LEGACY default — calling `renderToolUseRules()` returns this
 * pack, byte-identical to the prior single-file `TOOL_USE_RULES`. The pack
 * is intentionally a verbatim re-export of {@link CORE_RULES} so the cached
 * system-prompt prefix for interactive sessions never shifts.
 *
 * Do NOT append mode-specific rules here. Interactive is the broadest surface
 * (humans steer mid-loop, can intervene on any wrong direction) — extra
 * narrowing rules belong in headless / batch / ci-bot packs where the loop
 * runs without a human in the seat.
 */

import { CORE_RULES, type PromptRule } from "./core"

/** Interactive-mode pack = core rules unchanged. Byte-stable on purpose. */
export const ASSISTANT_PACK: readonly PromptRule[] = CORE_RULES
