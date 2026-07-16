# DOF-14 - playbook registry and real dispatch

**Priority:** P1  
**Depends on:** none  
**Owner:** `src/skill/playbook/**`, `src/apps/cli/repl/playbook-trigger-wire.ts`

Build a fail-closed `.quanta/playbooks/*.md` loader and inject its registry instead of `EMPTY_REGISTRY`. Define duplicate-name, invalid frontmatter, path escape, reload, deletion, and parse-error behavior before enabling the watcher.

## DoD

- valid playbook file -> watcher registration -> fire -> named dispatch -> external prompt queue
- invalid/duplicate entries are observable and do not silently erase valid registrations
- missing root and empty registry remain loud
- gate OFF performs no scan/watch/allocation
- test removing registry injection goes RED

Do not flip the gate in this ticket; first close real dispatch, then classify availability in DOF-20/22.
