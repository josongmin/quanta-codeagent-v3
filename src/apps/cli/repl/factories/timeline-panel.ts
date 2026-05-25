import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { createTimelinePanel, type TimelinePanel } from "../../timeline-panel"
import type { CliFeatureConfig } from "../cli-feature-config"

/** Track T — build the timeline ring-buffer panel + tee-wrap the stream.
 *  Default-OFF byte-identical: when `QUANTA_TIMELINE` is unset / 0 /
 *  non-finite OR stderr is not a TTY, returns the literal `stream` reference
 *  + `panel: undefined` ⇒ no tee allocated, no extra consumer, no DECSTBM
 *  write, no ring buffer.
 *
 *  When the boot gate passes, allocates ONE timeline panel + a proxy port
 *  that tees every `AgentEvent` into the panel's `emit`. Emit errors are
 *  swallowed in place (same posture as `buildIndicatorPort` /
 *  `buildDebugTracerAndStream`) so a faulty render can never poison the
 *  recorder tee. The host calls `panel.teardown()` in `runRepl`'s `finally`
 *  block so a follow-on shell prompt lands on a clean screen. */
export const buildTimelinePanelAndStream = (
  featureCfg: CliFeatureConfig,
  stream: StreamPort,
): { stream: StreamPort; panel: TimelinePanel | undefined } => {
  if (!featureCfg.timelinePanel.enabled) return { stream, panel: undefined }
  const panel = createTimelinePanel({ height: featureCfg.timelinePanel.height })
  const proxy: StreamPort = {
    emit: (event): void => {
      try {
        panel.emit(event)
      } catch {
        // Same posture as buildIndicatorPort / buildDebugTracerAndStream:
        // never poison the tee from a UX-only consumer.
      }
    },
  }
  return { stream: new TeeStream([stream, proxy]), panel }
}
