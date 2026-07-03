/**
 * A2 — ArtifactStrip: the render surface for `artifact.ready` Canvas frames.
 *
 * `useArtifacts` (`canvas-hooks.ts`) collects the marker-level `ArtifactReadyMessage`
 * frames (latest-wins per id); this strip turns each into a per-kind card:
 *
 *   - `image`                                   → inline thumbnail via
 *     `artifactPreviewUrl` (`GET /artifact/<id>`) + a download affordance.
 *   - `document` / `spreadsheet` / `presentation` / `pdf` / `notebook`
 *                                               → a labeled card with a KIND
 *     badge (hue via `artifactKindHue`, sharing the `category-hues` palette) +
 *     a download link.
 *   - `mermaid`                                 → the source is shown as a
 *     fenced code fallback (an inline diagram renderer is the genuinely heavy
 *     part — deferred; see FOLLOW-UP below).
 *   - unknown kind                              → the BASE card (degrade, never
 *     render nothing).
 *
 * Codex form: this mirrors the app's own `ObservabilityPane` card aesthetic
 * (rounded border card, uppercase micro-label header, dense dark body) — the
 * same tokens the `DiffPanel` / objective cards use. Each artifact is a compact
 * card in a vertical strip.
 *
 * Default-OFF: an empty / null Map ⇒ renders `null` (the Canvas channel is OFF
 * or no artifact has been registered yet) so the pane is byte-identical.
 *
 * FOLLOW-UP (honest, deferred): the RICH per-kind VIEWERS (a spreadsheet grid,
 * a paginated PDF viewer, a live mermaid diagram) bundle third-party renderers
 * and are the genuinely heavy layer. This strip makes the channel RENDERABLE
 * (image preview + typed download + kind badge) — the heavy viewers layer on
 * top of the same `artifactPreviewUrl` seam later.
 */

import { memo } from "react"
import type { ArtifactReadyMessage } from "../../types/protocol"
import { artifactPreviewUrl } from "../../ws/canvas-hooks"
import { type PaletteColor, colorPalette } from "./tokens"

export interface ArtifactStripProps {
  /** Latest-wins-per-id artifact frames from `useArtifacts`. `null` / empty ⇒
   *  renders nothing (default-OFF, byte-identical when the channel is OFF). */
  readonly artifacts: ReadonlyMap<string, ArtifactReadyMessage> | null
  /** Base URL for the `GET /artifact/<id>` preview route. Defaults to the
   *  same origin (relative) so the daemon-served SPA just works; a Tauri /
   *  cross-origin host can pass an absolute base. */
  readonly base?: string
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

/** One artifact card. Routes by `artifactKind`; every branch degrades to a
 *  labeled card with a badge + download, so an unavailable preview URL or an
 *  unknown kind still renders SOMETHING (never nothing). */
const ArtifactCard = memo(
  ({ msg, base }: { msg: ArtifactReadyMessage; base: string }): JSX.Element => {
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
        {msg.artifactKind === "mermaid" && previewUrl === null ? (
          <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-input px-2 py-1.5 font-mono text-[11px] text-ink-secondary">
            {`(mermaid source — inline diagram render deferred)`}
          </pre>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-tertiary" title={msg.mimeType}>
            {msg.mimeType}
          </span>
          {previewUrl !== null ? (
            <DownloadLink href={previewUrl} {...(msg.name !== undefined ? { name: msg.name } : {})} />
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
  ({ artifacts, base = "" }: ArtifactStripProps): JSX.Element | null => {
    if (artifacts === null || artifacts.size === 0) return null
    return (
      <section className="flex flex-col gap-2" data-testid="artifact-strip">
        <span className={LABEL}>Artifacts ({artifacts.size})</span>
        {[...artifacts.values()].map((msg) => (
          <ArtifactCard key={msg.artifactId} msg={msg} base={base} />
        ))}
      </section>
    )
  },
)
