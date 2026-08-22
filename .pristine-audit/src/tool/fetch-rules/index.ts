/** Barrel — `fetch_rules` agent-requested rule retrieval (gap GAP 6, ADR-0509). */
export {
  FETCH_RULES_MAX_QUERY,
  type FetchRulesInput,
  fetchRulesInputSchema,
  fetchRulesTool,
} from "./fetch-rules"
export type { FetchedRule, FetchRulesPort } from "./port"
