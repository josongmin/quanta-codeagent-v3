/**
 * A2 (rich inline) — LAZY PDF preview (first page, paginated).
 *
 * This module is the ONLY importer of `pdfjs-dist` (a large PDF engine + its
 * web worker). `ArtifactStrip` pulls it in via `lazy(() => import("./PdfPreview"))`
 * so pdfjs stays BEHIND the async boundary and is fetched only when a `pdf`
 * artifact renders — never on first paint.
 *
 * The PDF is fetched as bytes (via a small ArrayBuffer port), rendered to a
 * `<canvas>` with pdfjs, and paginated with prev/next. Any failure degrades to
 * a "preview unavailable — download" note (the parent still shows the download
 * link). The pdfjs worker is configured from a Vite `?url` import so the worker
 * chunk is emitted lazily too.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"

export interface PdfPreviewProps {
  /** Preview URL (`GET /artifact/<id>`) for the PDF bytes. */
  readonly url: string
  /** Injected ArrayBuffer fetch (defaults to ambient fetch on the real surface;
   *  tests never mount this lazy component in the node env). */
  readonly fetchBytes?: (url: string) => Promise<ArrayBuffer>
}

const defaultFetchBytes = async (url: string): Promise<ArrayBuffer> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`pdf fetch failed: ${res.status}`)
  return res.arrayBuffer()
}

// biome-ignore lint/suspicious/noExplicitAny: pdfjs types are loaded lazily.
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any> }

const PdfPreviewInner = ({ url, fetchBytes = defaultFetchBytes }: PdfPreviewProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [page, setPage] = useState(1)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist")
        // Point the worker at the lazily-emitted worker chunk (Vite `?url`).
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        const data = await fetchBytes(url)
        const loaded = await pdfjs.getDocument({ data }).promise
        if (alive) setDoc(loaded as unknown as PdfDoc)
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [url, fetchBytes])

  useEffect(() => {
    if (doc === null) return
    let alive = true
    void (async () => {
      try {
        const p = await doc.getPage(page)
        const viewport = p.getViewport({ scale: 1.2 })
        const canvas = canvasRef.current
        if (canvas === null) return
        const ctx = canvas.getContext("2d")
        if (ctx === null) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        await p.render({ canvasContext: ctx, viewport }).promise
        if (!alive) return
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [doc, page])

  const prev = useCallback(() => setPage((p) => Math.max(1, p - 1)), [])
  const next = useCallback(
    () => setPage((p) => (doc !== null ? Math.min(doc.numPages, p + 1) : p)),
    [doc],
  )

  if (failed) {
    return (
      <p className="mt-2 text-[11px] text-ink-tertiary italic">
        PDF preview unavailable — use Download.
      </p>
    )
  }
  return (
    <div data-testid="artifact-pdf" className="mt-2 flex flex-col gap-1.5">
      <div className="overflow-auto rounded-lg border border-line-subtle bg-surface-raised p-2">
        <canvas ref={canvasRef} className="mx-auto h-auto max-w-full" />
      </div>
      {doc !== null && doc.numPages > 1 ? (
        <div className="flex items-center justify-center gap-3 text-[11px] text-ink-secondary">
          <button
            type="button"
            onClick={prev}
            disabled={page <= 1}
            className="rounded border border-line px-2 py-0.5 disabled:opacity-40"
          >
            Prev
          </button>
          <span>
            {page} / {doc.numPages}
          </span>
          <button
            type="button"
            onClick={next}
            disabled={page >= doc.numPages}
            className="rounded border border-line px-2 py-0.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  )
}

export const PdfPreview = memo(PdfPreviewInner)
export default PdfPreview
