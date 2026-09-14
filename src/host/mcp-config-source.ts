/**
 * Which MCP config file a launch would open, and whether it is the operator's own or
 * arrives with the launch folder (ADR-0559).
 *
 * Only an ABSOLUTE path set in the real environment names the operator's file. Every
 * other source is judged by the trust of the folder it comes from, exactly like
 * `<project>/.mcp.json`:
 *  - a value a dotenv file supplied (`envFileSourceOf`). The CLI loads the launch folder's
 *    `.env.dev` / `.env.local` / `.env` before MCP loads, so a clone could name its own
 *    config and run its commands with the trust question answered no (round-11 audit,
 *    reproduced on the real CLI);
 *  - a RELATIVE value from any source. It resolves against the launch folder, so
 *    `QUANTA_MCP_CONFIG=.mcp.json` opened every folder's own file (found by the sep-14
 *    plan's DS1 lane).
 *
 * Residual, stated: Bun autoloads `.env` before quanta runs, and those values carry no
 * provenance, so an absolute value written there (`${PWD}/x.json`) still reads as the
 * operator's. Removing that autoload is the sep-14 plan's lane A (SEC-0).
 */
import { dirname, isAbsolute, join, resolve } from "node:path"
import { envFileSourceOf } from "@/shared/env-files"
import { PLUGIN_MCP_FILE } from "@/skill/plugin-manifest"

/** The env names that select an MCP config, in precedence order. */
export const MCP_CONFIG_ENV_KEYS = [
  "QUANTA_MCP_CONFIG",
  "QUANTA_BROWSER_MCP_CONFIG",
  "QUANTA_BROWSER_MCP_PLUGIN_DIR",
] as const
type McpConfigEnvKey = (typeof MCP_CONFIG_ENV_KEYS)[number]

export type McpConfigSource =
  /** An absolute path from the real environment: opened in any folder. */
  | { readonly kind: "operator"; readonly path: string }
  /** A file the launch folder chose: opened only when `folder` is trusted. */
  | {
      readonly kind: "folder"
      readonly path: string
      readonly folder: string
      /** How the path was chosen, for the notice; absent for the `.mcp.json` fallback. */
      readonly namedBy?: string
    }

const configFileOf = (key: McpConfigEnvKey, value: string): string =>
  key === "QUANTA_BROWSER_MCP_PLUGIN_DIR"
    ? `${value.replace(/\/+$/, "")}/${PLUGIN_MCP_FILE}`
    : value

const fromEnvKey = (
  key: McpConfigEnvKey,
  value: string,
  projectRoot: string | undefined,
): McpConfigSource => {
  const dotenv = envFileSourceOf(key)
  const file = configFileOf(key, value)
  if (dotenv === undefined && isAbsolute(value)) return { kind: "operator", path: file }
  const folder = dotenv !== undefined ? dirname(dotenv) : (projectRoot ?? process.cwd())
  return {
    kind: "folder",
    path: resolve(folder, file),
    folder,
    namedBy:
      dotenv !== undefined ? `${key} in ${dotenv}` : `${key}=${value}, relative to ${folder}`,
  }
}

/**
 * The config `readMcpConfig` opens: the first env name set, else `<projectRoot>/.mcp.json`
 * when a project root is supplied, else none.
 */
export const resolveMcpConfigSource = (
  envSource: NodeJS.ProcessEnv,
  projectRoot: string | undefined,
): McpConfigSource | undefined => {
  for (const key of MCP_CONFIG_ENV_KEYS) {
    const value = envSource[key]?.trim()
    if (value) return fromEnvKey(key, value, projectRoot)
  }
  if (projectRoot === undefined) return undefined
  return { kind: "folder", path: join(projectRoot, PLUGIN_MCP_FILE), folder: projectRoot }
}
