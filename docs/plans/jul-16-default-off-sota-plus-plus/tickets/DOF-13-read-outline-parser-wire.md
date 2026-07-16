# DOF-13 - read-outline parser composition

**Priority:** P1  
**Depends on:** none  
**Owner:** default read-tool construction and parser port

Inject a parser into `makeReadTool` only when `QUANTA_READ_OUTLINE` is on. Reuse the parser authority used by syntax indexing without coupling tool and retrieval slices directly; thread a port through the agent/host composition root.

## DoD

- outline ON + supported clean source returns declarations through the production tool registry
- OFF path constructs no parser and is byte-identical
- parse failure, unsupported language, missing grammar, and budget overflow degrade visibly to line read
- syntax index chunking retains independent `QUANTA_SYNTAX_CHUNK` behavior
- bench registry identity apply remains documented as intentional and is not treated as runtime wiring
