# TVH-02 — tier·명령·membership 계약 정상화

- 우선순위: P0/P1
- 상태: LANDED — exact gate 계약, smoke 단일 authority, tier 4종 분리(digest 상이). 의도된 보류: prepush 축소는 selector 배선 전까지 interlock으로 고정
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
- 정정: 위 항목은 원인을 **suite floor 3,600**으로 적었지만, 실제로 지금 막고 있는 것은 **tier floor 3,900**이다. `test-tier-population.json`의 floor는 네 tier 모두 3,900이고 reason이 전부 universe 기준("universe minus …")으로 쓰여 있는데, 이 floor가 suite로 좁혀진 selection에 그대로 적용된다. 그래서 shard runner 엔트리포인트 4개 중 3개가 **항상 실행 불가**다 (current-HEAD 실측):

  | script | suite | selected | tier floor |
  |---|---|---|---|
  | `bun run test:unit` | core | 3589 | 3900 |
  | `bun run test:unit:ci` | unit | 3264 | 3900 |
  | `bun run test:integration` | integration | 394 | 3900 |
  | `bun run test` | full | 3983 | 3900 (통과) |

  (위 수치는 재측정본이다. 처음 적은 3583/3258/3948은 10커밋 만에 이미 낡았다 —
  corpus가 자라기 때문이다. 그래서 arm은 이 숫자를 고정하지 않고 "각 suite가
  universe tier floor 아래이면서 자기 suite floor 이상"이라는 성질만 고정한다.
  숫자를 박아두면 다음 사람이 성질을 확인하는 대신 숫자를 고치게 된다.)

  `test:full:ci`는 `--tier`가 없지만 깨지지 않았다: hosted CI는 `QUANTA_VERIFICATION_TIER: pr`을 세우고 로컬 `prepush`는 `gate.ts:323`이 label을 tier로 세운다. 게이트/워크플로 참조가 있는 엔트리포인트는 이 하나뿐이라 위 3개는 게이트 파손이 아니라 **문서화된 명령의 영구 실패**다.
  진단은 고쳤다(`suite-narrower-than-tier-floor`): 좁은 suite는 이제 corpus loss로 오보고되지 않는다. 거부 자체는 유지한다 — universe floor를 낮춰 통과시키는 것이 이 레코드가 막으려는 papering이다. suite/tier 쌍별 floor를 commit하는 것이 이 티켓의 잔여 작업이다.
- `--parallel=1`은 parser가 조용히 무시한다.
- `targetChunkCount`는 검증만 하고 실제 membership에는 사용하지 않는다.
- `verify:scope`는 dry-run이며 gate/workflow가 결과를 소비하지 않는다.
- canonical `test:contract`는 source-JS cleanup 뒤 `bun test tests/contract --parallel=1`인데 gate manifest와 hosted CI는 `bun test tests/contract`를 직접 호출한다. cleanup과 직렬 실행 의미가 authority마다 다르다.
- `test:resilient`는 managed shard runner/tier/resource policy/cache/receipt를 모두 우회해 `bun test tests/unit tests/integration`를 직접 실행한다. 진단용 명령이 또 하나의 broad-suite execution authority가 됐다.
- workflow parity normalizer는 `bun fc check-changed <anything>`을 전부 local admission으로 collapse하고 exemption은 기본 substring match다. `bun fc check-changed origin/main && bun run probe`와 `bun install --frozen-lockfile && bun run probe` 같은 compound command의 새 실행을 숨길 수 있다.
- local `test:admission`은 implicit `origin/main`, PR CI는 actual base ref를 명시하지만 parity test가 차이를 지운다. non-main-base PR에서는 local prepush와 CI가 다른 commit range를 검사한다.
- 후속(2026-09-14): 위 "진단만 고쳤다"는 불충분했다 — 감사가 그 메시지가 확인하지 않은
  corpus 상태를 주장한다는 것과, 12개 narrow suite × tier 조합 **전부**가 거부된다는 것을
  측정했다. 이제 `test-tier-population.json` v2가 suite별 floor를 가진다. floor는 고른 값이
  아니라 부모 slack의 몫으로 **도출**되고(`minFiles = selected − floor(slack × selected /
  parentSelected)`), 로더가 전부 재계산해 하나라도 다르면 거부한다. `core + integration`
  selected 합이 universe와 같아야 하며, 반올림을 내리므로 두 floor 합은 universe floor 이상이
  수학적으로 보장된다. 16개 조합 전부 `--discover-only`로 통과(`baf5e2e9f`, 2회 측정 동일):

  | suite | prepush | pr | full | nightly |
  |---|---|---|---|---|
  | full (universe) | 3969 / 3900 | 3969 / 3900 | 3979 / 3900 | 3993 / 3900 |
  | core | 3579 / 3517 | 3579 / 3517 | 3589 / 3518 | 3599 / 3516 |
  | unit | 3254 / 3198 | 3254 / 3198 | 3264 / 3200 | 3273 / 3198 |
  | integration | 390 / 384 | 390 / 384 | 390 / 383 | 394 / 385 |

  (selected / floor). `--discover-only`도 이제 같은 floor를 적용하고, 캠페인은 lease·
  capability probe 전에 선택한다.
