/**
 * A2 — ArtifactStrip: the render surface for `artifact.ready` Canvas frames.
 *
 * `useArtifacts` (`canvas-hooks.ts`) collects the marker-level `ArtifactReadyMessage`
 * frames (latest-wins per id); this strip turns each into a per-kind card, and —
 * for the rich kinds — an INLINE viewer that fetches the artifact bytes from the
 * daemon `GET /artifact/<id>` route and renders them in place:
 *
 *   - `image`                    → inline thumbnail via `artifactPreviewUrl`.
 *   - `spreadsheet` / CSV        → inline scrollable GRID (sticky header,
 *     monospace, bounded rows + "+N more"). Bytes fetched + parsed (`parseCsv`).
 *   - `notebook` (`.ipynb`)      → inline stacked CELLS (markdown / code + text
 *     & image outputs). Bytes fetched + parsed (`parseNotebook`).
 *   - `mermaid`                  → inline diagram, rendered by the LAZY
 *     `MermaidDiagram` (mermaid.js is dynamic-imported behind a `lazy` boundary
 *     — never on first paint).
 *   - `pdf`                      → inline first-page canvas + pager, rendered by
 *     the LAZY `PdfPreview` (pdfjs-dist is dynamic-imported behind `lazy`).
 *   - unknown / other            → the BASE card (kind badge + download).
 *
 * Every rich viewer DEGRADES to the base card + download on a fetch failure or a
 * malformed payload (never a crash, never nothing). The bytes touch is isolated
 * behind an injectable `fetchText` port so the decision + render shape are
 * unit-testable with no network (see `ArtifactStrip.rich.test.tsx`).
 *
 * Codex form: mirrors the app's `ObservabilityPane` / `DiffPanel` card aesthetic
 * (rounded border card, uppercase micro-label header, dense dark body) — and the
 * Codex Desktop artifact panels (spreadsheet grid, notebook cell stack, paginated
 * PDF). The heavy renderers are lazy-loaded, matching Codex's own lazy
 * `notebook-preview-panel` / `docx-preview-panel` chunk split.
 *
 * Default-OFF: an empty / null Map ⇒ renders `null` (byte-identical when the
 * Canvas channel is OFF or no artifact is registered yet).
 */

import { lazy, memo, Suspense, useEffect, useReducer } from "react"
import type { ArtifactReadyMessage } from "../../types/protocol"
import { artifactPreviewUrl } from "../../ws/canvas-hooks"
import { defaultFetchText, type FetchText } from "./artifact-fetch"
import {
  boundCsvRows,
  type CsvTable,
  type NotebookCell,
  parseCsv,
  parseNotebook,
} from "./artifact-parse"
import { colorPalette, type PaletteColor } from "./tokens"

/* Heavy inline viewers — LAZY so mermaid.js / pdfjs-dist stay behind the async
 * boundary and never land in the initial chunk (see the module docblocks +
 * `vite.config.ts` regression note). */
const LazyMermaidDiagram = lazy(async () => {
  const m = await import("./MermaidDiagram")
  return { default: m.MermaidDiagram }
})
const LazyPdfPreview = lazy(async () => {
  const m = await import("./PdfPreview")
  return { default: m.PdfPreview }
})

/** DOM-cap for the CSV grid — a huge sheet stays bounded; the overflow is
 *  reported as a "+N more rows" footer rather than rendering thousands of rows. */
const CSV_ROW_CAP = 200

export interface ArtifactStripProps {
  /** Latest-wins-per-id artifact frames from `useArtifacts`. `null` / empty ⇒
   *  renders nothing (default-OFF, byte-identical when the channel is OFF). */
  readonly artifacts: ReadonlyMap<string, ArtifactReadyMessage> | null
  /** Base URL for the `GET /artifact/<id>` preview route. Defaults to the
   *  same origin (relative) so the daemon-served SPA just works; a Tauri /
   *  cross-origin host can pass an absolute base. */
  readonly base?: string
  /** Injectable artifact-bytes port (test seam). Defaults to the ambient
   *  `fetch`-backed port on the real surface. */
  readonly fetchText?: FetchText
}

