import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import type { DebugCmdState } from "../../debug-cmd"
import { createDebugTracer } from "../../debug-tracer"
import type { CliFeatureConfig } from "../cli-feature-config"
import type { DebugTracerHandle } from "../session-setup"

/** Track D — build the debug-tracer + tee-wrap the stream + return the
 *  surface-mutable {@link DebugTracerHandle}. Default-OFF byte-identical:
 *  when `QUANTA_DEBUG` is unset (or parsed disabled) OR stderr is not a
 *  TTY, returns the literal `stream` reference + `debugHandle: undefined`
 *  ⇒ no tee allocated, no extra consumer, the `/debug` slash prints
 *  "not wired" + exits 0.
 *
 *  When the boot gate passes, allocates ONE mutable proxy port wrapping a
 *  live tracer ref. The `/debug` slash mutates `state` through
 *  `debugHandle.set(...)`; on every subsequent emit the proxy reads the
 *  CURRENT state and either invokes the tracer (when enabled) or no-ops
 *  (when disabled). Categories are honored by the tracer itself
 *  (Track C). The proxy is the ONLY thing teed in — re-allocating a
 *  tracer per state change keeps `startedAt` aligned with the LAST
 *  toggle so on-screen timestamps are intuitive ("ms since /debug on").
 *  A failure inside the tracer is swallowed in place (TeeStream would
 *  otherwise mark a degraded record). */
export const buildDebugTracerAndStream = (
  featureCfg: CliFeatureConfig,
  stream: StreamPort,
): {
  stream: StreamPort
  debugHandle: DebugTracerHandle | undefined
} => {
  // Non-TTY ⇒ forced disable (captured up-front in featureCfg.debugTracer.enabled
  // alongside the parsed QUANTA_DEBUG knob) to avoid polluting pipe/redirect output.
  if (!featureCfg.debugTracer.enabled) return { stream, debugHandle: undefined }
  // Live state ref + tracer ref. The tracer is rebuilt on each
  // `set(state)` so options (categories, startedAt) reflect the latest
  // toggle. Initial tracer is built once for the boot-enabled state.
  let state: DebugCmdState =
    featureCfg.debugTracer.categories !== undefined
      ? { enabled: true, categories: featureCfg.debugTracer.categories }
      : { enabled: true }
  const buildTracer = (s: DebugCmdState): ReturnType<typeof createDebugTracer> | null => {
    if (!s.enabled) return null
    return createDebugTracer({
      ...(s.categories !== undefined ? { categories: s.categories } : {}),
    })
  }
  let tracer = buildTracer(state)
  const proxy: StreamPort = {
    emit: (event): void => {
      if (tracer === null) return
      try {
        tracer(event)
      } catch {
        // Same posture as buildIndicatorPort: never poison the tee.
      }
    },
  }
  const debugHandle: DebugTracerHandle = {
    get: () => state,
    set: (next) => {
      state = next
      tracer = buildTracer(next)
    },
  }
  return { stream: new TeeStream([stream, proxy]), debugHandle }
}