- 2차 적대 감사 대응(2026-09-14, v3): 위 문단의 "측정값을 낮추면 partition identity가
  깨진다"는 `core`·`integration`에만 참이었다. `unit.*.selected = 1`에 floor를 재도출하면
  로드됐고, `universeSelected`와 `integration`을 같이 낮춰도 로드됐다. 그리고 floor slack
  때문에 `tools/`·`tests/meta`·`tests/adversarial`·`tests/measurement` 전부와 `src/` 42개가
  사라져도 16조합이 green이었다. 또 `selected === discovered`일 때만 corpus loss로 봐서
  prepush/pr/full의 실제 파일 삭제가 "SELECTION shrink … lower the floor"로 보고됐다. 조치:
  - discovery 완전성을 **threshold 0**으로 먼저 검사한다: git index가 추적하는 suite root 아래
    `*.test.ts`는 전부 discovered여야 하고, 모든 root가 최소 1개를 내야 한다(`discoveryCompletenessProblems`).
  - 레코드 v3가 suite별 measured `discovered`를 가진다. floor 미달은 측정 대비 corpus가 줄었으면
    corpus loss, 아니면 exclusion 증가(narrowed)로 판정하고, 조치 문구는 "floor를 낮춰라"가 아니라
    `--measure` 재측정이다.
  - 레코드는 `bun run tools/dev/test-tier-population.ts --measure`가 커밋 트리·그 커밋의 override
    파일로 재계산해 쓰고, arm이 `measuredAt` 재계산과 **완전 일치**를 요구한다. 손으로 일관되게
    낮춘 레코드는 로더는 통과하지만 이 arm이 거부한다.
  - 캠페인의 git snapshot을 선택 **전에** 찍는다(후에 찍으면 선택 중 착륙한 커밋이 양쪽 snapshot에
    다 들어가 비교를 통과했다).

  v3 측정(`34b1d74fc`; discovered full 3995 · core 3601 · unit 3275 · integration 394):

  | suite | prepush | pr | full | nightly |
  |---|---|---|---|---|
  | full (universe) | 3971 / 3900 | 3971 / 3900 | 3981 / 3900 | 3995 / 3900 |
  | core | 3581 / 3517 | 3581 / 3517 | 3591 / 3518 | 3601 / 3516 |
  | unit | 3256 / 3198 | 3256 / 3198 | 3266 / 3200 | 3275 / 3198 |
  | integration | 390 / 384 | 390 / 384 | 390 / 383 | 394 / 385 |

  남은 한계: universe floor 3900 자체는 고른 값이다(c7e91b306 당시 3925). 파생 floor의 slack은
  corpus가 자랄수록 커지므로, 재측정 없이 오래 두면 floor가 느슨해진다. 완전성 검사가 slack에
  의존하지 않는 이유다.

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

## 진행 (2026-09-12)

### LANDED

- **`151040786` — gate ownership floor drift (P0).** current HEAD에서 `bun run precommit` /
  `prepush` / 모든 `gate.ts <tier>`가 gate 1개도 실행하지 못하고 exit 1 하던 상태를 확인·수정.
  원인은 `a6703e00d`의 `fc-validate`/`fc-diff`/`fc-lint` → `fc-ci` 통합 후 `MIN_OWNED.precommit=10`이
  그대로 남은 것. 숫자 floor를 exact `(id, stage)` 계약 `GATE_CONTRACT`로 교체하고, 순수 validator를
  `--list` 분기 **앞**에서 실행해 list/run 경로가 같은 검증을 통과하게 했다.
  위반 종류: missing / unexpected / mis-staged / duplicate / dangling-consumes / consumes-cycle /
  empty-stage / empty-contract(anti-vacuum). 전부 offending ID를 이름으로 지목한다.
  검증: `gate.ts precommit`이 typecheck(17.5s) 통과 후 lint 진입. lint-debt gate 삭제 주입 시
  `--list`와 run 양쪽 RED.

- **`831d032b2` — suite floor와 tier 선택 floor 분리 + `--parallel=1` no-op 제거.**
  - floor가 tier 선택 **뒤**에 적용돼 "corpus 유실"과 "의도적 tier 축소"가 같은 메시지였다.
    suite floor는 pre-selection universe로, tier population floor는 committed
    `tools/dev/test-tier-population.json`으로 분리(미등록 tier는 default가 아니라 fail closed).
  - `--parallel=1`은 실제 `bun test` 플래그인데 shard runner가 `continue`로 삼켰다. 5개 스크립트가
    직렬-isolate로 읽히면서 runner는 pure chunk를 최대 8-wide로 돌렸다. runner가 거부하도록 바꾸고
    해당 스크립트에서 제거.
  - `test-ci-admission-script-hellgate`가 이 오해를 고정하고 있어 executor별로 분리(direct `bun test`는
    플래그 유지, shard runner는 금지), 양방향 anti-vacuity 추가.
  - 회귀 복구: `151040786`이 `gate-receipt.test.ts`를 18/18 RED로 만든 것(fixture의 `makeRepo`가
    `gate-manifest-contract.ts` 미복사) 수정. fixture 자체 self-scan이 잡았는데 그 파일을 안 돌리고 착륙시킨 것.

- **`fbb536f62` — contract argv drift 해소.** ci.yml `bun test tests/contract` vs package
  `test:contract`(clean-js + `--parallel=1`)를 canonical 하나로 통일. 부수로 parity guard 2개 구조 결함 수정:
  `conditionalStepBody`의 ±8줄 윈도우 → 실제 YAML step 경계, `run:` step이 name을 싣지 않아
  step-scoped exemption이 구조적으로 불가능했던 것(=wildcard substring 구멍의 원인) 해소.

### 현재 tier membership (current HEAD 측정, `--discover-only`)

prepush / pr / full이 동일 집합·동일 digest, nightly만 +6. tier 분리 자체는 TVH-03 lane과 함께 진행 중.

### 남은 항목

- tier별 실제 membership 분리(TVH-03 capability manifest와 결합).
- `verify:smoke` vs `gate.ts smoke` authority 통합.
- `test:resilient` broad run 제거(TVH-15와 결합).
- `targetChunkCount` dead parameter.
- base SHA freeze(local/CI 동일 commit range).
- exemption wildcard substring → exact 전환 잔여분.
