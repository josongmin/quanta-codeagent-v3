---
instance_id: sympy__sympy-24562
repo: sympy/sympy
base_commit: b1cb676cf92dd1a48365b731979833375b188bf2
version: "1.12"
difficulty: "<15 min fix"
created_at: 2023-01-21T12:06:36Z
fail_to_pass: 1
pass_to_pass: 105
gold_files: [sympy/core/numbers.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`Rational('0.5', '100')`이 `1/200`이 아니라 `1/100100`을 반환한다(sympy 1.8에서는 정상이었음). 두 인자가 모두 정수가 아닌 입력(문자열/float)일 때, 분자·분모 정규화 과정에서 분모 누적값이 손상된다. 이슈는 `Rational.__new__`의 정확한 줄 범위(L1628-L1640)와 올바른 로직까지 본문에 적어 제시한다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈 본문이 `sympy/core/numbers.py`의 `Rational.__new__` 줄 범위를 GitHub 퍼머링크로 직접 지목. 후보 탐색 0. grep 한 방.
- **S2 (Repair Strategy)**: 고칠 지점은 자명하나, "왜 틀렸는지"를 분모 누적 불변식으로 추론해야 한다. 핵심 결함은 비정수 `q` 처리 분기에서 `q = q.p`가 **앞선 p-분기에서 `q`에 이미 누적된 분모를 덮어쓴다**는 것. 올바른 픽스는 별도 누적자 `Q`를 도입해 두 분모 기여(`p.q`와 `q.p`/`int(q)`)를 곱셈으로 합성하는 것. 기계적 가드(S1)가 아니라 불변식 추론이라 S2.
- **K-Domain**: `Rational`의 내부 표현(`.p`/`.q` 정수쌍), 비정수 입력을 `Rational`로 재귀 변환해 분자×분자/분모×분모로 합성하는 sympy 수치 도메인 규약을 알아야 한다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 분모 누적 불변식의 정정 합성(S2)이므로 T-ConstraintReason.

APR 관점: 후보를 마구 던져 테스트로 거르는 G&V가 아니라, "분모는 곱으로 누적되어야 하는데 한 분기가 누적자를 destructive-assign한다"는 단일 불변식을 짚으면 픽스가 결정된다. 전형적 SemFix/Angelix식 semantic 수리.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개, 함수 1개, 실질 변경 ~5줄(헌크 2개). scope는 T1~T2급.
- localize 직접성: L0(이슈가 줄 범위·정답 로직까지 제공) → 난이도를 낮춤.
- repro 있음(명확한 입력/출력 대비), 도메인은 sympy 수치 내부.
- 그럼에도 T2가 아니라 T3인 이유: 픽스가 "가드 추가/상수 변경"이 아니라 **누적자 변수 도입 + 4개 분기에 걸친 일관된 재배선**(`q *= p.q`→`Q *= p.q`, `q = q.p`→`Q *= q.p`, `q = int(q)`→`Q *= int(q)`, `q = Q`)이라 destructive-assign vs 누적 곱의 차이를 정확히 추론해야 한다. 한 분기라도 빠뜨리면 다른 입력조합에서 깨진다.
- P2P 103개(test_Rational_new, test_Integer_new 등 numbers 코어 전체)가 회귀 트랩 → regression-trap.

공식 라벨 `<15 min fix`는 이슈가 정답 코드를 통째로 적어줬기 때문의 prior. 정답을 안 보는 에이전트는 "정수 분기는 건드리지 말아야 함" + "p-분기 분모를 q-분기가 덮지 않게" 불변식을 직접 세워야 하므로 T3로 상향.

## 골드패치 분석
- **파일/함수**: `sympy/core/numbers.py` → `Rational.__new__(cls, p, q=None, gcd=None)`.
- **근본원인**: 비정수 분모 처리 분기 `if not isinstance(q, SYMPY_INTS): ... q = q.p` (그리고 else의 `q = int(q)`)가 **이전 비정수 분자 분기에서 `q *= p.q`로 누적된 분모를 파괴적으로 덮어쓴다**. 두 분모 기여를 곱으로 합쳐야 하는데 마지막 대입이 앞 기여를 잃는다. `Rational('0.5','100')`: p='0.5'→`q`에 2 누적되어야 할 분모가, q='100' 분기에서 `q=q.p`로 클로버되어 곱셈 정규화가 어긋나 `1/100100`이 나옴.
- **수정요지**: 분모 전용 누적자 `Q = 1`을 도입. `q *= p.q`→`Q *= p.q`, 비정수 q 분기의 `q = q.p`→`Q *= q.p`, 정수 q 분기의 `q = int(q)`→`Q *= int(q)`로 바꾸고, 마지막에 `q = Q`로 확정. 이로써 두 분모 기여가 곱으로 누적되어 보존된다. 분자 측 `p *= q.q`는 그대로(분자 합성은 원래 올바름).

## 검증 (test_patch)
- **FAIL_TO_PASS** = `test_issue_24543` 1개. 핵심 단언 2개:
  1. `('1.5',1.5,2)` × `('1.5',1.5,2)` 9개 (p,q) 조합에 대해 `Rational(p,q).as_numer_denom() == Rational('%s/%s'%(p,q)).as_numer_denom()` — 즉 두 인자 형태와 단일 "p/q" 문자열 형태가 동치여야 함.
  2. `Rational('0.5','100') == Rational(1, 200)` — 이슈의 직접 재현.
- **픽스 증명**: 9-조합 그리드는 (str,str)/(str,float)/(float,str)/(int,*) 등 **비정수 분기 교차**를 망라해, `Q` 누적이 모든 경로에서 곱으로 동작함을 보인다. 정수/비정수 분모 분기 둘 다 `Q *=`로 통일됐기에 단일 입력으로도 두 분기 모두 커버.
- **overfit 관점**: 테스트가 9개 조합 + 명시 동치(단일문자열 baseline)를 쓰므로 special-case 통과가 어렵다. `q='100'` 한 케이스만 맞추는 hack은 `('1.5','1.5')` 등에서 깨진다 → overfit 저항 양호. flags에 overfit-risk 미부여.
- **regression 관점**: P2P 103개가 `Rational`/`Integer` 생성·비교·거듭제곱 전반. `Q` 도입은 비정수 입력 경로만 변경하고 순수 정수 경로(`else: p=int(p)` 등 다수 P2P)는 결과 동일해야 한다. test_Rational_new/test_Integer_new가 이를 지킴.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `numbers.py` L1628-L1640 퍼머링크와 `Rational.__new__`를 직접 지목 → 즉시 해당 비정수 처리 블록으로 직행(L0).
2. **픽스**: `q` 한 변수가 (a) 분자 비정수 분기의 분모 누적과 (b) 분모 자신의 값 두 역할을 겸하다 충돌함을 인지. 분모 누적 전용 `Q`를 분리해 `Q *= p.q`, `Q *= q.p`, `Q *= int(q)`로 **모든 분모 기여를 곱으로 합성**, 마지막에 `q = Q`. 이게 올바른 일반화인 이유: `Rational(p,q)`의 분모는 항상 p측 분모 × q측 값/분모의 곱이며, destructive 대입이 그 곱셈 불변식을 깨던 것을 복원하기 때문. 특정 입력이 아니라 불변식을 고친다.
3. **regression 안전**: 순수 정수 입력은 `Q=1`에서 시작해 `Q *= int(q)` 한 번만 곱하므로 기존 `q = int(q)`와 결과 동일 → test_Integer_new 등 P2P 보존. 분자 라인 `p *= q.q`는 미변경.
4. **함정 회피**: (a) 비정수 q 분기만 고치고 정수 분기를 놔두면 `Rational(2,2)`류가 새로 깨진다 — 두 분기 모두 `Q *=`로 통일해야 함. (b) `q = q.p`를 `q *= q.p`로 in-place 고치고 싶지만, p-분기에서 `q`를 이미 건드린 상태라 초기값이 오염될 수 있어 깨끗한 누적자 `Q=1` 도입이 안전. (c) 이슈 hint가 정답 코드를 줬다고 맹신해 정수 else 분기의 `Q *= int(q)`를 누락하면 가장 흔한 정수 경로가 전부 깨진다.
