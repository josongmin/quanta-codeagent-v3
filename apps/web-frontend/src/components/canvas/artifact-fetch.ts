/**
 * A2 (rich inline) — the injectable artifact-bytes fetch PORT.
 *
 * The rich inline renderers (CSV grid, notebook) need the artifact bytes as
 * text. That single network touch is isolated behind a `fetchText` port so the
 * components can be driven with a stub in a DOM-free / network-free unit test
 * (node vitest has no real `fetch`). `makeFetchText` wraps a `fetch` impl and
 * rejects on a non-2xx status so the caller degrades to a download card.
 */

/** Port: given a preview URL, resolve the artifact bytes as text (or reject). */
export type FetchText = (url: string) => Promise<string>

/**
 * Build a `FetchText` from a `fetch` impl (defaults to the global `fetch` on
 * the real surface). Rejects on a non-2xx response so a 404 / 500 for a missing
 * or too-large artifact surfaces as a degrade, not a silent empty render.
 */
export const makeFetchText =
  (fetchImpl: typeof fetch = fetch): FetchText =>
  async (url: string): Promise<string> => {
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`artifact fetch failed: ${res.status}`)
    return res.text()
  }

/** The default port bound to the ambient `fetch` (browser / Tauri webview). */
export const defaultFetchText: FetchText = makeFetchText()
