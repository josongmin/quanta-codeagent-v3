/**
 * ADR-0289 — Env-driven runner registry.
 *
 * Resolves `QUANTA_REMOTE_RUNNER` ∈ `{ "docker", "lima", "apple-vz",
 * "headless", "none" }` → a `RemoteRunner` factory.
 *
 * Default-OFF (HELL-RR-08, HELL-CR-08): when the env var is unset / `"none"`
 * / unknown, `selectRemoteRunner(env)` returns `null`. The composition
 * root MUST treat `null` as "remote plane absent" — no implicit fallback,
 * no silent default. The CLI surfaces this as
 * `quanta remote run … → exit-code remote-not-configured`.
 *
 * Concrete adapters (docker / lima / apple-vz) require external seams
 * (process, vm, host). The registry returns FACTORIES that the host
 * supplies wiring for; this keeps the registry itself pure + import-safe.
 */

import { type AppleVZHost, createAppleVZAdapter } from "./apple-vz-adapter"
import { createDockerAdapter, type DockerProcess } from "./docker-adapter"
import { createHeadlessRunner, type HeadlessRunnerOpts } from "./headless-stub"
import { createLimaAdapter, type LimaProcess } from "./lima-adapter"
import type { RemoteRunner } from "./port"

export type RemoteRunnerName = "docker" | "lima" | "apple-vz" | "headless"

const KNOWN_RUNNERS: ReadonlyArray<RemoteRunnerName> = ["docker", "lima", "apple-vz", "headless"]

/** Parse the env knob (case-insensitive). Returns null for unset / unknown / "none". */
export const parseRemoteRunnerEnv = (raw: string | undefined): RemoteRunnerName | null => {
  if (raw === undefined || raw === "") return null
  const norm = raw.toLowerCase().trim()
  if (norm === "none") return null
  for (const k of KNOWN_RUNNERS) {
    if (k === norm) return k
  }
  return null
}

/**
 * Adapters the registry can wire when `QUANTA_REMOTE_RUNNER === <name>`.
 *
 * Each factory is OPTIONAL — when the env requests an adapter whose
 * factory is missing, the registry returns `null` (degraded → off). The
 * CLI's exit-code mirrors `remote-not-configured` in that case so the
 * user sees "missing seam" rather than a silent fallback.
 */
export interface RemoteRunnerSeams {
  readonly dockerProcess?: DockerProcess | undefined
  readonly limaProcess?: LimaProcess | undefined
  readonly limaVm?: string | undefined
  readonly appleVZHost?: AppleVZHost | undefined
  readonly headlessOpts?: HeadlessRunnerOpts | undefined
}

/**
 * Resolve a runner from env + supplied seams. Returns `null` when
 *   - env is unset / unknown / `"none"`, OR
 *   - env asks for an adapter whose seam is missing.
 *
 * NEVER throws — the registry is import-safe.
 */
export const selectRemoteRunner = (
  env: Readonly<Record<string, string | undefined>>,
  seams: RemoteRunnerSeams = {},
): RemoteRunner | null => {
  const name = parseRemoteRunnerEnv(env["QUANTA_REMOTE_RUNNER"])
  if (name === null) return null
  switch (name) {
    case "headless":
      return createHeadlessRunner(seams.headlessOpts ?? {})
    case "docker":
      if (seams.dockerProcess === undefined) return null
      return createDockerAdapter({ process: seams.dockerProcess })
    case "lima":
      if (seams.limaProcess === undefined || seams.limaVm === undefined) return null
      return createLimaAdapter({ process: seams.limaProcess, vm: seams.limaVm })
    case "apple-vz":
      return createAppleVZAdapter({ host: seams.appleVZHost })
    default: {
      const _exhaustive: never = name
      void _exhaustive
      return null
    }
  }
}
