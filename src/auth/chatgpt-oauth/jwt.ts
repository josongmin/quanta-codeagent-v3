/** Decode a JWT payload WITHOUT verifying the signature. The OpenAI backend
 *  signs the id_token / access_token; downstream API rejection on a tampered
 *  token is the authoritative check. Local decode exists only to surface
 *  plan / account info in the UI and to gate Free accounts before the wire
 *  call. NEVER trust local claims for security decisions — only display +
 *  preflight UX gating. */

export interface ChatGPTClaims {
  readonly sub?: string
  readonly email?: string
  readonly exp?: number
  /** Auth-namespace claims from the OpenAI id_token
   *  (key `https://api.openai.com/auth`). */
  readonly chatgpt_plan_type?: string
  readonly chatgpt_account_id?: string
  readonly chatgpt_user_id?: string
}

export class JwtDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JwtDecodeError"
  }
}

const fromBase64Url = (s: string): Buffer => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  return Buffer.from(padded + pad, "base64")
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object"

const OPENAI_AUTH_NS = "https://api.openai.com/auth"

const extractClaims = (payload: Record<string, unknown>): ChatGPTClaims => {
  const nsRaw = payload[OPENAI_AUTH_NS]
  const ns = isObject(nsRaw) ? nsRaw : {}
  return {
    ...(typeof payload.sub === "string" ? { sub: payload.sub } : {}),
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}),
    ...(typeof ns.chatgpt_plan_type === "string"
      ? { chatgpt_plan_type: ns.chatgpt_plan_type }
      : {}),
    ...(typeof ns.chatgpt_account_id === "string"
      ? { chatgpt_account_id: ns.chatgpt_account_id }
      : {}),
    ...(typeof ns.chatgpt_user_id === "string"
      ? { chatgpt_user_id: ns.chatgpt_user_id }
      : {}),
  }
}

/** Decode JWT payload into our claim subset. Throws JwtDecodeError on shape
 *  failure. */
export const decodeJwtClaims = (token: string): ChatGPTClaims => {
  const parts = token.split(".")
  if (parts.length !== 3) {
    throw new JwtDecodeError(`expected 3 JWT segments, got ${parts.length}`)
  }
  const payloadSeg = parts[1] ?? ""
  let raw: string
  try {
    raw = fromBase64Url(payloadSeg).toString("utf8")
  } catch (e) {
    throw new JwtDecodeError(`base64url decode failed: ${(e as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new JwtDecodeError(`json parse failed: ${(e as Error).message}`)
  }
  if (!isObject(parsed)) {
    throw new JwtDecodeError("payload is not a JSON object")
  }
  return extractClaims(parsed)
}

/** True ONLY when the plan claim is literally "free" (case-insensitive).
 *  Other values (plus / pro / team / business / enterprise) pass. Absent
 *  claim does NOT auto-fail — the API will surface a 403 if the account
 *  truly lacks access, and we'd rather attempt the call than block a
 *  legitimate token whose plan field was just stripped. */
export const isFreePlan = (claims: ChatGPTClaims): boolean => {
  const p = claims.chatgpt_plan_type
  return typeof p === "string" && p.toLowerCase() === "free"
}
