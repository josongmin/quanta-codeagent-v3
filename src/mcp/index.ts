/** MCP (Model Context Protocol) stdio client — public API.
 *
 *  Selective re-export only: framing internals (LineReader, codec) stay
 *  private to the slice. */

export { McpClient, McpError } from "./client"
export type { McpCallResult, McpServerConfig, McpToolDef } from "./types"
