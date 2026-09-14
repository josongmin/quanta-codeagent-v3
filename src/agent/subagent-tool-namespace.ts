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

/** Clone a registry with each tool presented under a child-local name. Each keeps its own
 *  name for policy (`ToolRegistry.policyNameOf`): the rename is for the model, and a gate
 *  keyed by tool name must not see a name it has never classified. */
export const namespaceRegistry = (
  source: ToolRegistry,
  strategy: ToolNamespaceStrategy,
  namespaceToken: string,
): ToolRegistry => {
  const policyNames = new Map<string, string>()
  const renamed = source.all().map((tool) => {
    const presented = strategy.scope(namespaceToken, tool.name)
    policyNames.set(presented, tool.name)
    return { ...tool, name: presented }
  })
  return new ToolRegistry(renamed, undefined, policyNames)
}
