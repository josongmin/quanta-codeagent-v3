/**
 * Barrel for the Windsurf-style `{{ variable }}` template-literal expander
 * (ADR-0252). Sibling sub-slice of the ADR-0203 `!macro` expander.
 *
 * Slice posture: ADDITIVE. The playbook root barrel
 * (`src/skill/playbook/index.ts`) is NOT modified — hosts that opt into the
 * template-literal surface import from `@/skill/playbook/template-literal`
 * directly. This keeps the default-OFF byte-identical invariant
 * (HELL-TL-14) mechanically enforceable.
 *
 * Import discipline: only sibling files inside this directory. NO imports
 * from `@/agent`, `@/tool`, `@/permission`, `@/storage`, `node:fs`, or
 * `yaml`. The slice is a pure leaf primitive.
 */

export { createDefaultTemplateExpander } from "./default-expander"
export type { TemplateExpander } from "./port"
export type {
  ExpandContext,
  ExpandError,
  ExpandResult,
  ExpandValue,
  NestedContext,
} from "./types"
