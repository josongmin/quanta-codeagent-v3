---
task: sparql-university
category: data-querying
difficulty: hard
tags: [knowledge-graph, sparql-query, information-retrieval]
expert_min: 800
junior_min: 10000
skill_class: DATA-WRANGLE
terminal_native: low
docker_image: alexgshaw/sparql-university:20251031
---

# sparql-university

**Goal** — Author a single SPARQL query over a Turtle knowledge graph (`/app/university_graph.ttl`) that returns full professors who work in an EU-country department where at least one of their departments has >10 currently-enrolled students. Save it to `/app/solution.sparql`.

**Solution shape** — No shell work: `solve.sh` just `cat > /app/solution.sparql` with the reference query. The query joins `uni:Person`/`role`/`worksIn`/`belongsTo`/`locatedInCountry`, hard-codes the 27 EU country ISO-2 codes as a `VALUES` block, filters enrollment by reference-date `2025-08-16` with an OPTIONAL graduation-date check, `GROUP BY ?professorName`, `HAVING(COUNT(DISTINCT ?student) > 10)`, and `GROUP_CONCAT`s countries. One file, ~40 lines.

**Verifier** — pytest + rdflib: file exists, query parses/runs without exception, and the result set (professor, sorted-countries) exactly equals a 4-row reference set on a held-out `university_graph_test.ttl`. Binary 0/1.

**Difficulty drivers** — Pure domain/spec reasoning: correct SPARQL semantics (aggregation, HAVING, OPTIONAL, date filters), knowing the exact 2025 EU member list, and modeling "currently enrolled" via enrollment/graduation dates. Graded on a *different* dataset than the agent sees, so overfitting to visible data fails. No env setup.

**quanta attack points** — Essentially a code-authoring task; `container_exec` to iterate: install rdflib, run the query against the visible `.ttl`, inspect rows. No TUI, so no `pty_*`. Main risk is the exact-match reference set on hidden data plus getting the EU-country list and date semantics right — the exit-code "iterate until tests pass" loop is weak here because the local graph is not the graded graph.
