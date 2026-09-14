/**
 * `apps/cli/configured-endpoint-wire.ts` — RFC05 wireE CLI llm-build delegate.
 *
 * The CLI LLM-build composition root (`internal.ts#buildLLMWithByok`) delegates
 * configured-endpoint SELECTION here so the surface-parse concern (which named
 * `openaiEndpoints` profile to drive the LLM + which host secret feeds its
 * `authRef`) is one cohesive, testable seam rather than inlined into the already
 * god-sized `internal.ts`.
 *
 * SECRET DISCIPLINE: this is the ONLY place a `QUANTA_ENDPOINT_API_KEY`
 * credential enters the endpoint data-plane. The value rides only the outgoing
 * request (via the guarded fetch composed downstream) — never logged, never onto
 * a config record. It is a SECRET owned at the auth call site (same class as the
 * vendor `OPENAI_API_KEY` read), NOT a knob (the SELECTOR `QUANTA_LLM_ENDPOINT`
 * is the registered knob; the credential is a `src-no-sketchy` secret exception).
 *
 * ENV posture: `apps/cli/**` is the sanctioned surface-parse layer (this file is
 * covered by the `apps/cli/internal.ts`-class `process.env` allowlist entry —
 * injection-first is unnecessary here because the two reads are pure launch-time
 * SELECTOR + SECRET reads threaded downstream as resolved values, never module
 * state). LAZY: the disk config is read ONLY when a selector is set AND central
 * config is on, so the gate-OFF hot path pays nothing.
 */

import { readFile, realpath } from "node:fs/promises"
import { join as joinPath } from "node:path"
import {
  canonicalizeTrustedPaths,
  type EndpointSecretRef,
  mergeDiskLayers,
  osManagedSettingsPath,
  parseSettingSources,
  readDiskLayers,
  type TrustRecord,
  TrustStore,
} from "@/config"
import { type ResolvedEndpoint, resolveConfiguredEndpoint } from "@/runner/assemble"
import { errMessage, logger, quantaHomeDir, runtimeConfig } from "@/shared"
import { operatorTrustedPaths } from "@/shared/operator-trusted-paths"

/** The fixed allowlist of SYMBOLIC endpoint secret refs resolved to concrete
 *  host secret VALUES. A ref the profile references but that is absent here ⇒
 *  fail-closed (no endpoint) downstream. The value never leaves as a diagnostic. */
const resolveEndpointSecrets = (): Partial<Record<EndpointSecretRef, string>> => {
  const out: Partial<Record<EndpointSecretRef, string>> = {}
  const apiKey = process.env.QUANTA_ENDPOINT_API_KEY
  if (apiKey !== undefined && apiKey.length > 0) out.endpoint_api_key = apiKey
  return out
}

/** Resolve a SELECTED configured OpenAI endpoint for the CLI LLM build, or
 *  `undefined` for the byte-identical vendor path. LAZY + GATE-OFF:
 *
 *    - `QUANTA_LLM_ENDPOINT` unset/empty ⇒ NO disk-config read at all (the hot
 *      path pays nothing when no endpoint is selected).
 *    - `runtimeConfig().centralConfig` OFF ⇒ NO disk read (master default-OFF).
 *    - selector names no configured endpoint OR its declared secret can't be
 *      resolved ⇒ `undefined` (fail-closed to the vendor path).
 *
 *  When a selector IS set AND central config is ON, this resolves the same
 *  trust-gated central disk config `apps/agent#resolveCommandHookBindings` /
 *  `resolveMcpLaunchPolicy` use (`~/.quanta/trust.json` + `QUANTA_TRUSTED_PATHS`;
 *  NO trust prompt — an LLM build must never block boot on stdin), materializes
 *  the profile's symbolic secret refs from the host secrets, and returns the
 *  resolved endpoint. FAIL-SOFT: a corrupt settings file ⇒ `undefined` (the
 *  vendor path), never a boot crash. */
export const resolveConfiguredEndpointForCli = async (): Promise<ResolvedEndpoint | undefined> => {
  const name = process.env.QUANTA_LLM_ENDPOINT
  // GATE-OFF: no selector ⇒ NO disk read (lazy — the hot path is untouched).
  if (name === undefined || name === "") return undefined
  const rc = runtimeConfig()
  // Master central-config gate OFF ⇒ NO disk read (default-OFF byte-identity).
  if (!rc.centralConfig) return undefined
  try {
    let realCwd: string
    try {
      realCwd = await realpath(process.cwd())
    } catch (e) {
      logger.warn("endpoint trust cwd realpath failed; using unresolved cwd", {
        error: errMessage(e),
      })
      realCwd = process.cwd()
    }
    const userConfigDir = quantaHomeDir()
    // Read-only trust persistence: `save` is a no-op — the llm-build path NEVER
    // grants trust (no prompt); it only honors grants the hooks flow / user
    // persisted. Mirrors `resolveMcpLaunchPolicy`.
    const trustFile = joinPath(userConfigDir, "trust.json")
    const store = await TrustStore.load({
      load: async () => {
        try {
          const parsed = JSON.parse(await readFile(trustFile, "utf8")) as unknown
          return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, TrustRecord>)
            : undefined
        } catch (e) {
          logger.warn("endpoint trust store read failed; treating grants as absent", {
            error: errMessage(e),
            path: trustFile,
          })
          return undefined
        }
      },
      commit: async () => {},
    })
    const trustedFromEnv = canonicalizeTrustedPaths(
      (operatorTrustedPaths() ?? "").split(",").map((s) => s.trim()),
    )
    const trusted = store.isTrusted(realCwd) || trustedFromEnv.has(realCwd)
    const layers = await readDiskLayers({
      cwd: realCwd,
      userConfigDir,
      managedPath: osManagedSettingsPath(
        process.platform,
        rc.managedSettingsPath,
        process.env.PROGRAMDATA,
      ),
      trusted,
      sources: parseSettingSources(rc.centralConfigSources),
      read: async (p: string) => {
        try {
          return await readFile(p, "utf8")
        } catch (e) {
          // ENOENT/EACCES/… ⇒ layer absent (fail-soft, same posture as the hooks
          // / MCP-governance paths).
          logger.warn("endpoint settings layer read failed; treating layer as absent", {
            error: errMessage(e),
            path: p,
          })
          return undefined
        }
      },
      warn: (m: string) => logger.warn("endpoint.config.layer", { warn: m }),
    })
    const resolved = mergeDiskLayers(layers, trusted)
    // SELECT + materialize secret refs. Unknown name / unresolved secret ⇒
    // `undefined` (fail-closed to the vendor path); the resolved token / header
    // values live only on the in-memory endpoint, never a diagnostic.
    return resolveConfiguredEndpoint({
      name,
      endpoints: resolved.openaiEndpoints,
      secrets: resolveEndpointSecrets(),
    })
  } catch (e) {
    // FAIL-SOFT availability: a corrupt settings file must not kill LLM build.
    logger.warn("endpoint.config.resolve_failed", { error: errMessage(e) })
    return undefined
  }
}
