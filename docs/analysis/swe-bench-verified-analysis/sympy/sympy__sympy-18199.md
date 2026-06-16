---
instance_id: sympy__sympy-18199
repo: sympy/sympy
base_commit: ba80d1e493f21431b4bf729b3e0452cd47eb9566
version: "1.6"
difficulty: 1-4 hours
created_at: 2020-01-01T19:08:59Z
fail_to_pass: 1
pass_to_pass: 113
gold_files: [sympy/ntheory/residue_ntheory.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [overfit-risk, regression-trap, has-repro]
---

## 문제 요약

`nthroot_mod(a, n, p)`는 `x**n = a (mod p)` 의 해를 구하는데, `a % p == 0`인 경우 `x = 0 (mod p)`도 해이지만 이를 누락한다. 이슈는 `nthroot_mod(17*17, 5, 17)`가 `0 mod 17`을 빠뜨리는 구체적 재현 예를 제시한다. 추가로 골드패치는 합성수 `p`(비소수 모듈러스)에서 `NotImplementedError`를 던지던 제약까지 함께 해소한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 함수명 `nthroot_mod`를 직접 지목한다. `grep nthroot_mod` 한 방으로 `sympy/ntheory/residue_ntheory.py`에 수렴. 탐색 비용 사실상 0.
- **S2 Constraint-Reasoning (+S6 Design-Refactor)**: 핵심 누락(`a % p == 0 → 0`)은 한 줄 가드지만, 골드패치는 합성수 케이스를 새 헬퍼 `_nthroot_mod_composite`로 합성한다. CRT 분해 + 소수거듭제곱(prime power)별 Hensel 리프팅/브루트 리프트라는 정수론 불변식을 추론으로 구성해야 하므로 단순 템플릿(S1)이 아니다. 새 함수 도입이라 S6 보조.
- **K-Domain**: number theory 도메인 지식(factorint, crt, Hensel lifting, nth-power residue, mod_inverse)이 병목. 일반 파이썬 추론(K-Gen)으로는 리프팅 식을 못 만든다.
- **primary = T-ConstraintReason**: 위치는 자명(L0)하나 올바른 식·조건(`diff = (rootn // (root or 1) * n) % p`로 도함수 가역성 판정 후 분기)을 의미론적으로 합성해야 함이 본질. T-DirectMap이 아닌 이유는 픽스의 무게중심이 `if a%p==0` 가드가 아니라 합성수 솔버 합성에 있기 때문.

APR 관점: 이슈가 명세한 zero-root만 고치면 S1이지만, 테스트가 합성수 모듈러스 해 집합 전체를 요구하므로 SemFix/Angelix류의 제약기반 합성이 강제된다.

## 난이도 티어

**T4 (약간 어려움)**.
- 파일수 1 / 함수 영향: `nthroot_mod` 분기 재배치 + 신규 `_nthroot_mod_composite`(~40줄). 단일파일이라 멀티사이트 조율(L3)은 아님.
- localize 직접성: 매우 높음(L0, has-repro). 이 축만 보면 T1~T2.
- 그러나 **repair 난이도가 티어를 끌어올림**: CRT + prime-power 리프팅을 도메인 지식으로 합성해야 하고(S2+K-Domain), 정상해뿐 아니라 `[0]`, 빈해 `[]`, 다중해(`[3,9,15,21,27,33]`) 등 엣지케이스 전수 처리가 필요.
- **regression-trap**: PASS_TO_PASS 113개(solveset 전반). `solve_modular`가 이 경로를 호출하므로 ConditionSet→ImageSet로 동작이 바뀌는데 인접 modular-solve 동작을 깨면 안 됨.
- **overfit-risk**: zero-root 가드만 넣고 합성수 분기를 빼면 일부는 통과하나 합성수 테스트에서 실패. 반대로 합성수 솔버를 부정확히 짜면 special-case 통과 가능.
- 공식 라벨 `1-4 hours`와 일치: 한 줄 버그가 아니라 정수론 알고리즘 한 덩어리를 작성하는 작업량.

## 골드패치 분석

- **파일**: `sympy/ntheory/residue_ntheory.py` 단일.
- **신규 함수** `_nthroot_mod_composite(a, n, m)`: `factorint(m)`로 소인수분해 → 각 `p**e`별로 해집합 계산. `e==1`이면 `nthroot_mod(a, n, p, True)`. `e>1`이면 `diff = (rootn // (root or 1) * n) % p`로 도함수가 가역이면 Hensel 리프팅(`root - (rootn - a)*mod_inverse(diff, p)`), 비가역이면 `new_base` 브루트포스 리프트. 마지막에 `crt(m, ...)` + `cartes(*a)`로 소수거듭제곱별 해를 중국인의 나머지 정리로 결합.
- **`nthroot_mod` 본체 수정**: 분기 순서를 (1) `if not isprime(p): return _nthroot_mod_composite(...)` (2) `if a % p == 0: return [0]` 로 재배치. 기존의 `raise NotImplementedError("Not implemented for composite p")`를 삭제.
- **근본원인**: 두 결함. (a) zero-root 누락 — `is_nthpow_residue`는 `a % p == 0`을 거부하지 않는다(base 본문 `if a == 0: return True`이므로 True 반환 → `None` 단락이 일어나지 않음). 실제 누락 지점은 그 뒤의 gcd/이산로그 경로로, 이 경로는 곱셈군(0 제외) 위에서 동작해 구조적으로 `0`을 해로 산출할 수 없다. 골드패치가 `if a % p == 0: return [0]`를 `is_nthpow_residue` 가드보다 앞에 배치한 이유는 가드가 0을 막아서가 아니라 이후 경로가 0을 못 내기 때문. (b) 합성수 모듈러스 미지원. 골드는 둘을 한 패치로 닫음.
- **import 추가**: `from sympy.utilities.iterables import cartes`.

## 검증 (test_patch)

- **FAIL_TO_PASS = [`test_solve_modular`]** (1개). `solveset(Mod(x**3, 8) - 1, x, S.Integers)`가 기존 `ConditionSet(...)`에서 `ImageSet(Lambda(n, 8*n + 1), ...)`로, `Mod(x**4,9)-4`는 두 ImageSet의 `Union`으로 바뀜을 검증. 합성수 모듈러스 해가 실제로 도출됨을 증명.
- test_residue 측(채점 집합 밖 — PASS_TO_PASS·FAIL_TO_PASS 어디에도 없음. test_patch가 수정하지만 SWE-bench 채점은 안 됨): `raises(NotImplementedError, ...)` 3건을 실제 해 단언으로 교체 — `nthroot_mod(29,31,74)==[45]`, `nthroot_mod(16,5,36,True)==[4,22]`, `nthroot_mod(9,16,36,True)==[3,9,15,21,27,33]`, 빈해 `nthroot_mod(4,3,3249000)==[]`, zero-root `nthroot_mod(0,12,37,True)==[0]`, `nthroot_mod(0,7,100,True)==[0,10,...,90]`.
- **overfit 관점**: zero-root와 빈해와 다중해를 동시에 단언하므로 special-case 가드만으로는 못 통과 — 테스트가 일반화를 강제. 단 FAIL_TO_PASS가 1개뿐이고 합성수 검증 상당수가 test_residue(별 파일)라 `overfit-risk` 표기 유지.
- **regression 관점**: 소수 모듈러스 경로(`(p-1)%n==0 → _nthroot_mod1` 등)는 미변경. `a%p==0` 가드를 `isprime` 분기 뒤에 둬서 합성수 경로가 가드를 우회하지 않게 순서를 잡음.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `nthroot_mod`를 명시 → `residue_ntheory.py`로 직행. `raise NotImplementedError("Not implemented for composite p")`와 `is_nthpow_residue` 가드가 zero/합성수를 막는 두 지점임을 본체에서 확인.
2. **픽스와 일반화 정당성**: (a) `if a % p == 0: return [0]` — `x≡0`이면 `x**n≡0≡a`이므로 보편 참, 이슈 재현(`17*17,5,17`)을 닫음. (b) 합성수는 `NotImplementedError`를 던지는 대신 `m = ∏ p_i**e_i`로 분해해 각 소수거듭제곱에서 풀고 CRT로 결합 — 이는 `x**n≡a (mod m)` 해 구조의 정확한 일반화(특정 입력 맞춤이 아님). prime-power는 도함수 가역 여부로 Hensel vs 브루트 리프트 분기.
3. **regression 안전**: 소수 경로(`_nthroot_mod1`, 이산로그 분기)와 `sqrt_mod(n==2)` 위임은 손대지 말 것. solveset 113개 P2P, 특히 `test_invert_modular`/`test_is_modular`가 안 깨지도록 반환형(스칼라 vs `all_roots` 리스트)을 보존해야 함.
4. **함정 회피**: ① zero-root 한 줄만 넣고 합성수 분기를 빼면 test_residue·test_solve_modular 합성수 케이스에서 실패(과소수정). ② `a%p==0` 가드를 `isprime` 검사보다 앞에 두면 합성수 입력이 잘못된 `[0]`로 단락됨 — 순서가 정확성에 필수. ③ 빈해(`nthroot_mod(4,3,3249000)==[]`)와 다중해 정렬·중복제거(`sorted(set(...))`)를 빠뜨리면 출력 불일치. ④ `cartes` import 누락 시 ImportError.
