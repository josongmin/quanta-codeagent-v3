/** Closed-port for the `fetch_rules` tool (gap-other-agent GAP 6, ADR-0509).
 *
 *  Agent-requested (description-only) rules are summoned ON DEMAND: the model
 *  describes its task, the port ranks the requestable-rules index by description
 *  overlap and returns the matches. The ranking + the rule index live OUTSIDE
 *  `@/tool` (in `@/agent` + the app composition root) so this plane stays clean;
 *  the port is the only seam. NO-THROW: a failure is a closed empty result. */

/** One matched rule the tool renders back to the model. */
export interface FetchedRule {
  readonly name: string
  readonly description: string
  readonly body: string
}

export interface FetchRulesPort {
  /** Rank the requestable-rules index by `query`, returning at most `limit`
   *  matches (the port owns the index + the matcher). Pure-ish; NO-THROW. */
  fetch(query: string, limit: number): Promise<readonly FetchedRule[]>
}
