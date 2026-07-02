---
task: protein-assembly
category: scientific-computing
difficulty: hard
tags: [biology, cloning, proteins]
expert_min: 60
junior_min: 300
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/protein-assembly:20251031
---

# protein-assembly

**Goal** — Design a DNA gBlock (`/app/gblock.txt`, sequence only, ≤3000 nt) encoding a FRET fusion protein: antibody-binder – donor – DHFR – acceptor – molecule-binder, joined by GS linkers (5–20 aa, none at termini). Donor/acceptor must match a 505 nm/610 nm filter cube; molecule binder must bind the benzylguanine SMILES; N-terminal Met stripped; GC 30–70% in every 50-nt window.

**Solution shape** — Bash + four heredoc Python scripts hitting live web APIs. `pip install biopython rcsb-api dnachisel requests`. (1) RCSB sequence-similarity search identifies the antibody target as the FLAG tag (`DYKDDDDK`). (2) PubChem resolves the SMILES to benzylguanine → SNAP-tag binder. (3) For each PDB id in `pdb_ids.txt`, fetch FASTA (RCSB), title, and fpbase ex/em peaks → `sequences.csv`; pick donor (ex 505) + acceptor (em 610) + SNAP. (4) DHFR pulled from `plasmid.gb` CDS translation. Assemble with (GGGGS)₃ linkers, strip Met, then `dnachisel` `DnaOptimizationProblem` (EnforceTranslation + EnforceGCContent window=50 + E. coli CodonOptimize) reverse-translates and resolves constraints; write nucleotides.

**Verifier** — pytest (biopython): one-line `[ATCG]+`, ≤3000 nt; translated protein contains FLAG, exact donor/DHFR/acceptor/SNAP AA sequences in that order starting at index 0; inter-domain gaps are `[GS]+` of length 5–20; ends exactly at SNAP; sliding 50-nt GC window count ∈ [15,35].

**Difficulty drivers** — Cross-domain biology reasoning (FRET spectral matching, antibody→antigen ID via similarity search, SMILES→ligand→binding protein, DHFR reuse) chained across multiple live bioinformatics APIs, plus a constrained codon-optimization problem (exact ordering, GC windows, linker bounds). Many independent constraints all gated.

**quanta attack points** — `container_exec` for pip + API-querying scripts + solver; no TUI. Main risk: network dependence (live RCSB/PubChem/fpbase must be reachable and stable) and any single mis-identified domain fails the strict order/identity asserts. The iterate-until-pass loop helps assemble/GC constraints (dnachisel + pytest give feedback), but the domain-ID steps need correct biology up front.
