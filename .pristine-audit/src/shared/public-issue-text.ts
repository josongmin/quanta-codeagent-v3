/**
 * Normalize public issue text before routing it into prompts or extractors.
 *
 * GitHub issue templates often contain HTML comments that are hidden in the
 * rendered issue but still present in exported benchmark datasets. Those comment
 * blocks are scaffold noise, not user-visible public evidence.
 */

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

export const stripHtmlComments = (text: string): string =>
  text.includes("<!--") ? text.replace(HTML_COMMENT_RE, "") : text

export const normalizePublicIssueText = (text: string | undefined): string | undefined => {
  if (typeof text !== "string") return undefined
  return stripHtmlComments(text)
}
