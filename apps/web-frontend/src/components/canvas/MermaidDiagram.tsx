/**
 * A2 (rich inline) — LAZY mermaid diagram renderer.
 *
 * This module is the ONLY importer of `mermaid` (a large graph/render library).
 * `ArtifactStrip` pulls it in via `lazy(() => import("./MermaidDiagram"))`, so
 * mermaid stays BEHIND the async boundary and is fetched only when a `mermaid`
 * artifact actually renders — never on first paint. (Same regression-guarded
 * pattern the app uses for `MarkdownMessage` / prism; see `vite.config.ts`.)
 *
 * The diagram bytes arrive as text via the injected `fetchText` port. Render
 * happens in a `useEffect` (needs the DOM `mermaid.render` provides). Any parse
 * / render failure degrades to the raw source in a `<pre>` — never a crash and
 * never nothing.
 *
 * RFC12-1 — an IN-MEMORY `source` may be passed instead of `{url, fetchText}`
 * (the PlanPanel projects the plan DAG to a mermaid string client-side; there is
 * no artifact URL to fetch). When `source` is present the fetch is skipped
 * entirely; the `{url, fetchText}` byte-fetch path is unchanged when it is not.
 */

import { memo, useEffect, useRef, useState } from "react"
import type { FetchText } from "./artifact-fetch"

export interface MermaidDiagramProps {
  /** Artifact-bytes URL to fetch the diagram source from. Omit when `source` is
   *  supplied directly (RFC12-1 in-memory render). */
  readonly url?: string
  /** Injected bytes port; required with `url`. */
  readonly fetchText?: FetchText
  /** RFC12-1 — an in-memory mermaid source string. When present, `url`/`fetchText`
   *  are ignored and this is rendered directly (no fetch). */
  readonly source?: string
}

let seq = 0

const MermaidDiagramInner = ({
  url,
  fetchText,
  source: sourceProp,
}: MermaidDiagramProps): JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [fetched, setFetched] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // In-memory source (RFC12-1) wins; otherwise use the fetched bytes.
  const source = sourceProp ?? fetched

  // fetch the diagram source — SKIPPED when an in-memory `source` is supplied or
  // no `url`/`fetchText` port is wired.
  useEffect(() => {
    if (sourceProp !== undefined) return
    if (url === undefined || fetchText === undefined) return
    let alive = true
    fetchText(url)
      .then((t) => {
        if (alive) setFetched(t)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [url, fetchText, sourceProp])

  // render the diagram once we have source (dynamic-import mermaid lazily so it
  // is not even parsed until this component mounts).
  useEffect(() => {
    if (source === null) return
    let alive = true
    const host = hostRef.current
    if (host === null) return
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid")
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" })
        const id = `artifact-mermaid-${seq++}`
        const { svg } = await mermaid.render(id, source)
        if (alive && hostRef.current !== null) hostRef.current.innerHTML = svg
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [source])

  if (failed) {
    return (
      <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-surface-input px-2 py-1.5 font-mono text-[11px] text-ink-secondary">
        {source ?? "(mermaid source unavailable)"}
      </pre>
    )
  }
  return (
    <div
      ref={hostRef}
      data-testid="artifact-mermaid"
      // RFC12-1 — carry the source verbatim so a non-DOM render (SSR / test)
      // still exposes the projected diagram; mermaid.render swaps innerHTML on
      // mount but leaves this attribute intact.
      {...(source !== null ? { "data-mermaid-source": source } : {})}
      className="mt-2 overflow-auto rounded-lg border border-line-subtle bg-surface-raised p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    />
  )
}

export const MermaidDiagram = memo(MermaidDiagramInner)
export default MermaidDiagram
