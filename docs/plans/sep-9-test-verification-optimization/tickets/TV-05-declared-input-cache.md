# TV-05 — 입력이 검증된 테스트의 제한적 캐시 범위 축소

- 우선순위: P1
- 상태: FOCUSED_VERIFIED
- 소유자: B
- 선행: TV-02, TV-04
- 협업: TV-03 그래프를 재사용하되 skip authority와 cache authority를 혼합하지 않음

## 문제와 근거

현재 production 파일 하나 변경으로 모든 chunk의 tree digest가 바뀐다. 그러나 import-only cache로 바꾸면 fs/glob/git, fixture, subprocess, preload 등 관찰 입력이 빠질 수 있다. 현재 전역 hash가 제외하는 docs와 다른 test도 scanner에서는 입력일 수 있다.

## 구현 범위

1. 기본은 whole-tree이며 실제 scanner가 읽는 문서·다른 테스트까지 관찰 입력을 포함한다.
2. 첫 대상은 외부 IO 없는 작은 순수 함수 테스트로 제한한다. transitive dependency에 fs/process/spawn/computed import/동적 resolution이 있으면 declared 인증을 거부한다.
3. source closure + test/helper + fixture + config/preload + runner/toolchain/env 계약을 명시적으로 hash한다.
4. 디렉터리 enumeration은 파일 목록 자체도 입력이다. 추가·삭제·rename이 miss를 발생시켜야 한다.
5. API monkeypatch 하나로 모든 IO를 관찰했다고 주장하지 않는다. 정적 검증이 불완전한 코드는 whole-tree로 fallback한다.
6. 무관한 환경 도구 변경까지 모든 pure test에 전파하지 않도록 capability set을 좁히는 것도 인증된 범위에서만 수행한다.
7. scope schema digest, 판정 근거, 인증 불가 이유를 receipt에 남긴다.
8. suite/manifest cross-reuse는 기본 비활성. 별도 관찰 불가능성 증거가 있을 때만 활성화한다.

## 수정 파일

- NEW: `tools/dev/verification-input-scope.ts`, `tests/unit/dev/verification-input-scope.test.ts`
- EXISTING: `tools/dev/test-shard-receipt.ts`, TV-02 policy, TV-03 graph export
- 공유 runner wiring은 통합 담당이 적용

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verification-input-scope.ts` | NEW `InputScope`, `certifyDeclaredInputs`, `hashDeclaredInputs` | `whole-tree`와 `declared-v1`을 tagged union으로 정의한다. certification은 source closure, fixture/config/preload, directory membership, capability/env key를 반환하거나 reason과 함께 whole-tree로 fallback한다. | 각 forbidden edge 주입 시 certification 거부. |
| `tools/dev/verify-scope.ts` | graph exports | literal import/re-export closure를 재사용하되 computed import, unresolved alias, `fs`/glob/git/spawn/process 관찰은 declared 인증 불가로 올린다. | 간접 helper와 dynamic edge mutation. |
| `tools/dev/test-shard-receipt.ts` | `trackedTreeSha256`, `TestShardCacheIdentity` | whole-tree digest와 `testInputSha256`을 구분한다. scope schema/policy/capability digest를 identity에 포함한다. | scope version 또는 directory member 변경 시 miss. |
| `tools/dev/test-policy.ts` | `inputScope` override | 첫 opt-in exact path만 허용하고 pattern-wide pure 승격은 금지한다. | opt-in 밖 파일은 whole-tree 유지. |
| `tests/unit/dev/verification-input-scope.test.ts` | NEW mutation corpus | source/helper/fixture/preload/config/docs/다른 test/toolchain/env/computed import를 하나씩 바꿔 cache lookup까지 검사한다. | 관찰 입력 변화 false-hit 0. |

## 작업 순서

1. 인증 실패가 항상 whole-tree가 되는 API부터 만든다.
2. 5–20개의 작은 pure test만 exact-path opt-in한다.
3. mutation corpus에서 expected hit/miss set을 고정한다.
4. receipt identity와 runner lookup을 연결한다.
5. shadow hit율과 false-hit가 확인되기 전 population 확대를 금지한다.

## 검증 계획

작은 synthetic repo에서 실제 cache lookup까지 연결한다: 직접 source, 간접 helper, fixture, preload, config, docs/ADR, 다른 test file, toolchain, env, computed import의 변경을 주입한다. 기대 miss set을 정확히 검사한다. 무관한 파일 하나 변경은 certified chunk만 hit이고 scanner는 재검증해야 한다.

## 완료 기준

- [ ] 첫 opt-in population과 인증 규칙이 명시됨.
- [ ] 의존 입력 변화에서 누락 miss 0.
- [ ] unknown은 자동 whole-tree fallback.
- [ ] cache-hit 비율과 선택/실행 감소를 같은 SHA 비교로 보고.
- [ ] cache soundness 검증 전 광범위 rollout 없음.

## 실패·복구

잘못된 hit가 하나라도 발견되면 해당 scope 버전을 폐기하고 whole-tree로 복귀한다. cache 전체를 삭제해서 원인을 숨기지 않고 문제 receipt를 비밀정보 없이 보존한다.
