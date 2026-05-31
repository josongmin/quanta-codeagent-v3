/** Track C (ADR-0197 follow-up) — inbound elicitation request router.
 *
 *  An MCP server we connected to can send US a JSON-RPC REQUEST (it has an
 *  `id`, a `method`, and `params`, and expects a reply). The MCP spec method
 *  for this is `elicitation/create`. Before Track C the client's `dispatch()`
 *  dropped every inbound request silently — a protocol violation, because the
 *  full negotiator ADVERTISES `elicitation: {}`. This router turns an inbound
 *  request into an {@link ElicitationPrompter} call and shapes the JSON-RPC
 *  RESULT the server is waiting for.
 *
 *  Two inbound shapes are handled:
 *
 *  1. MCP spec — `elicitation/create`:
 *       params = { message: string, requestedSchema: JSON-Schema-object }
 *     The spec's `requestedSchema` is an object with `properties`. We support
 *     the common single-primitive case (one property) by mapping the
 *     property's JSON-Schema `type` (+ `enum`) onto the matching prompter
 *     method, and answer with:
 *       result = { action: "accept", content: { <prop>: <value> } }   on ok
 *       result = { action: "decline" }    on headless-denied / validation-error
 *       result = { action: "cancel" }     on cancelled
 *     (Spec response union is exactly `accept | decline | cancel`.)
 *
 *  2. Internal — `elicitation/<method>` where `<method>` is one of the seven
 *     port methods (`promptString`, `promptBoolean`, …). `params` is the
 *     matching request object verbatim. This is the shape produced by our own
 *     `ElicitationPrompter` port (port.ts) and lets a quanta-side server speak
 *     the typed surface directly. Answer with the SAME `{action, content}`
 *     envelope for a single response codec.
 *
 *  No throws: a malformed/unsupported inbound request resolves to
 *  `{ action: "decline" }` rather than dropping the request — strictly more
 *  correct than the pre-Track-C silent drop.
 */

import type { ElicitationPrompter, ElicitationResult } from "./port"
import {
  booleanRequestSchema,
  enumRequestSchema,
  integerRequestSchema,
  multiSelectEnumRequestSchema,
  numberRequestSchema,
  singleSelectEnumRequestSchema,
  stringRequestSchema,
} from "./schemas"

/** MCP spec method that asks the client to elicit input from the user. */
export const MCP_ELICITATION_METHOD = "elicitation/create"

/** Internal-method prefix for the seven typed port shapes. */
const INTERNAL_PREFIX = "elicitation/"

/** The closed JSON-RPC RESULT we hand back. Matches the MCP spec elicitation
 *  result union: `accept` carries `content`; `decline`/`cancel` do not. */
export type ElicitationAction = "accept" | "decline" | "cancel"
export interface ElicitationResponse {
  readonly action: ElicitationAction
  readonly content?: Record<string, unknown>
}

const DECLINE: ElicitationResponse = { action: "decline" }

/** Returns true iff `method` is an elicitation request this router handles. */
export const isElicitationMethod = (method: string): boolean =>
  method === MCP_ELICITATION_METHOD || method.startsWith(INTERNAL_PREFIX)

/** Map a typed {@link ElicitationResult} to the MCP `{action, content}`
 *  envelope. `cancelled` → `cancel`; every other failure → `decline`
 *  (the server should not retry an answer the user refused/never gave). */
const toResponse = (
  result: ElicitationResult<unknown>,
  contentKey: string | null,
): ElicitationResponse => {
  if (result.ok) {
    if (contentKey === null) return { action: "accept", content: { value: result.value } }
    return { action: "accept", content: { [contentKey]: result.value } }
  }
  if (result.reason === "cancelled") return { action: "cancel" }
  return DECLINE
}

/** Narrow `params` to a plain record (or null). */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

interface SchemaProperty {
  readonly type?: string
  readonly enum?: ReadonlyArray<string>
}

/** Extract the single primitive property from an MCP `requestedSchema`.
 *  Returns null when the schema is absent, has no properties, or has more than
 *  one (we only auto-map the single-primitive case; richer schemas decline). */
const singleProperty = (
  requestedSchema: unknown,
): { name: string; prop: SchemaProperty } | null => {
  const schema = asRecord(requestedSchema)
  if (schema === null) return null
  const properties = asRecord(schema.properties)
  if (properties === null) return null
  const names = Object.keys(properties)
  if (names.length !== 1) return null
  const name = names[0] as string
  const prop = asRecord(properties[name])
  if (prop === null) return null
  return { name, prop: prop as SchemaProperty }
}

