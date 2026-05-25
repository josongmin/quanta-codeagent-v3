/**
 * Back-compat shim.
 *
 * The canonical implementation lives in `./search-codebase`. Keep this path so
 * older imports continue to resolve while the repo converges on the kebab-case
 * directory surface.
 */

export type { SearchCodebaseInput } from "./search-codebase"
export { searchCodebaseInputSchema, searchCodebaseTool } from "./search-codebase"
