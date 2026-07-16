# DOF-12 - prompt-suggestion live suppression state

**Priority:** P1  
**Depends on:** none  
**Owner:** CLI session-loop suppression adapter only

Replace the four hard-coded `false` values with live plan-mode, rate-limit, elicitation, and pending-permission state. Keep the suggestion model call absent when any suppression arm is true and preserve gate-OFF zero-call identity.

## DoD

- each suppression source has one real producer and one focused negative test
- pending permission/elicitation cannot cause an extra model call or render
- abort and session teardown cancel outstanding suggestion work
- feature YAML no longer says the CLI surface is unwired

Default promotion is a separate DOF-22 decision because the feature adds latency/cost and model output.
