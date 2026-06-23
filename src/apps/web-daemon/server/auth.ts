/**
 * `@/apps/web-daemon/server/auth` — bearer-token extraction + comparison.
 *
 * The constant-time compare keeps a timing oracle from leaking prefix matches;
 * `extractToken` accepts either an `Authorization: Bearer <token>` header or a
 * `?token=<token>` query param (browsers cannot set custom upgrade headers, so
 * the query path keeps the surface usable from a vanilla `WebSocket`).
 */

export const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export const extractToken = (url: URL, header: string | null): string | undefined => {
  if (header !== null) {
    const trimmed = header.trim()
    const prefix = "Bearer "
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const token = trimmed.slice(prefix.length).trim()
      if (token.length > 0) return token
    }
  }
  const q = url.searchParams.get("token")
  if (q !== null && q.length > 0) return q
  return undefined
}

export const authReject = (): Response =>
  new Response("unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
