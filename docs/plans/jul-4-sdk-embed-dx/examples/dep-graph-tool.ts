/**
 * Reference analysis tool authored with ONLY the public SDK door
 * (`quanta-codeagent/sdk`). Copy-paste starting point for a repo-analysis
 * consumer. Non-shell + no `url`/`host` input ⇒ NOT classified as
 * egress-bearing, so it runs freely even under the net-denied `analysis`
 * profile — a consumer tool doing its own network via your SDK is unaffected.
 */

import { z } from "zod"
// In a consumer repo this is: import { defineTool } from "quanta-codeagent/sdk"
import { defineTool } from "@/sdk"

/** Toy "import graph" tool: given a source file, return the modules it imports.
 *  Read-only (`isReadOnly: () => true`) so it survives the `read-only` profile
 *  registry filter. */
export const depGraphTool = defineTool({
  name: "dep_graph",
  description: "List the modules a source file imports (static, read-only).",
  inputSchema: z.object({ file: z.string().describe("path to a source file") }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, _ctx) {
    // Real impl would read `input.file` and parse imports (or delegate to your
    // own code-graph service via your SDK — network here is fine).
    const imports = await analyzeImports(input.file)
    // A `ToolEvent` is `{type:"progress", message}` | `{type:"result", result}`.
    // `result` is surfaced back to the model as the tool's output.
    yield {
      type: "result",
      result: { content: JSON.stringify({ file: input.file, imports }) },
    }
  },
})

// Placeholder for the consumer's real analysis backend.
declare function analyzeImports(file: string): Promise<string[]>
