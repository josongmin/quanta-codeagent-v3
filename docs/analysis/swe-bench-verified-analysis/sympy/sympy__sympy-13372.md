---
instance_id: sympy__sympy-13372
repo: sympy/sympy
base_commit: 30379ea6e225e37833a764ac2da7b7fadf5fe374
version: "1.1"
difficulty: "<15 min fix"
created_at: 2017-09-30T16:05:48Z
fail_to_pass: 1
pass_to_pass: 44
gold_files: [sympy/core/evalf.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`Mul(Max(0, y), x, evaluate=False).evalf()` 호출 시 `UnboundLocalError: local variable 'reprec' referenced before assignment`가 발생한다. arg 순서를 바꾸면(`Mul(x, Max(0, y), ...)`) 정상 동작하므로 순서 의존 버그다. `evalf` 폴백 경로에서 `re`/`im`이 `0`도 아니고 `is_number`도 아닌 경우(여기선 미평가 `Max`) `reprec`/`imprec`가 끝내 바인딩되지 않은 채 `r = re, im, reprec, imprec`에 도달한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 스택트레이스가 `evalf.py:1308`, 변수명 `reprec`까지 정확히 지목. grep 한 방. 점수 = L0.
- **S1 (Direct-Map) + 보조 S2**: 이슈 본문이 픽스를 사실상 명세 — "elif 절들에 `else: raise NotImplementedError`를 붙여야 한다". 정형 결함클래스(분기 누락으로 인한 미초기화 변수)에 템플릿 매칭이라 S1. 단 hints에서 `else: reprec = None`(exact-zero 의미) vs `raise NotImplementedError` 둘 중 무엇이 맞는지 짧은 의미 판단이 필요해 S2를 보조로 둔다. 골드는 `raise NotImplementedError`를 택했다.
- **K-Domain**: `evalf` 내부의 `(re, im, reprec, imprec)` 튜플 계약과 "prec=None은 정확한 0을 의미"하는 mpmath 평가 규약을 알아야 올바른 분기를 고를 수 있음. sympy evalf 도메인 지식.
- **primary = T-DirectMap**: 위치는 trace로 자명(L0)하고 픽스는 누락 분기에 가드를 추가하는 기계적 작업(S1)이라 T-DirectMap이 dominant. 이슈가 패치를 거의 받아쓰기 수준으로 적어줬다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`sympy/core/evalf.py`) 단일 함수, +4줄(else 2개), `has-repro`(네이티브 스택트레이스 + 한 줄 재현)로 easiness 신호 최강. localize 직접성 L0. 추론 부담은 "None 대입 vs raise" 한 번뿐. 공식 라벨도 `<15 min fix`로 일치. T1이 아닌 이유: 의미 선택(S2 보조)과 K-Domain이 끼어 순수 자명 픽스보다는 살짝 위. 또한 `PASS_TO_PASS` 43개로 evalf 인접 동작을 광범위하게 보호해야 해 `regression-trap`이 존재 — 잘못 `reprec=None`을 채우면 후속 `to_str`/`mpf` 처리가 비수치값을 0처럼 다뤄 인접 케이스를 깰 수 있다.

## 골드패치 분석
- **파일·함수**: `sympy/core/evalf.py`의 `evalf(x, prec, options)` 내부 `except KeyError` 폴백 블록.
- **근본원인**: `re == 0` / `elif re.is_number` 두 분기만 있어 `reprec`을 설정한다. `re`가 미평가 심볼릭 표현(`Max(0, y)` 같은)인 경우 두 분기 모두 미스 → `reprec` 미바인딩. `im`도 `imprec`에 대해 동일. 직후 `r = re, im, reprec, imprec`가 미정의 지역변수를 참조해 `UnboundLocalError`. arg 순서 의존은 `evalf_mul`이 인자를 순회하며 비수치 arg를 먼저 만나느냐 차이일 뿐, 진짜 원인은 분기 누락.
- **수정요지**: `elif re.is_number` 뒤에 `else: raise NotImplementedError`, `elif im.is_number` 뒤에 `else: raise NotImplementedError` 추가. 비수치 분기를 `NotImplementedError`로 보내면 바깥의 evalf 머신이 이를 잡아 표현식을 미평가 형태로 그대로 반환(`x*Max(0, y)`)한다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_evalf_bugs`에 `assert NS(Mul(Max(0, y), x, evaluate=False).evalf()) == 'x*Max(0, y)'` 추가. 패치 전엔 `UnboundLocalError`로 크래시, 후엔 `NotImplementedError`가 폴백되어 곱이 미평가로 유지되며 `'x*Max(0, y)'` 출력.
- **픽스 증명**: 테스트가 정확히 "비수치 arg를 가진 Mul의 evalf가 크래시 대신 심볼릭 결과를 낸다"는 동작을 못박음. `else: raise NotImplementedError`가 그 경로를 만든다.
- **overfit·regression 관점**: `raise NotImplementedError`는 `re == 0`/`is_number` 두 정상경로를 전혀 건드리지 않아 수치 evalf는 byte-identical. 따라서 43개 P2P(`test_evalf_complex`, `test_evalf_mul`, `test_scaled_zero` 등)는 무영향. overfit 위험 낮음 — 픽스가 특정 입력(`Max`)이 아니라 "비수치 re/im 일반 클래스"를 다루는 올바른 일반화라서. FAIL_TO_PASS가 1개로 얇지만, 비수치 분기를 일반적으로 막으므로 special-case 통과가 아님.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `evalf.py:1308`과 변수 `reprec`을 직접 줌 → 해당 try/except KeyError 폴백 블록으로 직행. `re == 0`/`elif re.is_number`만 있고 else가 없음을 즉시 확인.
2. **픽스**: 두 elif 뒤에 `else: raise NotImplementedError`. 이게 올바른 일반화인 이유 — `reprec=None`은 "정확한 0"을 뜻하는 규약(hints에서 논의됨)인데 `Max(0, y)`는 0이 아니라 그냥 평가 불가일 뿐이므로 None으로 0인 척하면 의미 오류. `NotImplementedError`는 상위 evalf가 이미 잡아 미평가 폴백시키도록 설계돼 있어, 비수치값을 정직하게 "수치화 불가"로 신호함.
3. **regression 안전**: 정상 0/수치 분기를 안 건드리는 게 핵심. 모든 P2P(complex/mul/scaled_zero/to_mpmath 등)는 수치 경로만 타므로 새 else는 그들에 도달하지 않아 안전.
4. **함정 회피**: 오라클 없는 에이전트는 hints의 첫 제안(`reprec = None`)을 그대로 채울 수 있음 — 통과는 하나 의미적으로 틀려 다른 미평가 케이스에서 0 오염을 일으킬 수 있다. 또 arg 순서 의존에 매몰돼 `evalf_mul`을 고치려 들면(증상 추적) 진짜 원인인 분기 누락을 놓친다. 정답은 "왜 순서가 영향?"이 아니라 "왜 reprec가 미바인딩?"에 집중하는 것.
