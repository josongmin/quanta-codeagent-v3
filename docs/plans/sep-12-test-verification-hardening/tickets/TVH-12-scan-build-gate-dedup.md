# TVH-12 — scan/build/gate producer 중복 제거

- 우선순위: P1
- 상태: IN PROGRESS
- 소유 lane: static producers / artifact receipts / hosted CI setup
- 선행: TVH-02, TVH-05, TVH-06
- 후속: TVH-09, TVH-10

## 확정 결함

1. required static job이 `lint`와 `lint:debt`를 실행한 뒤 full suite의 `tests/integration/lint-debt-ratchet-e2e.test.ts:33-50`가 `lint:debt`를 다시 spawn한다. full job에는 static receipt가 없어 7,200여 파일 Biome fallback을 다시 수행하며 파일 자체의 측정값은 9.3~20.9초다.
2. feature catalog는 `bun fc ci`, full suite의 evidence/DoD/reachability/wiring tests, 별도 `fc-gate.yml`에서 반복 load/scan된다. evidence test는 contention 시 30초 이상을 명시한다.
3. scan baseline은 192 IDs, 합계 253,199 path visits다. 61개 scan이 3,000개 이상 경로를 걷고 55개 파일에 분산된다. `git ls-files` cache는 process-local이라 44 Bun process에서 재구매된다.
4. ordinary unit/full은 서로 다른 네 파일에서 `bun build --compile`을 총 5회 수행한다.
5. `bench-results-fence-hellgate`는 `bench-write-artifacts` 전체 suite를 child로 두 번 실행하고 정상 membership까지 합쳐 같은 suite를 3회 실행한다.
6. shadow matrix는 44 one-chunk jobs가 각각 root install을 수행한다. normal PR도 static/catalog/full/PTY/toolchain/contract와 `fc-gate`에서 install/setup을 반복한다.
7. `test:non-vacuity`는 guard 11개 각각에 `src`/`tests` mirror를 새로 만든다. `cp -Rc` fast path는 APFS clonefile 전제이고 Linux에서는 per-file fallback으로 내려가 수십 MB tree copy를 반복할 수 있다.
8. `cwd-parity-arch`는 full receipt가 이미 가진 root-cwd 결과를 소비하지 않고 root arm과 sandbox arm을 모두 다시 실행한다.
9. package-level `test:clean-js`, preload cleanup, managed runner pre/postflight가 동일 source tree traversal을 서로 다른 실행 경로에서 반복한다.
10. root `postinstall`은 모든 `bun install`에서 `git config core.hooksPath .githooks`를 실행한다. hosted CI와 immutable dependency setup도 repository-local Git config write를 구매하며 dependency artifact의 read-only/setup-only 계약을 흐린다.
11. `test:clean-js`는 `find tests tools -name '*.js' -delete`라 dot-directory와 ignored scratch를 prune하지 않는다. 현재 local workspace의 `tools/dev/.scratch`는 HEAD 밖의 4,437 files/132MiB이고 read-only timing에서 무제한 walk는 0.09~0.36초, dot-directory prune은 0.02~0.03초였다. 비용과 삭제 대상이 ambient ignored state에 따라 달라진다.
12. `discoverInventory`는 겹치는 `full/core/unit/integration` roots를 네 번 별도 walk하고, ordinary discovery/policy tests는 real repository inventory를 네 번 구성하며 full-only walk도 두 번 더 수행한다. 같은 immutable HEAD의 suite relation 검증이 반복 filesystem traversal을 구매한다.
13. web command는 `apps/web-frontend/node_modules/.bin/vitest` 존재 여부만 보고 frozen install을 생략한다. local은 stale install을 재사용할 수 있고 fresh CI는 항상 install해 같은 command 문자열의 setup 의미와 비용이 다르다.
14. exact receipt는 root/frontend lockfile과 실제 dependency materialization 상태를 bind하지 않는다. ignored `node_modules`는 clean Git snapshot에도 보이지 않아 lock B checkout에서 install A를 실행할 수 있다.

## producer → receipt → consumer 구조

| producer | 한 번 생성할 artifact | consumer |
|---|---|---|
| static-code | exact target digest, Biome JSON, lint-debt verdict | full reachability assertion, required aggregator |
| feature-catalog | YAML snapshot digest, validate/diff/lint/evidence/reachability sub-verdict | full synthetic guards, fc context aggregator |
| repo-scan | tracked path+content manifest, source snapshot digest | 192 population/architecture scans |
| compiled-probe | compiled binary digest + five behavioral sub-verdict | asset/system-skill/shell-parser/fork-port guards |
| dependency-setup | lockfile/runtime/platform digest + immutable dependency artifact | matrix workers and capability jobs |
| full-suite JUnit | exact file/case verdict at repo-root cwd | cwd-parity root control arm |
| source-clean producer | tracked source-JS inventory/cleanup receipt | package scripts, preload, runner postflight |
| dependency bootstrap | lockfile/runtime/platform digest, package cache, hook-policy receipt | PR/nightly/matrix installs |
| discovery inventory | 한 번의 tracked test-path snapshot과 suite/out-of-band projections | runner discovery, policy enrollment, matrix, discovery rails |

## 구현 원칙

