# TVH-03 — real toolchain·capability lane 분리

- 우선순위: P0
- 상태: LANDED (browser/bwrap/docker 그룹은 lane gate 대기)
- 소유 lane: toolchain fixtures / hosted capability CI
- 선행: TVH-01, TVH-02
- 후속: TVH-06, TVH-09

## 현재 결함

- prepush가 17개 `*-real-e2e.test.ts`를 직렬 실행한다.
- 같은 17개 파일이 ordinary full membership에도 남아 env-gated module load/skip을 먼저 구매한 뒤 별도 real-toolchain gate에서 다시 load/execute된다. capability lane 분리는 command만 추가했고 물리 membership을 분리하지 않았다.
- `project-env-astropy-real-e2e`는 실제 upstream clone/build를 하며 command budget이 600초다.
- Jest/Mocha real tests가 module load에서 timeout 없는 unpinned `npm i jest/mocha`를 실행한다.
- Ollama 부재는 “not a pass”라고 출력하면서 `expect(true).toBe(true)`로 PASS 처리한다. 존재하면 최대 150초 inference를 기다린다.
- `evidence-node-failure-static-real-e2e`는 lane env gate가 없어 ordinary full과 real-toolchain lane에서 중복 실행된다.
- Chrome, bwrap, limactl과 Docker daemon/image/Lima VM 상태가 toolchain fingerprint에 없다.
- hosted toolchain job도 unavailable arms를 visible skip으로 두므로 전체 capability coverage가 green 한 줄에 묻힌다.
- ordinary integration의 `browser-agent-loop-e2e`와 `browser-real-chrome-e2e`가 env gate 없이 module load에서 실제 Chrome/CDP를 spawn한다. 후자는 같은 파일의 `beforeAll`에서 다시 spawn한다.
- `debugpy-real-e2e`는 real-toolchain env가 꺼져도 module load에서 timeout 없는 `xcrun`/`lldb-dap` probe를 수행한다.
- contract discovery의 Lance Python 후보는 최대 4개를 각 5초씩 직렬 probe하고 TypeScript/Pyright도 파일별 5초 probe를 다시 수행한다.
- nightly는 required contract job과 달리 Python/Lance/LSP provision 및 `REQUIRE_CONTRACT=1`이 없다. 같은 contract gate가 dependency 부재를 skip하고 nightly 전체를 green으로 만들 수 있다.
- required PTY job도 8개 파일 전체가 `PTY_AVAILABLE=false`이면 visible skip 뒤 job success가 가능하며 executed file/case floor가 없다.
- ordinary full의 `sphinx-ra-shim`, ast-grep 두 파일, project-env snapshot wiring, cha-multisite가 module load에서 Python/ast-grep/Git probe를 timeout 없이 실행한다. 모두 current classifier상 `pure`라 capability lane 밖에서도 중복·hang 가능하다.

## 파일·job별 작업

| 파일 | 대상 | 변경 |
|---|---|---|
| `tools/dev/gate-manifest.ts` | `real-toolchain-e2e` | ordinary prepush에서 제거한다. deterministic PR-required capability와 nightly-heavy capability를 별도 gate ID로 나눈다. |
| `tools/dev/test-policy-overrides.json`, capability manifest | 17개 real file membership | ordinary PR/full에서 전부 제외하고 정확히 한 capability group에 등록한다. ordinary canary가 필요하면 외부 tool 없는 sibling test로 물리 분리한다. |
| `package.json` | `test:real-toolchain` | `find` suffix 하나로 전부 직렬 실행하지 않는다. manifest 기반 capability group과 runner를 사용한다. |
| `tests/unit/project-env-astropy-real-e2e.test.ts` | Astropy clone/build | nightly `python-native-build` job으로 이동한다. upstream SHA, Python/uv/compiler ABI, dependency lock을 receipt에 기록한다. |
| `tests/unit/tool/evidence/runtime-jest-real-e2e.test.ts` | `installJestProject` | 실행 중 install을 제거한다. pinned version/lockfile fixture 또는 사전 구축 image를 사용하고 install 자체는 setup job에서 bounded 실행한다. |
| `tests/unit/tool/evidence/runtime-mocha-real-e2e.test.ts` | `installMochaProject` | Jest와 동일한 정책을 적용한다. |
| `tests/unit/llm/local-preset-live-real-e2e.test.ts` | Ollama probe | `expect(true)` self-pass를 제거한다. local model은 opt-in live lane으로 분리하고 unavailable은 typed capability result로 기록한다. |
| `tests/unit/evidence-node-failure-static-real-e2e.test.ts` | lane gating/cleanup | ordinary full 또는 capability lane 중 한 곳에만 등록한다. explicit capability manifest와 temp cleanup을 추가한다. |
| `tests/integration/browser-agent-loop-e2e.test.ts` | module-load Chrome/CDP | 주석뿐인 env gate를 실제 manifest/capability gate로 만들고 module load spawn을 제거한다. |
| `tests/integration/browser-real-chrome-e2e.test.ts` | probe + suite 이중 spawn | capability producer의 bounded 결과를 소비하고 suite fixture는 한 번만 spawn한다. |
| `tests/unit/tool/debug/debugpy-real-e2e.test.ts` | LLDB/clang/cargo probes | env/capability 확인 전 외부 명령을 금지하고 bounded setup lane으로 옮긴다. |
| `sphinx-ra-shim`, `ast-grep-*`, `project-env-snapshot-wiring`, `cha-multisite` tests | top-level external probes | ordinary import에서 spawn을 제거하고 shared capability receipt를 소비한다. unavailable self-pass 대신 typed result를 사용한다. |
| `tests/contract/lance-real-wire.test.ts`, `lsp-typescript.test.ts`, `lsp-pyright.test.ts` | 직렬 module probe | job-level capability receipt를 소비하고 테스트 파일별 probe를 제거한다. |
| `tools/dev/external-toolchain.ts` | `EXTERNAL_TOOLS` | Chrome 후보 경로, bwrap, limactl 및 필요한 daemon-state probe를 registry에 포함한다. binary inode만으로 live capability를 대표하지 않는다. |
| `tests/unit/dev/external-toolchain-coverage.test.ts` | suffix-only scan | 모든 실제 `Bun.which`/skip predicate/capability adapter를 source-aware하게 inventory한다. `*-real-exec-e2e`, contract, browser 파일도 포함한다. |
| `.github/workflows/ci.yml` | `toolchain` | required deterministic group은 provision+minimum executed floor를 적용한다. unsupported는 job matrix에서 명시적으로 not-selected 처리한다. |
| `.github/workflows/verification-nightly.yml` | capability matrix | Astropy/native-build, browser, Docker/Lima, LSP/debugger, local-model을 독립 job으로 fan-out한다. |
| `.github/workflows/ci.yml`, `tests/e2e-pty/pty-harness.ts` | PTY capability | preflight 결과와 expected file/case floor를 required receipt에 넣는다. unsupported platform만 policy-explicit `not-selected`를 허용하고 Ubuntu capability loss는 blocked다. |