const stringEnum = (prop: SchemaProperty): ReadonlyArray<string> | null => {
  if (!Array.isArray(prop.enum)) return null
  const values = prop.enum.filter((e) => typeof e === "string")
  return values.length > 0 ? values : null
}

/** Dispatch one schema-described property to the matching prompter method and
 *  shape the accept-content under `name`. Split out of {@link handleSpecCreate}
 *  to keep each function's branch-count modest. */
const promptForProperty = async (
  prompter: ElicitationPrompter,
  name: string,
  prop: SchemaProperty,
  prompt: string,
  signal?: AbortSignal,
): Promise<ElicitationResponse> => {
  const enumValues = stringEnum(prop)
  if (enumValues !== null) {
    const req = enumRequestSchema.safeParse({ prompt, options: enumValues })
    return req.success ? toResponse(await prompter.promptEnum(req.data, signal), name) : DECLINE
  }
  switch (prop.type) {
    case "string": {
      const req = stringRequestSchema.safeParse({ prompt })
      return req.success ? toResponse(await prompter.promptString(req.data, signal), name) : DECLINE
    }
    case "number": {
      const req = numberRequestSchema.safeParse({ prompt })
      return req.success ? toResponse(await prompter.promptNumber(req.data, signal), name) : DECLINE
    }
    case "integer": {
      const req = integerRequestSchema.safeParse({ prompt })
      return req.success
        ? toResponse(await prompter.promptInteger(req.data, signal), name)
        : DECLINE
    }
    case "boolean": {
      const req = booleanRequestSchema.safeParse({ prompt })
      return req.success
        ? toResponse(await prompter.promptBoolean(req.data, signal), name)
        : DECLINE
    }
    default:
      return DECLINE
  }
}

/** Route an MCP-spec `elicitation/create` request onto the prompter. */
const handleSpecCreate = async (
  prompter: ElicitationPrompter,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ElicitationResponse> => {
  const message = typeof params.message === "string" ? params.message : ""
  const single = singleProperty(params.requestedSchema)
  // No mappable single primitive → decline (well-defined, not dropped).
  if (single === null || message.length === 0) return DECLINE
  return promptForProperty(prompter, single.name, single.prop, message, signal)
}

/** Route an internal `elicitation/<method>` request onto the prompter. The
 *  `<method>` segment names the port method; `params` is the typed request. */
const handleInternal = async (
  prompter: ElicitationPrompter,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ElicitationResponse> => {
  const sub = method.slice(INTERNAL_PREFIX.length)
  switch (sub) {
    case "promptString": {
      const req = stringRequestSchema.safeParse(params)
      return req.success ? toResponse(await prompter.promptString(req.data, signal), null) : DECLINE
    }
    case "promptNumber": {
      const req = numberRequestSchema.safeParse(params)
      return req.success ? toResponse(await prompter.promptNumber(req.data, signal), null) : DECLINE
    }
    case "promptInteger": {
      const req = integerRequestSchema.safeParse(params)
      return req.success
        ? toResponse(await prompter.promptInteger(req.data, signal), null)
        : DECLINE
    }
    case "promptBoolean": {
      const req = booleanRequestSchema.safeParse(params)
      return req.success
        ? toResponse(await prompter.promptBoolean(req.data, signal), null)
        : DECLINE
    }
    case "promptEnum": {
      const req = enumRequestSchema.safeParse(params)
      return req.success ? toResponse(await prompter.promptEnum(req.data, signal), null) : DECLINE
    }
    case "promptMultiEnum": {
      const req = multiSelectEnumRequestSchema.safeParse(params)
      return req.success
        ? toResponse(await prompter.promptMultiEnum(req.data, signal), null)
        : DECLINE
    }
    case "promptSingleEnum": {
      const req = singleSelectEnumRequestSchema.safeParse(params)
      return req.success
        ? toResponse(await prompter.promptSingleEnum(req.data, signal), null)
        : DECLINE
    }
    default:
      // Unknown internal sub-method → decline (well-defined, not dropped).
      return DECLINE
  }
}

/** Route any inbound elicitation request onto `prompter`, returning the
 *  `{action, content}` envelope to send back as the JSON-RPC `result`.
 *  Never throws. */
export const routeElicitation = async (
  prompter: ElicitationPrompter,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<ElicitationResponse> => {
  const rec = asRecord(params) ?? {}
  if (method === MCP_ELICITATION_METHOD) return handleSpecCreate(prompter, rec, signal)
  if (method.startsWith(INTERNAL_PREFIX)) return handleInternal(prompter, method, rec, signal)
  // Caller guards with isElicitationMethod; defensive decline.
  return DECLINE
}
