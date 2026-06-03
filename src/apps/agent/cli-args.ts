/**
 * `apps/agent/cli-args.ts` — thin re-export shim (ADR-0303 thin-surface relocation).
 *
 * The argv parser moved DOWN into `@/host/runtime/agent-args` so the CLI surface
 * (`apps/cli`'s `batch` subcommand) can reach it without a sideways
 * `cli → apps/agent` cross-surface import. This shim re-exports every symbol the
 * original module published so existing importers (`./index.ts`, the mode-presets,
 * and the unit/hellgate tests) are unchanged.
 */

export {
  type AgentArgs,
  AgentArgsError,
  formatHelp,
  type IdentityModeToken,
  type PermissionProfileToken,
  type ProviderToken,
  parseAgentArgs,
  type ToolProfileToken,
} from "@/host/runtime/agent-args"
