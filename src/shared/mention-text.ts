/**
 * Canonical one-line projection for mention descriptions.
 *
 * Mentions are orientation metadata, not full document injection. Cut at the
 * first LF (which also handles CRLF) and trim boundary whitespace so every
 * resolver and autocomplete surface renders the same bytes.
 */
export const mentionFirstLine = (text: string | undefined): string => {
  if (typeof text !== "string" || text.length === 0) return ""
  const newline = text.indexOf("\n")
  return (newline === -1 ? text : text.slice(0, newline)).trim()
}
