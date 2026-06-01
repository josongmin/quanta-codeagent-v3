/** Advisor tool slice barrel — ADR-0257.
 *
 *  One LLM-facing tool (`advisor`) wrapping an {@link AdvisorPort}: consult a
 *  STRONGER / DIFFERENT model for a SECOND OPINION mid-loop and receive its
 *  analysis in-band. A PURE one-shot consult — it never mutates files, runs
 *  shells, or calls other tools.
 *
 *  The port is a DUCK-TYPED narrow surface; the composition root in
 *  `@/agent/tier1/advisor` adapts a concrete `LLMPort` + model allowlist + role
 *  resolver into it at wire time, so the `@/tool` slice imports neither
 *  `@/agent` nor the concrete LLM wiring (slice fence, RFC §3.1; biome
 *  enforces).
 *
 *  Plane-clean: imports only `../types` + `zod` + `@/shared`. */

import type { Tool } from "../types"
import { advisorTool } from "./advisor"
import type { AdvisorPort } from "./port"

export type { AdvisorInput } from "./advisor"
export { advisorInputSchema, advisorTool } from "./advisor"
export type {
  AdvisorConsultRequest,
  AdvisorConsultResult,
  AdvisorErrorKind,
  AdvisorPort,
} from "./port"

/** Build the advisor tool wired to an advisor port. Returns a single-element
 *  array to mirror the `delegateTools` / `subagentBgTools` builder shape so the
 *  tier-1 composer can spread it uniformly. */
export const advisorTools = (port: AdvisorPort): Tool[] => [advisorTool(port) as Tool]
