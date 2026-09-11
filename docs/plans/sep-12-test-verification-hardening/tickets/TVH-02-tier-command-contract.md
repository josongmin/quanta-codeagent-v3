# TVH-02 — tier·명령·membership 계약 정상화

- 우선순위: P0/P1
- 상태: OPEN
- 소유 lane: verification policy / command integration
- 선행: TVH-01
- 후속: TVH-03, TVH-08, TVH-09

## 현재 결함

- prepush/PR/full은 각 3,928파일과 19개 gate로 동일하다.
- `GATES`의 precommit 소유 수는 8개인데 `gate.ts`의 `MIN_OWNED.precommit`은 10이다. `--list`는 이 검증 전에 return하므로 정상 목록처럼 보이지만 실제 precommit/prepush/PR/full/nightly 실행 경로는 첫 gate 전에 exit 1 하도록 구현되어 있다. 이는 정적 current-HEAD 증거이며 실제 gate campaign은 실행하지 않았다.
- `test`, `test:integration`, `test:full:ci`, `test:watch` 등 tier 미지정 명령이 nightly 파일도 포함한다.
- `test:unit`은 `suite=core`를 실행한다.
- `verify:smoke`는 2개 focused test이고 `gate.ts smoke`는 7개 static gate다.
- runner의 suite floor 3,600이 tier 선택 뒤 적용되어 향후 PR을 3,600 미만으로 줄이면 의도적 축소도 실패한다.
- `--parallel=1`은 parser가 조용히 무시한다.
- `targetChunkCount`는 검증만 하고 실제 membership에는 사용하지 않는다.
- `verify:scope`는 dry-run이며 gate/workflow가 결과를 소비하지 않는다.
- canonical `test:contract`는 source-JS cleanup 뒤 `bun test tests/contract --parallel=1`인데 gate manifest와 hosted CI는 `bun test tests/contract`를 직접 호출한다. cleanup과 직렬 실행 의미가 authority마다 다르다.
- `test:resilient`는 managed shard runner/tier/resource policy/cache/receipt를 모두 우회해 `bun test tests/unit tests/integration`를 직접 실행한다. 진단용 명령이 또 하나의 broad-suite execution authority가 됐다.
- workflow parity normalizer는 `bun fc check-changed <anything>`을 전부 local admission으로 collapse하고 exemption은 기본 substring match다. `bun fc check-changed origin/main && bun run probe`와 `bun install --frozen-lockfile && bun run probe` 같은 compound command의 새 실행을 숨길 수 있다.
- local `test:admission`은 implicit `origin/main`, PR CI는 actual base ref를 명시하지만 parity test가 차이를 지운다. non-main-base PR에서는 local prepush와 CI가 다른 commit range를 검사한다.

## 목표 계약

| tier | 내용 | 금지 |
|---|---|---|
| smoke | static 핵심 + deterministic critical canary | full discovery, external toolchain |
| prepush | changed/affected + always-run canary + 빠른 static | upstream clone/build, live model, full PTY |
| PR | merge blocking deterministic population | paid/live/local-only capability |
| full | deterministic 전체, nightly exhaustive 제외 여부를 이름에 명시 | 환경 skip을 PASS로 집계 |
| nightly | deterministic exhaustive + capability job fan-out | 단일 job에 모든 외부 도구 혼합 |

## 파일·로직별 작업

