# LSP-04 - feature-catalog and promotion honesty

## Goal

Make catalog maturity/promotion language match the actual proof state of the LSP
warm backend.

## Problem

`lsp-warm-backend-prewarm.yaml` is currently honest about the seam being wired,
but it does not encode the remaining stability-proof gap strongly enough:

- `monitoring: none`
- no explicit promotion gate tied to typed runtime receipts and strict ready
  proof

That is how a technically correct implementation can still read as more closed
than it is.

## Deliverable

Update the catalog entry so that:

- current maturity is defended by actual evidence;
- the next promotion step explicitly depends on typed LSP receipts and strict
  ready proof;
- monitoring/reporting expectations are named instead of implied.

This ticket may keep the current maturity if the evidence bar is satisfied, but
it must add a precise promotion path. If the bar is not satisfied, downgrade.

## Acceptance

- catalog text no longer overstates stability closure;
- promotion criteria mention strict ready proof and typed runtime status;
- `bun fc validate` and `bun fc build` are green when the catalog change lands.