/* shared card + section-label primitives (Codex-aligned tokens, verbatim from
 * ObservabilityPane so the strip is visually coherent with the pane). */
const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/** Per-kind badge hue — reuses the shared `category-hues` palette (tokens.ts)
 *  so the badge coloring is coherent with the usage legend. Unknown ⇒ gray. */
export const artifactKindHue = (kind: string): PaletteColor => {
  switch (kind) {
    case "image":
      return "blue"
    case "document":
      return "green"
    case "spreadsheet":
      return "purple"
    case "presentation":
      return "orange"
    case "pdf":
      return "pink"
    case "notebook":
      return "yellow"
    case "mermaid":
      return "purple"
    default:
      return "gray"
  }
}

/** Which inline viewer (if any) a frame routes to. Pure — the per-kind DECISION,
 *  unit-tested directly. Routing keys off the declared `artifactKind` first,
 *  falling back to the MIME type so a mislabeled kind with a known mime still
 *  renders richly. `null` ⇒ the plain card (image thumbnail / download). */
export type InlineRenderer = "csv" | "notebook" | "mermaid" | "pdf" | null

export const pickInlineRenderer = (msg: ArtifactReadyMessage): InlineRenderer => {
  const kind = msg.artifactKind
  const mime = msg.mimeType
  if (kind === "image" || mime.startsWith("image/")) return null
  if (kind === "spreadsheet" || /csv/i.test(mime)) return "csv"
  if (kind === "notebook" || /ipynb/i.test(mime)) return "notebook"
  if (kind === "mermaid" || /mermaid/i.test(mime)) return "mermaid"
  if (kind === "pdf" || mime === "application/pdf") return "pdf"
  return null
}

const KindBadge = ({ kind }: { kind: string }): JSX.Element => (
  <span
    className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink"
    style={{ background: `${colorPalette[artifactKindHue(kind)]}` }}
  >
    {kind}
  </span>
)

const DownloadLink = ({ href, name }: { href: string; name?: string }): JSX.Element => (
  <a
    href={href}
    download={name ?? true}
    className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-secondary hover:bg-black/[0.05] hover:text-ink"
  >
    Download
  </a>
)

/* ------------------------- CSV grid (data-in) ------------------------- */

/** Render a parsed CSV table as a scrollable, sticky-header grid. Pure (data
 *  in, markup out) — the render SHAPE is unit-tested via `renderToStaticMarkup`.
 *  React escapes every cell text node, so hostile cell content cannot execute. */
