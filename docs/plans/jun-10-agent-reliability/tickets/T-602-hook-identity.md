# T-602: Hook identity — registration-API extension + attributed render + events

**RFC:** [06·W2](../06-rfc-rule-provenance-and-determinism.md) · **Priority:** P2 · **Size:** M · **Deps:** none · **Posture:** ON (backward-compatible optional field)

## Deliverable
The hook bus does NOT know registrant identity today (R4-M6: `HookOnOptions` = `{matcher?, timeoutMs?}`, `src/agent/hooks.ts:540-549`; `StoredHandler` carries nothing) — so the deliverable is the **API extension**:
1. Extend registration with `source?: {name, origin: "builtin"|"settings"|"plugin"}`; store on `StoredHandler`; thread into `HookPromptInject` (`hooks.ts:293-296`).
2. Render `## Hook context (from: <name>)` (`src/agent/prompt.ts:430`); absent source → today's generic header.
3. Attach identity to hook decision/OTel events.
4. Sweep first-party registrants; third-party follow the optional-field path naturally.
SOTA: absorbs Claude Code's hook-source display (permission dialog, changelog v1.1698) and exceeds it (prompt attribution + events).

## Acceptance criteria
- [ ] Named hook → labeled header; legacy hook → byte-identical output.
- [ ] Defang preserved (prompt-escape hellgate extended with labeled case).
- [ ] Decision event carries identity.
- [ ] First-party registrants swept.
