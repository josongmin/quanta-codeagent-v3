/**
 * ADR-0289 — macOS Apple Virtualization framework adapter.
 *
 * Re-uses the Skybridge microVM substrate from ADR-0155 (see
 * `src/mcp/skybridge`) — this slice owns ONLY the type-shim that maps
 * Skybridge handles onto the `RemoteRunner` port. The real wire-up is a
 * follow-up ADR (`skybridge-job-host`) — for now this adapter is feature-
 * complete vs the port surface but only emits `daemon-unavailable` until a
 * concrete `AppleVZHost` is injected.
 *
 * No `src/mcp/skybridge` runtime import here — only a structural shim:
 *
 *   `AppleVZHost` is the EXACT minimum surface from Skybridge that maps to
 *   our port. The composition root supplies a concrete implementation; this
 *   slice never reaches into `src/mcp/skybridge/*` to keep the slice
 *   isolation invariant (RFC §3.1) — adapter wiring is a composition root
 *   responsibility, NOT a leaf slice import.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { RemoteRunner } from "./port"
import {
  RemoteError,
  type RemoteHandle,
  type RemoteLogsOpts,
  type RemoteSpec,
  type RemoteStatus,
} from "./types"
import { validateSpec } from "./validate"

/** Minimal Apple-VZ host surface — supplied by the composition root.
 *  Mirrors a tiny subset of the Skybridge microVM lifecycle. */
export interface AppleVZHost {
  start(image: string, cmd: readonly string[]): Promise<{ readonly vmId: string }>
  observe(vmId: string): Promise<{
    readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled"
    readonly exitCode?: number | undefined
  }>
  terminate(vmId: string): Promise<void>
  follow(vmId: string, signal?: AbortSignal | undefined): AsyncIterable<string>
}

export interface AppleVZAdapterOpts {
  /** When undefined the adapter ALWAYS returns `daemon-unavailable` —
   *  matches macOS-only constraint without crashing on Linux/Win. */
  readonly host?: AppleVZHost | undefined
  readonly namePrefix?: string
  readonly uuid?: () => string
  readonly nowMs?: () => number
}

const UNAVAILABLE = (msg: string): RemoteError =>
  new RemoteError("daemon-unavailable", msg, "apple-vz")

export const createAppleVZAdapter = (opts: AppleVZAdapterOpts = {}): RemoteRunner => {
  const prefix = opts.namePrefix ?? "quanta-remote"
  const uuid = opts.uuid ?? (() => crypto.randomUUID())
  const nowMs = opts.nowMs ?? (() => Date.now())
  const host = opts.host
  const handleToVm = new Map<string, string>()

  return {
    async spawn(spec: RemoteSpec): Promise<Result<RemoteHandle, RemoteError>> {
      const validation = validateSpec(spec)
      if (!validation.ok) return err(validation.error)
      if (host === undefined) {
        return err(UNAVAILABLE("Apple Virtualization host not wired (macOS-only)"))
      }
      if (spec.signal?.aborted === true) {
        return err(new RemoteError("cancelled", "aborted pre-spawn", "apple-vz"))
      }
      try {
        const vm = await host.start(spec.image, spec.cmd)
        const id = `${prefix}-${uuid()}`
        handleToVm.set(id, vm.vmId)
        return ok({ id, backend: "apple-vz" })
      } catch (e) {
        return err(new RemoteError("transport", errMessage(e), "apple-vz"))
      }
    },

    async status(handle: RemoteHandle): Promise<Result<RemoteStatus, RemoteError>> {
      const vmId = handleToVm.get(handle.id)
      if (vmId === undefined) {
        return err(new RemoteError("unknown-handle", handle.id, "apple-vz"))
      }
      if (host === undefined) return err(UNAVAILABLE("host detached"))
      try {
        const snap = await host.observe(vmId)
        return ok({
          kind: snap.status,
          exitCode: snap.exitCode,
          reason: undefined,
          observedAtMs: nowMs(),
        })
      } catch (e) {
        return err(new RemoteError("transport", errMessage(e), "apple-vz"))
      }
    },

    async cancel(handle: RemoteHandle): Promise<Result<void, RemoteError>> {
      const vmId = handleToVm.get(handle.id)
      if (vmId === undefined) {
        return err(new RemoteError("unknown-handle", handle.id, "apple-vz"))
      }
      if (host === undefined) return err(UNAVAILABLE("host detached"))
      try {
        await host.terminate(vmId)
        return ok(undefined)
      } catch (e) {
        return err(new RemoteError("transport", errMessage(e), "apple-vz"))
      }
    },

    async *logs(handle: RemoteHandle, logOpts: RemoteLogsOpts = {}): AsyncIterable<string> {
      const vmId = handleToVm.get(handle.id)
      if (vmId === undefined) return
      if (host === undefined) return
      const stream = host.follow(vmId, logOpts.signal)
      for await (const line of stream) {
        if (logOpts.signal?.aborted === true) return
        yield line
      }
    },
  }
}
