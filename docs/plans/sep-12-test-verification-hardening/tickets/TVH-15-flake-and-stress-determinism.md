# TVH-15 — wall-clock flake·random stress·rerun 증폭 제거

- 우선순위: P1/P2
- 상태: OPEN
- 소유 lane: test determinism / virtual time / measurement policy
- 선행: TVH-02, TVH-05, TVH-08
- 후속: TVH-10

## 확정 결함

1. ordinary test source에는 elapsed/Date/performance 기반 `toBeLessThan` 정적 후보가 130곳 있다. 전부 결함은 아니지만 기능 deadline과 host 성능 판정이 같은 tier에 섞여 있다.
2. 20~100ms 상한을 직접 판정하는 unit tests가 여러 곳이다: knobs validate/resolve/apply, persistence hydrate, error fast-path, playbook parser, LSP navigation 등이다.
3. `runner/diff-ops-hunks-stress.test.ts`, `retrieval/pipeline-hellgate.test.ts`, `session-envelope-hellgate.test.ts`, SQLite SIGKILL fuzz 등이 unseeded `Math.random()`으로 case/order/delay를 정한다.
4. web-daemon authenticated flow와 PTY tests는 state signal 대신 fixed wait를 다수 사용한다.
5. 부하성 false RED와 재현 불가능 random RED는 전체 clean campaign 재실행으로 증폭되고, 현재 receipt는 failure seed/schedule을 표준 필드로 남기지 않는다.
6. `tools/test-resilience/cli.ts:86-154`는 initial broad suite를 새로 실행한 뒤 parsed failure를 하나씩 직렬 isolation한다. `-t`가 zero-match면 file 전체를 추가 실행하며 `(file, leaf)` dedupe나 동일-file batching이 없어 N개 실패가 최대 2N개 추가 Bun process로 증폭될 수 있다.
7. first-failure adapter에는 실제 SHA와 elapsed 대신 `""`/`0`을 넣고 반환값을 보존 artifact로 쓰지 않는다. quarantine ledger는 owner/issue/expiry/firstSeenSha/fingerprint/test-existence를 검증하지 않으며 현재 한 entry도 만료되지 않는다.

## 분류·작업

- 130 후보를 `functional-deadline`, `performance-contract`, `test-only-settle`, `irrelevant-non-time`으로 machine-readable inventory한다.
- functional deadline은 fake/injected monotonic clock, deferred signal, call-count로 검증한다. 실제 process cancellation canary만 넉넉한 wall bound를 유지한다.
- performance contract는 `tests/measurement` 또는 nightly로 이동하고 warmup, sample count, median/p95, load band, platform cohort를 receipt에 남긴다.
- 모든 fuzz/property case는 deterministic PRNG와 출력 가능한 seed를 사용한다. CI seed는 HEAD+test ID로 고정하고 nightly는 여러 seed를 fan-out한다.
- random ordering을 검증할 목적이면 고정 permutation corpus를 사용하고 원래 seed universe와 coverage equality를 증명한다.
- fixed wait는 event/barrier/readiness predicate로 교체한다. 실제 debounce/TTL 시간은 virtual clock으로 전진시킨다.
- failed receipt에 seed, permutation, load/core, worker/intra width, resource claims, retry count를 기록해 동일 failure를 focused replay할 수 있게 한다.
- initial failure artifact를 immutable input으로 받고 `(file, exact test ID, fingerprint)`로 diagnosis를 dedupe한다. 같은 파일의 여러 실패는 한 bounded file process 또는 exact escaped selector batch로 진단하고 global retry/process/time budget을 둔다.
- retry pass는 required verdict를 바꾸지 않는다. diagnostic outcome은 `confirmed-real/observed-isolation-pass/inconclusive/infra-failed`로 기록하고 단일 isolation pass만으로 원인을 flake로 단정하지 않는다.
- quarantine schema는 owner, issue, firstSeenSha, failure fingerprint, resource claim, expiresAt, criticality를 필수화하고 exact live test ID와 expiry를 검증한다. 만료·unknown·critical 등록은 RED다.
- static ratchet은 ordinary functional test의 신규 strict wall assertion, unseeded `Math.random`, aggregate fixed sleep 증가를 차단한다.

## 검증

- synthetic 500ms host stall을 주입해 functional tests는 verdict가 같고 measurement test만 invalid-hot으로 분류된다.
- 같은 seed는 동일 case/order를 만들고 failure receipt의 one-command replay가 같은 입력을 재현한다.
- event가 즉시 도착하면 fixed minimum sleep 없이 즉시 종료한다.
- strict 20/50/100ms assertions를 ordinary test에 추가하면 static ratchet이 정확한 line으로 RED다.
- 같은 파일의 실패 20개를 주입해도 diagnostic child 수가 파일/selector batch 상한을 넘지 않고 first-failure SHA/fingerprint가 artifact에 남는다.
- expired/unknown/missing-owner quarantine entry와 retry-pass required promotion을 각각 주입하면 RED다.

## 완료 기준

- [ ] ordinary functional tier에 host throughput을 판정하는 strict wall assertion이 없다.
- [ ] unseeded outcome-relevant randomness가 0이다.
- [ ] fixed wait가 protocol/state readiness를 대신하지 않는다.
- [ ] flaky failure를 전체 campaign 재실행 없이 exact seed/fixture로 재현할 수 있다.
- [ ] diagnostic retry가 bounded·deduplicated이며 quarantine에는 owner·issue·expiry·fingerprint가 있다.
