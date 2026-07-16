# DOF-20 - safe availability tranches

**Priority:** P1  
**Depends on:** DOF-00, DOF-01

This is a ticket generator, not one implementation ticket. Generate one leaf per composition owner and 1-3 same-family features.

## Eligible target states

- `default_on`: safe, deterministic, no external cost, real-path proof, explicit OFF switch
- `resource_on`: activates only when a required local resource/config exists
- `policy_gated_live`: mutating/network/credential/provider-cost functionality is fully wired and discoverable but still requires explicit authority

First tranche: read-only observability and presentation-only CLI gates. Second: safe resilience/correctness gates with bounded persistence. Third: resource-detected tools whose permissions/HITL remain authoritative. Browser, network egress, command hooks, mutating Git, provider-cost generation, bench knobs, and crash-resume do not become unconditional defaults.

## Leaf DoD

- runtime-reflected current/target default matches ledger and YAML
- real ON consumer, explicit OFF identity, and inheritance matrix
- subprocess proof covers unset -> seeded ON, explicit disable preservation, child/subagent inheritance, and rollback to OFF
- permission/HITL unchanged
- telemetry names activation and fallback
- one-feature revert command/commit boundary
