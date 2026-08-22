/**
 * payload-preview — bounded, single-line previews of tool/LLM payloads for the
 * live trace UI (jun-27, `src/apps/bench/trace-viewer.html`).
 *
 * Clicking a `handle_tool_call` / `run_sampling_request` span should reveal WHAT
 * was actually sent — the bash command, the edited patch, the prompt text. The
 * raw payloads can be large (a full apply_patch) or structured (tool-call args),
 * so we attach a TRUNCATED, whitespace-collapsed string as a span attribute
 * rather than the whole thing.
 *
 * Discipline: callers build a preview ONLY when a span sink is active
 * (`getSpanSink() !== null`), so the default-OFF agent loop pays nothing —
 * neither the stringify nor the allocation. The truncation is defensive
 * regardless: a span attribute is metadata, not a data channel.
 */

/** Default cap — a few hundred chars is enough to identify a payload in the UI
 *  without bloating the OTLP envelope. */
export const PREVIEW_MAX = 600

/** Render any value as a bounded single-line preview string. Strings pass
 *  through; objects are JSON-serialized (best-effort — a cyclic / unserializable
 *  value falls back to `String(v)`). Whitespace is collapsed so the UI shows one
 *  tidy line. When truncated, a `… (+N)` suffix records how many chars were
 *  dropped so the operator knows it is clipped. NEVER throws. */
export const previewPayload = (value: unknown, max: number = PREVIEW_MAX): string => {
  let s: string
  if (typeof value === "string") {
    s = value
  } else if (value === undefined || value === null) {
    s = ""
  } else {
    try {
      s = JSON.stringify(value) ?? String(value)
    } catch {
      s = String(value)
    }
  }
  s = s.replace(/\s+/g, " ").trim()
  if (s.length <= max) return s
  return `${s.slice(0, max)}… (+${s.length - max})`
}
