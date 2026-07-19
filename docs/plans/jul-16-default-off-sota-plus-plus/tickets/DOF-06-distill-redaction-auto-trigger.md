# DOF-06 - distill redaction on auto-trigger

**Priority:** P0  
**Depends on:** none  
**Owner:** `src/memory/auto-trigger/**` and its construction sites

Thread the same `DistillRedactor` used by the consolidator hook into `DefaultMemoryAutoTrigger.onSessionEnd` before `runPhase1`. Enumerate every constructor call; missing injection is explicit and fail-closed where raw rollout data could reach distillation.

## DoD

- secret fixture is absent from Phase1 input through hook and auto-trigger paths
- deleting either redaction call makes the focused test RED
- no cross-slice import violation; inject the port from the host
- all constructor sites either provide the redactor or document a safe non-sensitive source
