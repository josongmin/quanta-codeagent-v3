---
instance_id: sympy__sympy-13480
repo: sympy/sympy
base_commit: f57fe3f4b3f2cab225749e1b3b38ae1bf80b62f0
version: "1.1"
difficulty: "<15 min fix"
created_at: 2017-10-18T17:27:03Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [sympy/functions/elementary/hyperbolic.py]
primary_type: T-LocTrivial
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약

`coth(log(tan(x)))` 같은 식에 `.subs(x, 2)` 를 호출하면 `NameError: name 'cotm' is not defined` 로 크래시한다. 이슈는 네이티브 스택트레이스를 그대로 포함하며, 실패 지점 `hyperbolic.py` 590행 `if cotm is S.ComplexInfinity:` 을 직접 가리킨다. 2, 3, 5, 6, 8, 9, 11, 12... 등 특정 정수 인자에서만 재현되는데, 이는 `_peeloff_ipi` 가 인자에서 `i*pi` 배수를 떼어내 `m` 이 truthy(`if m:`)가 되는 분기에서만 해당 코드 경로가 실행되기 때문이다. 본문과 hints 모두 "`cotm` 은 `cothm` 의 오타"라고 명시한다.

## 유형 (정형화) — 3축(L/S/K)

- **L0 (Pinpointed)**: 스택트레이스가 파일·행·심볼(`cotm`)을 정확히 지목한다. grep `cotm` 한 방이면 유일 정의-없는-참조 지점이 잡힌다. 탐색 노력 0.
- **S1 (Direct-Map)**: 픽스가 사실상 명세돼 있다 — `NameError` 의 원인은 undefined name 이고, 바로 두 줄 위에 `cothm = coth(m)` 가 바인딩돼 있다. 기계적 1-토큰 교정(`cotm`→`cothm`)으로 끝. 추론 합성(S2)도, 후보 생성·검증 반복(S3/S4)도 불필요.
- **K-Gen (General)**: sympy 도메인 지식이 전혀 필요 없다. 순수 파이썬 스코프 규칙(undefined local name)만으로 결정된다. `coth`/`tanh` 의 수학적 정체성은 픽스의 정당성 판단에 무관하다.

**Primary type — T-LocTrivial**: L0 + S1 의 교과서적 조합. "찾으면 끝, 픽스 자명." APR 관점에서 이건 single-token mutation 으로, template-based repair(TBar/PAR)의 가장 단순한 변종 — undefined-symbol 을 동일 스코프의 유일 후보 바인딩으로 치환. constraint-reasoning 이 아닌 이유: 올바른 식·조건을 따질 게 없다. 바로 위 줄의 `cothm` 이 유일하고 자명한 의도된 이름이다.

## 난이도 티어 — T1 (존나쉬움)

구조적 피처: (1) 1파일·1줄·1토큰 수정, (2) `has-repro` — 네이티브 스택트레이스가 행번호+심볼까지 제공(ORACLE-SWE 기준 repro 는 가장 강한 easiness 신호, 해결률 ~87%), (3) hints_text 가 정답을 글자 그대로 적어줌, (4) K-Gen, regression-trap 약함. ICLR 2024 컷의 "1파일·<5줄 ≈ 48% solve" 구간보다도 더 쉬운, 사실상 상한 케이스다.

공식 라벨 `<15 min fix` 와 완전히 일치 — 오히려 분 단위가 아니라 초 단위 수정이다. 재조정 없음.

## 골드패치 분석

