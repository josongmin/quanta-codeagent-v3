# T-603: SKILL.md frontmatter validation warnings at discovery

**RFC:** [06·W3](../06-rfc-rule-provenance-and-determinism.md) · **Priority:** P2 · **Size:** M · **Deps:** none · **Posture:** ON (warnings only; discovery never fails)

## Deliverable
In `discoverSkills` (`src/skill/discover.ts:301`): validate tier/allowedTools declarations — unknown tool names (vs manifest SSOT), `hand-off-required` tools listed in `allowedTools` (will never run — author misunderstanding), malformed scope fields. Surface as discovery **warnings** (CLI startup + `/state` skills panel). Never hard-fail discovery (broken third-party skill must not brick the session); wording "suspicious" not "invalid" for judgment-call classes. SOTA: Claude Code has only a passive JSON schema — active author feedback is exceed-class.

## Acceptance criteria
- [ ] Fixture skill per defect class → warning with file + field.
- [ ] Valid skills → zero warnings.
- [ ] Discovery no-throw contract preserved (malformed YAML included).