export const CsvGrid = memo(({ table }: { table: CsvTable }): JSX.Element => {
  const { shown, hidden } = boundCsvRows(table.rows, CSV_ROW_CAP)
  return (
    <div
      data-testid="artifact-csv-grid"
      className="mt-2 max-h-64 overflow-auto rounded-lg border border-line-subtle bg-surface-raised"
    >
      <table className="w-full border-collapse font-mono text-[11px]">
        <thead className="sticky top-0 z-[1] bg-surface-input">
          <tr>
            {table.header.map((h, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: CSV columns are positional.
                key={i}
                className="whitespace-nowrap border-line-subtle border-b px-2 py-1 text-left font-semibold text-ink-secondary"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: CSV rows are positional.
              key={r}
              className="odd:bg-black/[0.04]"
            >
              {row.map((cell, c) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: CSV cells are positional.
                  key={c}
                  className="max-w-[24rem] truncate border-line-subtle/40 border-b px-2 py-0.5 text-ink"
                  title={cell}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <div className="border-line-subtle border-t px-2 py-1 text-[10px] text-ink-tertiary">
          +{hidden} more rows (download for the full sheet)
        </div>
      ) : null}
    </div>
  )
})

/* ---------------------- Notebook cells (data-in) ---------------------- */

const NotebookOutputBlock = ({
  text,
  image,
  isError,
}: {
  text: string
  image?: string
  isError?: boolean
}): JSX.Element => {
  if (image !== undefined) {
    return (
      <img
        src={image}
        alt="notebook output"
        className="mt-1 max-h-56 rounded border border-line-subtle bg-white/5 object-contain"
      />
    )
  }
  return (
    <pre
      className={`mt-1 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-input px-2 py-1 text-[11px] ${
        isError ? "text-danger" : "text-ink-secondary"
      }`}
    >
      {text}
    </pre>
  )
}

/** Render normalized notebook cells as stacked blocks. Pure (data in, markup
 *  out). Markdown cells render as escaped text in a bordered block (NOT via a
 *  raw-HTML renderer) — the lazy `MarkdownMessage` chunk is intentionally NOT
 *  imported here so the notebook viewer stays light and cannot execute embedded
 *  HTML. Code + outputs render in monospace blocks; React escapes all text. */
export const NotebookView = memo(
  ({ cells }: { cells: readonly NotebookCell[] }): JSX.Element => (
    <div
      data-testid="artifact-notebook"
      className="mt-2 flex max-h-80 flex-col gap-1.5 overflow-auto"
    >
      {cells.map((cell, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: notebook cells are positional.
          key={i}
          data-cell={cell.type}
          className="rounded-lg border border-line-subtle bg-surface-raised p-2"
        >
          <div className="mb-1 flex items-center gap-2 text-[10px] text-ink-tertiary uppercase tracking-wide">
            <span>{cell.type}</span>
            {cell.executionCount !== undefined ? <span>[{cell.executionCount}]</span> : null}
          </div>
          <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-ink">
            {cell.source}
          </pre>
          {(cell.outputs ?? []).map((out, o) => (
            <NotebookOutputBlock
              // biome-ignore lint/suspicious/noArrayIndexKey: outputs are positional.
              key={o}
              text={out.text}
              {...(out.image !== undefined ? { image: out.image } : {})}
              {...(out.isError === true ? { isError: true } : {})}
            />
          ))}
        </div>
      ))}
    </div>
  ),
)

/* ---------------- Async fetch+parse orchestration (hook) ---------------- */

type ByteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed" }

type ByteAction = { type: "start" } | { type: "ready"; text: string } | { type: "fail" }

const byteReducer = (_s: ByteState, a: ByteAction): ByteState => {
  switch (a.type) {
    case "start":
      return { status: "loading" }
    case "ready":
      return { status: "ready", text: a.text }
    case "fail":
      return { status: "failed" }
  }
}

/** Fetch the artifact bytes as text (once per url) via the injected port. */
const useArtifactText = (url: string | null, fetchText: FetchText): ByteState => {
  const [state, dispatch] = useReducer(byteReducer, { status: "idle" })
  useEffect(() => {
    if (url === null) return
    let alive = true
    dispatch({ type: "start" })
    fetchText(url)
      .then((text) => {
        if (alive) dispatch({ type: "ready", text })
      })
      .catch(() => {
        if (alive) dispatch({ type: "fail" })
      })
    return () => {
      alive = false
    }
  }, [url, fetchText])
  return state
}

const LoadingNote = (): JSX.Element => (
  <p className="mt-2 text-[11px] text-ink-tertiary italic">Loading preview…</p>
)

/** CSV inline viewer: fetch → parse → grid, or nothing (⇒ parent card keeps the
 *  download link) on load-failure / malformed CSV. */
const CsvInline = ({
  url,
  fetchText,
}: {
  url: string
  fetchText: FetchText
}): JSX.Element | null => {
  const state = useArtifactText(url, fetchText)
  if (state.status === "loading" || state.status === "idle") return <LoadingNote />
  if (state.status === "failed") return null
  const table = parseCsv(state.text)
  if (table === null) return null
  return <CsvGrid table={table} />
}

/** Notebook inline viewer: fetch → parse → cells, or nothing on failure. */
const NotebookInline = ({
  url,
  fetchText,
}: {
  url: string
  fetchText: FetchText
}): JSX.Element | null => {
  const state = useArtifactText(url, fetchText)
  if (state.status === "loading" || state.status === "idle") return <LoadingNote />
  if (state.status === "failed") return null
  const cells = parseNotebook(state.text)
  if (cells === null || cells.length === 0) return null
  return <NotebookView cells={cells} />
}

/** Route a frame to its inline viewer (or `null` for the plain card). Heavy
 *  viewers mount behind `Suspense` so their lazy chunk loads on demand. */
const InlineViewer = ({
  msg,
  url,
  fetchText,
}: {
  msg: ArtifactReadyMessage
  url: string
  fetchText: FetchText
}): JSX.Element | null => {
  switch (pickInlineRenderer(msg)) {
    case "csv":
      return <CsvInline url={url} fetchText={fetchText} />
    case "notebook":
      return <NotebookInline url={url} fetchText={fetchText} />
    case "mermaid":
      return (
        <Suspense fallback={<LoadingNote />}>
          <LazyMermaidDiagram url={url} fetchText={fetchText} />
        </Suspense>
      )
    case "pdf":
      return (
        <Suspense fallback={<LoadingNote />}>
          <LazyPdfPreview url={url} />
        </Suspense>
      )
    default:
      return null
  }
}

/** One artifact card. Routes by kind; every branch degrades to a labeled card
 *  with a badge + download, so an unavailable preview URL, a failed fetch, or an
 *  unknown kind still renders SOMETHING (never nothing). */
const ArtifactCard = memo(
  ({
    msg,
    base,
    fetchText,
  }: {
    msg: ArtifactReadyMessage
    base: string
    fetchText: FetchText
  }): JSX.Element => {
    const previewUrl = artifactPreviewUrl(msg.locator, base)
    const title = msg.name ?? msg.artifactId
    const isImage = msg.artifactKind === "image" || msg.mimeType.startsWith("image/")
    return (
      <div className={CARD} data-testid="artifact-card" data-kind={msg.artifactKind}>
        <header className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-ink" title={title}>
            {title}
          </span>
          <KindBadge kind={msg.artifactKind} />
        </header>
        {isImage && previewUrl !== null ? (
          <a href={previewUrl} target="_blank" rel="noreferrer" className="mt-2 block">
            <img
              src={previewUrl}
              alt={title}
              className="max-h-40 w-full rounded-lg border border-line-subtle object-contain bg-surface-raised"
            />
          </a>
        ) : null}
        {previewUrl !== null ? (
          <InlineViewer msg={msg} url={previewUrl} fetchText={fetchText} />
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-tertiary" title={msg.mimeType}>
            {msg.mimeType}
          </span>
          {previewUrl !== null ? (
            <DownloadLink
              href={previewUrl}
              {...(msg.name !== undefined ? { name: msg.name } : {})}
            />
          ) : (
            <span className="text-[11px] text-ink-faint italic">unavailable</span>
          )}
        </div>
      </div>
    )
  },
)

/**
 * The artifact strip — one card per ready artifact (insertion-ordered, latest-
 * wins per id). Empty / null ⇒ renders `null` (default-OFF).
 */
export const ArtifactStrip = memo(
  ({
    artifacts,
    base = "",
    fetchText = defaultFetchText,
  }: ArtifactStripProps): JSX.Element | null => {
    if (artifacts === null || artifacts.size === 0) return null
    return (
      <section className="flex flex-col gap-2" data-testid="artifact-strip">
        <span className={LABEL}>Artifacts ({artifacts.size})</span>
        {[...artifacts.values()].map((msg) => (
          <ArtifactCard key={msg.artifactId} msg={msg} base={base} fetchText={fetchText} />
        ))}
      </section>
    )
  },
)
