import { ToolRegistry } from "@/tool"

/** Maps a raw tool name to a collision-free child-local name. */
export interface ToolNamespaceStrategy {
  scope(namespaceToken: string, rawToolName: string): string
}

/** Default namespace strategy for concurrent sibling tool surfaces. */
export const prefixToolNamespace: ToolNamespaceStrategy = {
  scope(namespaceToken: string, rawToolName: string): string {
    const safe = namespaceToken.replace(/[^A-Za-z0-9_]/g, "_")
    return `${safe}__${rawToolName}`
  },
}

/** Clone a registry with each tool renamed under a child-local namespace. */
export const namespaceRegistry = (
  source: ToolRegistry,
  strategy: ToolNamespaceStrategy,
  namespaceToken: string,
): ToolRegistry =>
  new ToolRegistry(
    source.all().map((tool) => ({
      ...tool,
      name: strategy.scope(namespaceToken, tool.name),
    })),
  )
