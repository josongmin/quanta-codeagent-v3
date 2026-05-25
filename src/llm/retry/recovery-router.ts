/**
 * Concrete `RecoveryRouter` factory + default selection (ADR-0214).
 *
 * Today the only implementation is `CodexSpecRouter`. This file exists so a
 * future router (e.g. an env-gated experimental policy) can be wired here
 * without touching `src/llm/retry/index.ts` consumers. Keeping the factory
 * separate from the closed-port file (`port.ts`) preserves the hex-arch rule:
 * the port type lives with its consumers; implementations may be swapped.
 */

import { CodexSpecRouter } from "./codex-spec-router"
import type { RecoveryRouter } from "./port"

/**
 * Construct the default `RecoveryRouter` (Codex-spec mapping). No env knobs:
 * if a deployment needs a different policy, inject a custom `RecoveryRouter`
 * at the decorator boundary rather than mutating this default.
 */
export const createDefaultRecoveryRouter = (): RecoveryRouter => new CodexSpecRouter()