- **파일·함수**: `sympy/functions/elementary/hyperbolic.py`, `coth.eval(cls, arg)` (클래스메서드, 약 587행 분기).
- **근본원인**: 단순 오타(typo). `x, m = _peeloff_ipi(arg)` 로 `i*pi` 성분을 분리한 뒤 `cothm = coth(m)` 으로 변수를 정의했는데, 바로 다음 줄에서 정의되지 않은 `cotm` 을 참조한다. 이 코드 경로는 `if m:` 이 truthy 일 때만 실행되므로, `i*pi` 배수를 떼어낼 수 있는 인자(특정 정수 입력)에서만 `NameError` 가 터진다. 평소엔 dead 에 가까워 그동안 잡히지 않았다.
- **수정요지**: `cotm` → `cothm` 한 글자(정확히는 한 토큰) 교정. 이로써 `if cothm is S.ComplexInfinity: return coth(x)` / `else: return tanh(x)` 분기가 의도대로 동작한다.

```python
-                    if cotm is S.ComplexInfinity:
+                    if cothm is S.ComplexInfinity:
```

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_coth`** (1개). 추가된 단언 두 줄:
  - `assert coth(log(tan(2))) == coth(log(-tan(2)))` — 이슈의 재현식 `coth(log(tan(2)))` 가 크래시 없이 평가되고, `i*pi` peel-off 가 부호를 정규화해 `-tan(2)` 버전과 같아짐을 확인. `if m:` 분기를 실제로 태운다.
  - `assert coth(1 + I*pi/2) == tanh(1)` — `m = I*pi/2` 일 때 `cothm = coth(I*pi/2) == 0` → `else` 가지로 `tanh(x)` 반환. 즉 `cothm == 0` (ComplexInfinity 아님) 경로까지 커버해 `else` 도 함께 검증한다.
- **픽스 증명**: 첫 단언은 NameError 가 사라졌는지(예외→정상값), 둘째 단언은 분기 양쪽이 수학적으로 옳은 결과를 내는지를 동시에 묶어 잡는다.
- **overfit 관점**: `cotm` 은 그 스코프에 정의가 없는 유일 undefined name 이라, 통과시키는 치환 후보가 사실상 `cothm` 하나뿐이다. special-case 우회 여지가 없어 overfit-risk 없음. FAIL_TO_PASS 가 1개로 얇지만 결함클래스가 typo 라 얇음이 위험이 되지 않는다.
- **regression 관점**: PASS_TO_PASS 42개(다른 쌍곡/역쌍곡 함수 eval·series·rewrite)는 수정 줄이 `coth` 의 `if m:` 분기 안쪽이라 닿지 않는다. `regression-trap` 미부여.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 스택트레이스가 `hyperbolic.py:590, if cotm is S.ComplexInfinity` 을 직접 준다. `grep -n cotm sympy/functions/elementary/hyperbolic.py` → 정의 없는 단일 참조 확인. 바로 위 `cothm = coth(m)` 발견. localize 종료.
2. **픽스와 일반화**: `cotm` 을 `cothm` 으로 교정. 이게 올바른 일반화인 이유 — undefined name 의 의도된 referent 는 같은 분기 두 줄 위에서 막 계산한 `cothm` 이며, `else` 주석 `# cothm == 0` 이 변수명을 못박아 의도를 확증한다. 다른 어떤 식으로 바꿔도(예: 새 변수 도입, 조건 삭제) 분기 의미가 깨진다.
3. **regression 안전**: 수정이 `coth.eval` 의 `i*pi` peel-off 내부 분기 한 줄에 국한되므로 다른 함수·다른 인자 경로에 영향이 없다. PASS_TO_PASS 42개(sinh/cosh/tanh/csch/sech 및 역함수·series·rewrite) 전부 무관 — 안 깨진다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 만한 곳 — (a) NameError 를 보고 try/except 로 감싸 증상만 가리는 우회(근본원인 오타를 못 잡음), (b) `cotm`/`cothm` 의 수학적 의미를 과해석해 분기 로직 자체를 재작성(불필요한 over-engineering, regression 유발). 회피법: 예외 메시지가 "undefined name" 임을 신뢰하고, 동일 스코프에서 가장 가까운 정의된 동음이의 후보(`cothm`)로의 1-토큰 치환이 최소·정답임을 인식하면 된다. hints 와 트레이스가 이미 이를 가리킨다.
