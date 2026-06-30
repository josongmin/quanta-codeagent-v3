# No-Go Rules

1. Do not add new `god-code` allowlist entries for bench work. Split code instead.
2. Do not add new source-string parity tests as the primary way to keep duplicate implementations aligned.
3. Do not move reusable runtime semantics into `src/apps/bench/**` to make a ticket easier.
4. Do not mutate `process.env` in one bench layer just to communicate typed state to another layer.
5. Do not add new direct `process.env` reads below the chosen config boundary.
6. Do not add new cross-surface runtime imports under `src/apps/**`.
7. Do not merge bench-owned red and unrelated repo-global red into one "still failing" bucket. Split them.
8. Do not refactor acceptance/location-fanout/repair-breadth files blindly while the current surrounding drift is unresolved.
9. Do not keep the `selection-executor` / `selection-finalize` cycle as a permanent design state.
10. Do not claim extensibility if adding a new dataset/backend/profile still requires edits in more than one owner layer.
11. Do not close a ticket without adding its report file.
12. Do not collapse `partial`, `blocked`, and `done` into one status. Use the correct word.
