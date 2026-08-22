/**
 * CLI path-mode resume heuristic — mirrored from `src/apps/cli/internal.ts::isPathLikeToken`.
 *
 * The CLI internal module is biome-fenced from cross-slice test imports (ADR-0024).
 * Keep this copy byte-aligned with production; resume e2e pins routing behaviour.
 */
export const isPathLikeToken = (token: string): boolean =>
  token.includes("/") || token.includes("\\") || token.endsWith(".json")
