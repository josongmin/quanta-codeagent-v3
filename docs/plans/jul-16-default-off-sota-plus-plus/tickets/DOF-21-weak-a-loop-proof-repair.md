# DOF-21 - proof repair queue

**Priority:** P1  
**Depends on:** DOF-00

Replace the unreceipted WEAK list with ledger-generated leaf tickets. Each leaf names one behavior, its real gate site, one consumer, and the exact missing proof tier.

Acceptable upgrades are real CLI loop, daemon transport, provider stream, external process, or platform e2e according to the claim. Pure helper calls, fake runners that replace the behavior under test, source scans, and zero-test filtered runs cannot promote a row.

Every proof has a paired control: gate OFF or one required condition removed must fail the asserted behavior. Store command, revision, tests executed, and exit code in the ledger receipt.