- 실제 tree/tool 실행 authority는 producer 하나만 소유한다. consumer는 exact HEAD/input/policy/tool fingerprint를 독립 검증한다.
- full suite에는 decision logic과 red-on-injection synthetic tests를 남긴다. producer artifact missing/stale/corrupt는 skip/pass가 아니라 RED다.
- runner가 tracked-file/content manifest를 한 번 freeze해 read-only로 전달하고 scan-heavy tests를 `repo-scan` resource로 분류한다.
- 동일 root walk는 한 process에서 fuse하되 각 guard의 population floor와 offending path attribution은 유지한다.
- compiled binary는 한 번 build하고 sub-probe entrypoint/arguments로 다섯 behavior를 검증한다. 격리가 필요하면 복사본을 사용하되 rebuild하지 않는다.
- nested whole-suite 실행은 최소 재현용 전용 probe로 교체한다.
- hosted matrix는 소수 long-lived workers 또는 verified immutable setup artifact를 사용해 install 횟수가 chunk 수에 비례하지 않게 한다.
- empty-mirror는 campaign당 immutable base snapshot을 한 번 만들고 per-guard copy-on-write overlay를 사용한다. 플랫폼별 clone 지원 여부와 copied bytes/time을 receipt에 남긴다.
- cwd parity는 current exact full JUnit을 root control로 소비하고 sandbox arm만 추가 실행한다. receipt가 없거나 file set이 다르면 fail closed한다.
- Git hook 설치는 explicit local setup command로 분리하거나 CI/non-worktree detection에서 skip한다. dependency install 자체는 `.git/config`를 쓰지 않으며 hook policy는 별도 receipt로 검증한다.
- cleanup은 tracked candidate manifest 또는 owned roots만 대상으로 하고 ignored/dot-directory를 recurse하지 않는다. 실제 stale `.js` red injection과 보존 exception은 유지한다.
- suite inventory는 test path를 한 번 enumerate한 뒤 prefix/root projection으로 `full/core/unit/integration/out-of-band`를 계산한다. real-tree determinism rail은 한 snapshot의 repeat projection을 비교하고 filesystem race 검증만 별도 fixture에서 수행한다.
- root와 frontend dependency-ready producer는 lock digest+Bun+platform+installed graph/executable digest를 artifact로 만들고 모든 consumer가 exact match를 확인한다. binary existence만 readiness로 쓰지 않는다.

## red-on-injection

- static receipt에서 입력 파일 하나를 바꾸면 consumer RED.
- catalog sub-verdict 하나를 삭제하거나 다른 HEAD receipt를 넣으면 aggregator RED.
- shared scan manifest에서 tracked path 하나를 빼면 해당 population guard가 정확한 path로 RED.
- compiled artifact에서 embedded asset 하나를 제거하면 해당 sub-verdict만 RED이고 build producer는 한 번만 실행된다.
- dependency artifact의 lockfile/runtime/platform 중 하나가 다르면 worker가 test spawn 전에 RED.
- hosted install이 `.git/config`를 변경하거나 local hook setup이 누락되면 서로 다른 targeted rail이 RED다.
- 10k ignored scratch files를 주입해도 cleanup의 visited count가 증가하지 않고 stale tracked-root `.js` 하나는 정확히 제거된다.
- inventory adapter의 filesystem enumeration counter는 한 snapshot당 1이며 suite union/disjoint/floor 결과는 기존 값과 같다.
- lock A install 후 lock B checkout/no-install fixture가 spawn 전 stale-deps로 RED이고 local/CI web command의 dependency semantics가 같다.

## 완료 기준

- [ ] PR당 full-tree Biome/catalog producer 실행은 각각 1회다.
- [ ] tracked tree enumeration은 campaign당 O(1)이고 guard별 중복 walk가 없다.
- [ ] ordinary full의 `bun build --compile`은 공유 producer 1회 이하이다.
- [ ] normal membership suite를 nested `bun test`로 다시 실행하는 경로가 0이다.
- [ ] hosted setup/install 횟수와 시간이 artifact에 기록되고 chunk 수에 선형 증가하지 않는다.
- [ ] Linux non-vacuity가 guard 수만큼 전체 tree를 물리 복사하지 않는다.
- [ ] cwd-parity root arm과 source cleanup은 current campaign에서 중복 구매되지 않는다.
- [ ] CI/nightly dependency install은 repository Git config를 변경하지 않는다.
- [ ] cleanup과 discovery가 ignored ambient corpus 및 겹치는 suite 수에 선형 증폭되지 않는다.
- [ ] root/frontend dependency install은 lock-correlated receipt 하나를 소비하고 executable-exists shortcut이 없다.

## 진행 (2026-09-12)

- **LANDED `52044ab1f`** — 확정 결함 12(`discoverInventory`의 4회 중복 walk) 해소.
  suite membership은 root로 정의되므로 한 snapshot에서 projection한다.
  ABBA(HEAD 구현 대비, 12 샘플 interleave, loaded host, median): **124ms → 45ms**,
  filesystem enumeration **4 → 1**(타이머가 아니라 카운터로 단언). 8개 population 전부 digest 동일.
  root 매칭은 subtree exact(`tests/unit`이 `tests/unit-helpers/**`를 삼키지 않음).
- 남은 항목: static/catalog/repo-scan/compiled-probe producer receipt, non-vacuity mirror,
  cwd-parity root arm 재사용, `test:clean-js`의 ignored scratch walk, dependency-ready receipt.
