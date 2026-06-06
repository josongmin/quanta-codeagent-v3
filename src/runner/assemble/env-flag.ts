/**
 * Re-export of the canonical `parseEnvFlag` (now in `@/shared`).
 *
 * The truth table was hoisted to `@/shared/env-flag` so that lower layers
 * (library slice `@/memory`, Layer-1 `@/agent`) can consume it without an
 * upward import into this Layer-2 `@/runner` composition slice. This barrel
 * stays so existing `@/runner` / `@/host` / `apps/*` import sites keep working
 * unchanged.
 */
export { parseEnvFlag } from "@/shared"