## 검증

- ordinary prepush plan에 network install, upstream clone/build, Ollama inference가 0개다.
- required capability 누락은 PASS가 아니다.
- capability install/remove/daemon-state 변경 후 기존 receipt는 재사용되지 않는다.
- 각 group에 minimum executed file/case floor가 있다.
- external dependency는 version과 lock/ABI가 고정된다.
- Chrome/Python/LSP/debugger probe 횟수는 capability group당 1회이고 ordinary file import 횟수와 무관하다.
- 17개 real file은 ordinary membership과 capability membership의 교집합이 0이고 capability union에는 정확히 한 번씩 존재한다.
- lancedb/pyright/Docker 또는 PTY capability를 제거한 required/nightly fixture가 `blocked-missing`이며 aggregate PASS가 아니다.

## 완료 기준

- [ ] prepush 비용이 개발자 머신의 설치 도구 수에 따라 폭증하지 않는다.
- [ ] real-toolchain 결과가 executed/skipped/blocked/setup-failed를 구분한다.
- [ ] unpinned runtime install이 테스트 body/module load에 없다.
- [ ] heavyweight capability는 독립 timeout과 artifact를 가진다.

## 진행 (2026-09-12)

- **LANDED `e818b72fc`** — tier 이름 3개가 한 population이던 상태를 해소.

      before  prepush 3941  pr 3941  full 3941  (동일 digest)  nightly 3947
      after   prepush 3925  pr 3925  full 3935           nightly 3948

  `pr` = universe − 6 nightly-exhaustive − 17 lane-gated capability.
  `full` = universe − 6 nightly-exhaustive − 7 nightly-heavy capability.
  `nightly` = universe와 set-equal, **digest가 before와 동일** = 커버리지 보존 증명(어떤 파일도 모든 tier에서 빠지지 않음).
  tier별 `selected + excluded = universe`가 맞고 제외마다 reason class가 붙는다.

- **통합 중 발견한 위험(막음)**: `gate.ts`가 모든 gate에 `QUANTA_VERIFICATION_TIER`를 넘기고 shard runner가
  이를 읽으므로 **tier membership = 실제 실행 집합**이다. prepush를 canary-only로 좁히면
  `QUANTA_VERIFICATION_TIER=prepush ... --discover-only` → **selected 8** (기존 3,941).
  affected/changed selector(`verification-selection.ts`)가 아직 아무 gate도 소비하지 않으므로
  이건 tier 축소가 아니라 커버리지 붕괴다. prepush는 PR population 유지하고
  `PREPUSH_NARROWED_TO_CANARY` 플래그 + interlock 테스트로 고정했다(selector 미배선 상태에서 플립 시 RED).

- capability 결과는 required aggregator가 이미 검증하는 `quanta.capability-result.v1` 그대로 사용(스키마 이중화 없음).
  `expect(true).toBe(true)` self-pass 제거, `QUANTA_REQUIRE_CAPABILITY=<group>`로 부재를 skip이 아닌 fail로.
  jest/mocha module-load `npm i` 제거, astropy clone/build는 nightly native-build 그룹으로.

- red-on-injection 10건 전부 RED 후 byte-identical 복원.

### 남은 항목 (blocker로 명시)

- `test:real-toolchain`이 아직 `find` blob (package.json, 통합 담당).
- astropy `dependencyLockSha256`는 placeholder.
- browser / bwrap / docker-lima 그룹은 `declared-pending-gate`: lane env gate가 없어 membership 미변경.
  gate 없이 옮기면 커버리지가 조용히 빠진다.
