/**
 * CLI-local remote runner seams. Resolves Docker/Lima process wiring without
 * executing backend commands (G-F9.1). `Bun.which` is a PATH lookup, not a
 * docker/lima invocation.
 */

import { parseRemoteRunnerEnv, type RemoteRunnerSeams } from "@/remote"
import { createArgvCliProcess } from "./argv-process"

export type CliRemoteSeamReason = "disabled" | "unknown" | "missing-binary" | "ready"

export type CliRemoteSeamResolution = {
  readonly seams: RemoteRunnerSeams
  readonly reason: CliRemoteSeamReason
  readonly requested: string | undefined
}

export const buildCliRemoteSeams = (
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly which?: (binary: string) => string | null } = {},
): CliRemoteSeamResolution => {
  const which = opts.which ?? ((binary: string) => Bun.which(binary))
  const raw = env.QUANTA_REMOTE_RUNNER
  const name = parseRemoteRunnerEnv(raw)
  if (name === null) {
    const reason: CliRemoteSeamReason =
      raw === undefined || raw === "" || raw.toLowerCase() === "none" ? "disabled" : "unknown"
    return { seams: {}, reason, requested: raw }
  }
  if (name === "headless") {
    return { seams: { headlessOpts: {} }, reason: "ready", requested: raw }
  }
  if (name === "apple-vz") {
    return { seams: {}, reason: "ready", requested: raw }
  }
  if (name === "docker") {
    if (which("docker") === null) {
      return { seams: {}, reason: "missing-binary", requested: raw }
    }
    return { seams: { dockerProcess: createArgvCliProcess() }, reason: "ready", requested: raw }
  }
  if (which("limactl") === null) {
    return { seams: {}, reason: "missing-binary", requested: raw }
  }
  return {
    seams: {
      limaProcess: createArgvCliProcess(),
      limaVm: env.QUANTA_REMOTE_LIMA_VM ?? "default",
    },
    reason: "ready",
    requested: raw,
  }
}
