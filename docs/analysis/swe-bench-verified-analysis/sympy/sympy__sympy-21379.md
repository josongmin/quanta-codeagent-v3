---
instance_id: sympy__sympy-21379
repo: sympy/sympy
base_commit: 624217179aaf8d094e6ff75b7493ad1ee47599b0
version: "1.9"
difficulty: "15 min - 1 hour"
created_at: 2021-04-24T19:49:52Z
fail_to_pass: 1
pass_to_pass: 91
gold_files: [sympy/core/mod.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
실수(real) 심볼과 `Piecewise` 인자를 가진 `exp(sinh(Piecewise(...) / z))` 같은 표현식에 `subs({1: 1.0})`를 적용하면 예기치 않은 `PolynomialError: Piecewise generators do not make sense`가 발생한다. 근본 경로는 assumptions 질의(`is_zero` → `sinh._eval_is_real`의 `(im % pi).is_zero`)가 `Mod`를 생성하고, `Mod.eval`이 `Piecewise` 인자에 대해 `gcd`를 호출하면서 `gcd`가 예외를 던지는 것이다. 캐시 때문에 첫 호출만 실패하고(잘못된 `None` assumption이 캐싱됨) 이후엔 통과하는 비결정성도 동반된다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈에 전체 트레이스백이 첨부되어 있고(`mod.py:169` `G = gcd(p, q)`에서 raise), 힌트가 정확한 파일·함수까지 지목한다. grep 한 방은 아니지만 스택트레이스로 단일 지점에 즉시 수렴.
- **S (Repair) = S1 (+S2)**: 픽스는 정형 결함클래스 — "예외를 던질 수 있는 호출을 try/except로 가드"하는 기계적 템플릿(S1). 단, 어떤 예외(`PolynomialError`)를 잡고 실패 시 어떤 중립값(`G = S.One`)으로 폴백해야 의미가 보존되는지는 도메인 추론(S2)이 약하게 섞임.
- **K (Knowledge) = K-Domain**: `gcd`가 `Piecewise`에서 raise한다는 점, `G=1`(즉 `S.One`)이 "gcd 추출을 건너뛴" 의미상 안전한 항등원이라는 점은 sympy polys/core 내부 지식이 필요.
- **Primary = T-DirectMap**: 위치는 트레이스로 명확하고, 픽스는 None-가드류와 동형인 "예외 가드 + 중립 폴백" 기계적 매핑. 추론보다 결함클래스 템플릿 매칭이 본질이라 T-DirectMap.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·실질 ~7줄(try/except 래핑)·repro 완비(`has-repro`)는 T1~T2를 가리키지만, 위로 미는 요인 둘 — (1) 인과사슬이 깊다: `subs` → `exp.eval`의 `is_zero` → assumptions `_ask` → `sinh._eval_is_real`의 `im % pi` → `Mod.eval` → `gcd`. 이슈가 트레이스를 다 줘서 localize는 풀리지만 "왜 여기를 고치는가"의 인과를 따라가야 함. (2) `Mod`는 산술 코어 핫패스라 PASS_TO_PASS 92개(`test_Mod`, `test_arit0`, `test_Mod_is_integer` 등)를 안 깨야 하는 `regression-trap`. 공식 라벨 "15분-1시간"과 정합(트레이스가 있어 구현은 짧음). T2가 아닌 이유는 깊은 assumptions 사슬 이해 + 넓은 P2P trap.

## 골드패치 분석
- **파일·함수**: `sympy/core/mod.py`의 `Mod.eval` 내부 (모듈 상단 import 1줄 + gcd 추출 블록).
- **근본원인**: `Mod.eval`이 gcd 추출 단계에서 무조건 `G = gcd(p, q)`를 호출하는데, `p` 또는 `q`가 `Piecewise`를 포함하면 `polytools.parallel_poly_from_expr`가 `PolynomialError("Piecewise generators do not make sense")`를 raise한다. 이 예외가 `_eval_is_real → is_zero` 질의 도중 전파되어 무관한 `subs` 호출이 실패한다.
- **수정요지**: gcd 추출을 `try/except PolynomialError`로 감싸고, 실패 시 `G = S.One`로 폴백해 gcd-추출 단순화 단계를 건너뛴다. `from sympy.polys.polyerrors import PolynomialError` import를 추가. `G = S.One`이면 뒤따르는 `if G != 1` 분기가 거짓이 되어 `gcd_terms` 재작성을 건너뛰므로 `Mod`는 원래 `p, q`로 정상 계속된다. 힌트가 제안한 패치와 동일(issue 21373).

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_Mod`** (단일): `test_arit.py::test_Mod`에 세 줄이 추가됨 — `(Piecewise((x_r, y_r > x_r), (y_r, True)) / z) % 1` (직접 `Mod` 호출), `exp(sinh(... / z)).subs({1: 1.0})` (원 MWE), `sinh(... * z**-1.0).is_zero` (assumptions 경로). 픽스 전에는 첫 줄 `% 1`에서 `PolynomialError`가 터져 테스트 함수 전체가 실패; 픽스 후 예외가 가드되어 세 줄 모두 통과.
- **픽스 증명**: 추가된 케이스가 정확히 결함 트리거 3경로(`__mod__`, `subs`/`exp.eval`, `is_zero`)를 친다. `G = S.One` 폴백이 `Mod`를 raise 없이 통과시킴을 직접 관찰.
- **overfit/regression 관점**: FAIL_TO_PASS가 단 1개 함수라 얇아 보이나, 픽스가 special-case가 아니라 "Piecewise이든 무엇이든 gcd가 raise하면 단순화 스킵"이라는 일반 가드라 overfit-risk는 낮음(그래서 플래그에 미포함). 반대로 `Mod` 코어를 건드려 92개 P2P(`test_Mod_is_integer`, `test_Mod_Pow`, `test_Mod_is_nonposneg` 등 모든 Mod 동작)를 보존해야 함 → `regression-trap`. 폴백을 try의 정상 경로와 분리(except에서만 `G=S.One`)했기에 기존 gcd-추출 동작은 비-Piecewise 입력에서 그대로 유지.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈의 전체 트레이스백을 따라간다 — 맨 아래 `mod.py:169 G = gcd(p, q)` → `polytools` → `PolynomialError`. 호출 스택을 위로 읽으면 `exp.eval`의 `if arg.is_zero` → assumptions `_ask` → `sinh._eval_is_real`의 `(im % pi).is_zero` → `Expr.__mod__` → `Mod`. 결함의 raise 지점은 `Mod.eval`의 gcd 추출이라고 확정.
2. **픽스**: `G = gcd(p, q)` 한 줄이 `Piecewise`에서 `PolynomialError`를 던지는 게 유일한 실패원이므로, 이 호출(과 뒤따르는 `gcd_terms` 재작성)을 `try/except PolynomialError`로 감싸고 폴백 `G = S.One`을 둔다. 이게 올바른 일반화인 이유: `S.One`은 "gcd 추출 없이 진행"을 뜻하는 의미상 항등 폴백이라 `Mod`의 정확성을 해치지 않고(단순화는 어차피 선택적), Piecewise 특정 검사가 아니라 raise 클래스 자체를 잡으므로 미래의 유사 입력도 커버.
3. **Regression 안전**: 가드를 정상 경로 밖(except 블록)에만 두어 비-Piecewise 입력은 byte-identical하게 기존 gcd 추출을 탄다. 따라서 `test_Mod_is_integer`/`test_Mod_Pow` 등 92개 P2P의 정수성·거듭제곱·부호 판정 동작이 그대로 보존됨을 보장.
4. **함정 회피**: (a) 오라클 없는 에이전트는 트레이스의 깊이에 휘둘려 `exp.eval`, `assumptions.py`, 또는 `hyperbolic.py`의 `_eval_is_real`을 고치려 들 수 있다 — 그건 증상 지점이지 raise 발생지가 아니다. 이슈가 명시한 3개 하위문제 중 골드는 #2(`Mod`의 미가드 gcd)만 고친다. (b) `gcd` 자체를 Piecewise 지원하도록 고치는 것(이슈의 #3 토론)은 범위 폭발 + 회귀 위험이라 비채택. (c) assumptions의 `None` 캐싱(#1)은 더 깊은 비결정성 버그지만 본 픽스 범위 밖 — 예외를 애초에 없애면 `None`도 캐싱되지 않아 부수적으로 해소됨. 가장 좁고 정확한 가드 한 곳을 잡는 것이 정답.
