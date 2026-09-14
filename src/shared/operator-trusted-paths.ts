/**
 * `QUANTA_TRUSTED_PATHS` as the OPERATOR set it.
 *
 * The variable grants folder trust (ADR-0559 workspace trust, ADR-0498 central-config
 * trust). The CLI loads `.env.dev` / `.env.local` / `.env` from the launch folder before
 * anything reads it, so a cloned repository could list ITSELF there and trust its own
 * language servers, `.mcp.json` commands, plugins and hooks (the forge arm of the sep-14
 * plan's R-1). A value a dotenv file supplied (`envFileSourceOf`) is therefore not consent
 * and reads as unset — the same provenance rule SEC-1 and SEC-2 apply to their opt-ins.
 *
 * Residual, stated: Bun itself autoloads `.env` from the launch folder before quanta runs,
 * and those values carry no provenance here. Removing that autoload is the sep-14 plan's
 * lane A (SEC-0).
 */
import { envFileSourceOf } from "./env-files"
import { logger } from "./logger"
import { runtimeConfig } from "./runtime-config"

let reportedSource: string | undefined

export const operatorTrustedPaths = (): string | undefined => {
  const source = envFileSourceOf("QUANTA_TRUSTED_PATHS")
  if (source === undefined) return runtimeConfig().trustedPaths
  if (reportedSource !== source) {
    reportedSource = source
    logger.warn(
      `[quanta] QUANTA_TRUSTED_PATHS from ${source} ignored: a folder's dotenv file cannot trust folders. Set it in the real environment.`,
    )
  }
  return undefined
}
