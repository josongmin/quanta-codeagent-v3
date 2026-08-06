/**
 * RFC-12 (deferred) — LAZY KaTeX display-math renderer.
 *
 * This module is the ONLY importer of `katex` (a math typesetting library +
 * font CSS). `MarkdownMessage` pulls it in via
 * `lazy(() => import("./KatexDisplay"))`, so katex stays BEHIND the async
 * boundary and is fetched only when a `$$…$$` display-math segment actually
 * renders — never on first paint. (Same regression-guarded lazy pattern the app
 * uses for `MermaidDiagram` / `PdfPreview` / `MarkdownMessage`.)
 *
 * The math body arrives IN-MEMORY as the `body` of a `rich-markers` `katex`
 * segment (the `$$` delimiters already stripped). Typesetting happens in a
 * `useEffect` (needs the DOM `katex.render` writes into). Any parse / render
 * failure — or katex not being present at all — DEGRADES to the raw `$$…$$`
 * source in a `<code>` block: never a crash, never nothing, and — critically —
 * byte-equivalent to the plain-text fallback the gate-OFF path already renders.
 *
 * The host element carries the verbatim `$$source$$` as its initial child +
 * `data-katex-source`, so a non-DOM render (SSR / node-env test) still exposes
 * the exact source; `katex.render` swaps `innerHTML` on the client only.
 */

import { memo, useEffect, useRef, useState } from "react"

export interface KatexDisplayProps {
  /** The math body (the `$$` delimiters stripped) — from a `rich-markers`
   *  `katex` segment's `body`. */
  readonly body: string
  /** The verbatim source substring (`$$…$$`) — rendered as the degraded
   *  fallback so a failure / no-DOM path shows exactly the pre-gate text. */
  readonly source: string
}

const KatexDisplayInner = ({ body, source }: KatexDisplayProps): JSX.Element => {
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const host = hostRef.current
    if (host === null) return
    void (async () => {
      try {
        // dynamic-import katex lazily so it (and its CSS) is not even parsed
        // until this component mounts.
        const { default: katex } = await import("katex")
        katex.render(body, host, { displayMode: true, throwOnError: false })
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [body])

  if (failed) {
    // Degrade to the exact pre-gate plain-text source.
    return (
      <code className="whitespace-pre-wrap break-words font-mono text-[0.9em] text-ink">
        {source}
      </code>
    )
  }
  return (
    <span
      ref={hostRef}
      data-testid="katex-display"
      // Carry the verbatim source so a non-DOM render (SSR / node-env test)
      // exposes the exact `$$…$$` text; katex.render swaps this child on mount.
      data-katex-source={source}
      className="katex-display-host [&_.katex]:text-ink"
    >
      {source}
    </span>
  )
}

export const KatexDisplay = memo(KatexDisplayInner)
export default KatexDisplay
