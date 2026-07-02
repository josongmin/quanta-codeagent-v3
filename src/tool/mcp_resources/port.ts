/** N3 — duck-typed mirror of `@/mcp/resources/port.ts` (`McpResult` + `Mcp*`).
 *
 *  Lives in `@/tool` because the slice fence forbids `@/tool` from importing
 *  `@/mcp` (mirrors `@/tool/mcp_tasks/port.ts`). The composition root in the
 *  apps/host layer adapts the concrete `McpResourcesPort` (over a live
 *  `McpClient`) into this mirror at wire time. Any drift between the producer
 *  shapes and this mirror is a TYPE error at the adapter site.
 *
 *  String-IDENTICAL members to `@/mcp/resources/port.ts`'s `McpResult<T>` +
 *  `McpResource` / `McpResourceContent` / `McpPrompt` / `McpPromptResult` so the
 *  apps-layer adapter assigns with the identity. Adding a field requires updating
 *  BOTH `@/mcp/resources/port.ts` AND this declaration. */

/** Mirror of `McpResourceFailure`. A closed union so the tool branches without
 *  string-matching. */
export type ResourcesFailureReason = "unsupported" | "malformed" | "transport" | "too-large"

/** Mirror of `McpResource` — one entry from `resources/list`. */
export interface ResourceEntry {
  readonly uri: string
  readonly name?: string
  readonly mimeType?: string
  readonly description?: string
}

/** Mirror of `McpResourceTemplate` — one entry from `resources/templates/list`.
 *  The required field is `uriTemplate` (an RFC 6570 URI Template, e.g.
 *  `file:///logs/{name}.log`) — NOT a concrete `uri`; the rest are the same
 *  optional descriptors as {@link ResourceEntry}. */
export interface ResourceTemplateEntry {
  readonly uriTemplate: string
  readonly name?: string
  readonly mimeType?: string
  readonly description?: string
}

/** Mirror of `McpResourceContent` — one content block from `resources/read`.
 *  A well-formed block populates exactly one of `text` (UTF-8) XOR `blob`
 *  (base64). */
export interface ResourceBlock {
  readonly uri: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}

/** Mirror of `McpPromptArgument`. */
export interface PromptArgument {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

/** Mirror of `McpPrompt` — one entry from `prompts/list`. */
export interface PromptEntry {
  readonly name: string
  readonly description?: string
  readonly arguments?: ReadonlyArray<PromptArgument>
}

/** Mirror of `McpPromptMessage`. `content` is passed through verbatim (text /
 *  image / resource block union) — the consumer owns the block codec, exactly as
 *  the source slice leaves it `unknown`. */
export interface PromptMessage {
  readonly role: "user" | "assistant"
  readonly content: unknown
}

/** Mirror of `McpPromptResult`. */
export interface PromptResult {
  readonly messages: ReadonlyArray<PromptMessage>
  readonly description?: string
}

/** Mirror of `McpResult<T>` — no-throw result for every outbound typed method. */
export type HandleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ResourcesFailureReason; readonly message: string }

/** Duck-typed host port the four N3 tools speak to. The host adapts a live
 *  `McpClient` (via the `@/mcp` `clientResourcesPort` adapter) into this shape.
 *  Every method is NO-THROW (returns a typed `HandleResult`). */
export interface ResourcesHandle {
  listResources(): Promise<HandleResult<ResourceEntry[]>>
  listResourceTemplates(): Promise<HandleResult<ResourceTemplateEntry[]>>
  readResource(uri: string): Promise<HandleResult<ResourceBlock[]>>
  /** B4 — DIRECT children of a directory-shaped resource uri. MCP has no native
   *  read-dir RPC, so this composes `resources/list` + a direct-children filter
   *  (subdirs carry mimeType `inode/directory`). Same `HandleResult` no-throw
   *  contract. */
  readResourceDir(uri: string): Promise<HandleResult<ResourceEntry[]>>
  listPrompts(): Promise<HandleResult<PromptEntry[]>>
  getPrompt(name: string, args?: Record<string, unknown>): Promise<HandleResult<PromptResult>>
}
