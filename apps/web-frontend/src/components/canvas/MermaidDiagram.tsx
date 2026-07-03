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
 */

import { memo, useEffect, useRef, useState } from "react"
import type { FetchText } from "./artifact-fetch"

export interface MermaidDiagramProps {
  readonly url: string
  readonly fetchText: FetchText
}

let seq = 0

const MermaidDiagramInner = ({ url, fetchText }: MermaidDiagramProps): JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // fetch the diagram source.
  useEffect(() => {
    let alive = true
    fetchText(url)
      .then((t) => {
        if (alive) setSource(t)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [url, fetchText])

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
      className="mt-2 overflow-auto rounded-lg border border-line-subtle bg-surface-raised p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    />
  )
}

export const MermaidDiagram = memo(MermaidDiagramInner)
export default MermaidDiagram
