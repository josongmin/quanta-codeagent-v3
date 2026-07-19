# DOF-15 - per-tool snapshot lifecycle

**Priority:** P2  
**Depends on:** DOF-00  
**Owner:** per-tool recorder consumer boundary

Producer recording is live under `QUANTA_PER_TOOL_RECORD=on`; decide one product consumer before changing the default:

- wire the raw checkpoint adapter into `/rewind-tool`, or
- expose a typed telemetry/inspection surface and classify it producer-only, or
- deliberately hold the producer with retention and memory-cost bounds.

Do not call the registry STUB and do not create a second snapshot authority beside the existing SHA registry without a migration contract.

## DoD

- one canonical snapshot identity and retention policy
- record -> consume/restore or record -> inspect proof
- no unbounded memory growth; session teardown clears state
- OFF path wraps zero tools