| 파일 | 대상 | 변경 |
|---|---|---|
| `tools/dev/test-policy.ts` | default tiers, `cost`, `resources`, `requiredCapabilities` | known test를 전 tier에 자동 등록하는 기본값을 제거한다. exact override/manifest가 tier membership의 단일 authority가 되게 한다. |
| `tools/dev/test-policy-overrides.json` | 현재 empty registry | PR canary/full/nightly 정책을 owner/reason/expiry와 함께 등록한다. pattern-wide 자동 승격은 금지한다. |
| `tools/dev/run-test-shards.ts` | discovery→tier selection→floor | suite discovery floor는 선택 전에 검사한다. 선택 후에는 tier별 committed floor/digest와 selected+excluded accounting을 검사한다. |
| `tools/dev/test-shard-discovery.ts` | `SUITE_FLOORS`, roots | suite universe와 tier population floor를 분리한다. `unit`, `core`, `integration`, `full` 이름을 실제 roots와 맞춘다. |
| `tools/dev/verification-selection.ts`, `verify-scope.ts` | selection plan | dry-run 결과를 signed plan/receipt 형태로 만들되 초기에는 shadow 비교만 한다. fallback-full reason을 exact하게 남긴다. |
| `package.json` | 모든 test/verify scripts | tier를 명시한다. `test:unit`을 실제 unit으로 고치거나 `test:core`로 rename한다. `test:full:ci`는 direct 실행에서도 의미가 변하지 않게 한다. |
| `tools/dev/gate-manifest.ts`, `gate.ts` | tier별 gate membership | prepush/PR/full/nightly가 같은 `SUITE_TIERS`를 공유하지 않게 한다. smoke authority를 하나로 합친다. |
| `tools/dev/gate-manifest.ts`, `gate.ts` | stale `MIN_OWNED` floor와 `--list` 우회 | hard-coded 하한 대신 canonical exact gate ID+stage set 또는 generated manifest contract를 list/run 공통 validator로 사용한다. 삭제·misstage·중복은 정확한 ID로 RED여야 하며 단순 하한 완화로 닫지 않는다. |
| `package.json`, `tools/dev/gate-manifest.ts`, `.github/workflows/ci.yml` | contract argv drift | contract 실행의 canonical command/resource claim을 하나로 만들고 package/gate/workflow가 이를 소비한다. serial/exclusive가 필요하면 scheduler claim으로 명시한다. |
| `package.json`, `tools/test-resilience/cli.ts` | legacy broad `test:resilient` | authoritative initial attempt는 exact shard receipt/failure artifact를 소비하게 한다. 별도 direct broad run은 제거하고 local diagnostic 결과가 required PASS가 될 수 없게 명명·schema를 분리한다. |
| `tests/unit/_arch/gate-manifest-workflow-parity.test.ts`, `tools/dev/gate-manifest.ts` | compound command/exemption parser | shell command를 `&&`, `;`, pipeline, multiline 기준의 실제 segment로 parse해 각 executable segment를 판정한다. exemption은 exact command+workflow+step으로 닫고 wildcard substring을 제거한다. |
| `verification-campaign.ts`, `test:admission`, CI context | base authority | campaign 시작 시 exact base SHA와 head SHA를 freeze해 local/hosted admission에 동일하게 전달한다. default branch 문자열 normalization으로 의미 차이를 숨기지 않는다. |
| `tools/dev/test-shard-options.ts` | ignored `--parallel=1` | 호환 no-op을 제거한다. 지원하지 않으면 reject하고, 필요하면 explicit `--workers`/`--intra-parallel`을 별도 설계한다. |
| `tools/dev/test-shard-plan.ts`, `test-shard-membership.ts` | `targetChunkCount` | dead parameter를 제거하거나 versioned bucket config의 실제 입력으로 만든다. |

## 회귀 rail

- prepush, PR, full, nightly의 membership digest가 모두 의도대로 다르고 union/accounting이 정확하다.
- nightly-only file을 ordinary 명령에 injection하면 ordinary membership에서 제외된다.
- PR membership을 3,600 미만으로 만든 synthetic fixture가 suite floor 때문에 실패하지 않는다.
- suite root에서 파일을 삭제하면 pre-selection universe floor가 RED다.
- `gate.ts smoke`와 `verify:smoke`가 동일 manifest를 소비한다.
- list와 execution이 동일 manifest validator를 통과하며 gate 하나 삭제·misstage 주입은 해당 ID로 RED다.
- package/gate/workflow의 contract exact argv와 cleanup/resource semantics가 같다.
- 모든 broad-suite 명령이 tier/resource/lifecycle/receipt authority를 통과하며 diagnostic retry가 별도 full run을 시작하지 않는다.
- exempt step에 새 compound command를 붙이면 정확한 segment가 missing gate로 RED다.
- release branch를 base로 한 synthetic PR에서 local/CI changed set과 base/head digest가 같다.
- 무시되는 CLI option이 없다.

## 완료 기준

- [ ] tier 이름마다 실행 파일·gate·성공 의미가 다르다.
- [ ] normal test command가 nightly-only 파일을 우발적으로 실행하지 않는다.
- [ ] selective plan이 shadow receipt를 생산한다.
- [ ] 선택 축소와 corpus 유실이 서로 다른 오류로 보고된다.
- [ ] 현재 manifest가 첫 gate 전 ownership validation을 통과하고 list가 검증을 우회하지 않는다.
