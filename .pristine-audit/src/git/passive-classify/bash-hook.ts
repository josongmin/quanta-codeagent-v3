/**
 * H6 (jun-3-misc §3) — bash post-exec hook helper.
 *
 * The single entry point the `bash` tool calls AFTER a command completes. It is
 * the knob+sink boundary so the bash slice stays a 1-line additive call:
 *
 *   maybeEmitPassiveVcs(input.command, body, exitCode, ctx)
 *
 * Default-OFF / byte-identical contract:
 *   - `QUANTA_PASSIVE_VCS` runtime knob OFF  ⇒ returns IMMEDIATELY (no
 *     classification, no sink touch, no allocation).
 *   - no sink wired on `ctx`                 ⇒ resolves `noopVcsEventSink` and
 *     classification is skipped (the knob can be on but a non-wiring host stays
 *     byte-identical).
 *   - classifier returns `null`              ⇒ nothing emitted.
 *
 * Slice isolation: this helper lives in `src/git/passive-classify/` and reads
 * the sink off the `ToolContext` via a DUCK-TYPED structural shape
 * ({@link PassiveVcsHookCtx}) — it does NOT import `@/tool` types (avoids a
 * `@/git → @/tool` back-edge). The bash tool passes its own `ctx` (which
 * structurally satisfies the duck-typed shape) at the call site.
 */

import { runtimeConfig } from "@/shared"
import { classifyPassiveVcs } from "./classifier"
import { noopVcsEventSink, type PassiveVcsEventSink } from "./sink"

/** Duck-typed view of just the `ToolContext` fields this hook reads. Keeps the
 *  `@/git` slice from importing `@/tool`. The optional `vcsEventSink` field is
 *  the seam a host wires (deferred dispatch wiring); absent ⇒ noop. */
export interface PassiveVcsHookCtx {
  readonly vcsEventSink?: PassiveVcsEventSink
}

/**
 * Classify a completed git/gh command and emit the structured VCS event to the
 * wired sink. Returns the emitted event (test observability) or `null` when
 * nothing was emitted (knob off / no sink / no match / failed command).
 *
 * NO-THROW: a misbehaving sink is guarded so it can never break a bash turn.
 */
export const maybeEmitPassiveVcs = (
  command: string,
  stdout: string,
  exitCode: number,
  ctx: PassiveVcsHookCtx,
): ReturnType<typeof classifyPassiveVcs> => {
  // Knob gate FIRST — OFF ⇒ byte-identical (no classify, no sink resolve).
  if (!runtimeConfig().passiveVcs) return null

  // Resolve the sink. A host that did not wire one stays byte-identical even
  // with the knob on (we skip classification entirely — no wasted regex work).
  const sink: PassiveVcsEventSink | undefined = ctx.vcsEventSink
  if (sink === undefined || sink === noopVcsEventSink) return null

  const event = classifyPassiveVcs({ command, stdout, exitCode })
  if (event === null) return null

  try {
    sink.emit(event)
  } catch {
    // Sinks are NO-THROW by contract; a custom port that breaks it must never
    // poison a bash turn. Swallow — the event is best-effort observability.
  }
  return event
}
