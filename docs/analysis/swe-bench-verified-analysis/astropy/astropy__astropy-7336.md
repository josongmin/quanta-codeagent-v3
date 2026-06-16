---
instance_id: astropy__astropy-7336
repo: astropy/astropy
base_commit: 732d89c2940156bdc0e200bb36dc38b5e424bcba
version: "1.3"
difficulty: "<15 min fix"
created_at: 2018-03-28T15:31:32Z
fail_to_pass: 1
pass_to_pass: 339
gold_files: [astropy/units/decorators.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`u.quantity_input` 데코레이터를 생성자 등에 쓸 때 반환 타입 힌트를 `-> None`으로 명시하면 `AttributeError: 'NoneType' object has no attribute 'to'`가 터진다. 데코레이터가 "return annotation이 비어있지 않으면 반환값을 그 단위로 변환"하는데, `None` 어노테이션(= "아무것도 반환 안 함")을 단위 어노테이션으로 오인하고 `None.to(None)`을 호출하기 때문이다. 이슈에는 완전한 재현 코드와 네이티브 스택트레이스, 그리고 "None이면 unit check를 생략하라"는 픽스 방향까지 적혀 있다.

## 유형 (정형화)
- **L = L0 (Pinpointed)**: 스택트레이스가 `astropy/units/decorators.py:225`의 `return return_.to(...)` 라인을 직접 지목한다. grep 한 방으로 `wrapped_signature.return_annotation` 분기에 도달한다.
- **S = S1 (Direct-Map) + 보조 S2**: 이슈가 "None이면 단위 검사를 생략"이라고 픽스를 사실상 명세한다. 기존 `is not inspect.Signature.empty` 가드에 `None`을 추가하는 정형적 None-가드 패턴이라 템플릿 매칭(S1). 다만 `empty`와 `None`을 *둘 다* 제외하는 멤버십 조건을 합성해야 한다는 점에서 약한 constraint 추론(S2)이 섞인다.
- **K = K-Gen**: astropy 단위 도메인 지식이 필요 없다. "타입 힌트 None은 반환값 없음을 뜻한다"는 일반 파이썬 시맨틱만 알면 된다.
- **primary = T-DirectMap**: 위치는 자명(L0)하고 픽스는 기계적 가드 추가(S1)다. APR 관점에서 PAR/TBar류 "널 가드 삽입" 변환 템플릿에 정확히 대응 — 후보 탐색·테스트 반복 없이 결함클래스에서 바로 패치가 도출된다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`decorators.py`) · 단일 헌크 · 1줄 변경(조건식 1개). localize 직접성은 최상(L0, has-repro 스택트레이스). 도메인 지식 불요(K-Gen). 공식 라벨 `<15 min fix`와 일치한다. T1로 더 내리지 않는 이유는 픽스가 순수 상수/기본값 변경이 아니라 `not in (empty, None)`이라는 *멤버십 조건 합성*을 요구하고(약한 S2), P2P가 339건으로 인접 동작(정상 단위 변환 `return_.to(...)`, 반환 어노테이션 없는 경로)을 깨지 말아야 하는 regression-trap이 존재하기 때문이다. 다만 그 trap은 "기존 분기를 좁히지 말고 추가만 한다"는 단조 확장이라 실질 위험은 낮아 T3까지 올라가지 않는다.

## 골드패치 분석
- **파일·함수**: `astropy/units/decorators.py`의 `QuantityInput.__call__` 내부 클로저 `wrapper` (반환값 후처리 분기).
- **근본원인**: 분기 조건이 `if wrapped_signature.return_annotation is not inspect.Signature.empty:`였다. 이 조건은 "어노테이션이 *존재*하면 단위 어노테이션이다"라고 가정한다. 그러나 `-> None`은 "반환값이 없다"는 합법적 어노테이션이며 `inspect.Signature.empty`와 다르므로 가드를 통과해, `None`(실제 반환값)에 대해 `.to(None)`을 호출하다 `AttributeError`가 발생한다.
- **수정요지**: 조건을 `if wrapped_signature.return_annotation not in (inspect.Signature.empty, None):`로 확장. `None` 어노테이션을 `empty`와 동등하게 취급해 단위 변환을 건너뛰고 `return return_`(여기선 `None`)을 그대로 돌려준다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1건)**: `test_return_annotation_none` — `@u.quantity_input` + `-> None` 함수가 정상 호출되어 결과가 `None`임을 단언. 패치 전엔 `.to(None)`에서 예외, 패치 후엔 분기를 건너뛰어 통과. 픽스가 곧 이 테스트의 통과 조건이라 인과가 직접 증명된다.
- **부수 변경**: test_patch가 `py3_test_quantity_annotations.py` → `test_quantity_annotations.py`로 rename하고, 과거 Python2 호환용 `@py3only`/`exec(src)` 우회를 제거해 진짜 파라미터화된 테스트로 바꾼다. 이 덕에 기존 어노테이션 테스트 25건이 실제로 수집·실행되어 P2P에 편입된다.
- **overfit 관점**: 픽스가 `None` 단일 케이스만 더해도 통과하지만, 그게 곧 의미적으로 *정확한 일반화*다(타입 시스템상 `None`이 "no return"의 표준 표기). special-case 우회가 아니다. `has-repro`로 결함이 좁게 한정돼 overfit 위험 낮음 → 플래그 미부여.
- **regression 관점**: P2P 339건(arg/kwarg 단위 검증, equivalencies, 정상 `-> u.deg` 반환 변환 `test_return_annotation`)이 깨지면 안 됨. 패치는 기존 `empty` 분기를 *좁히지 않고* `None`만 추가하므로 정상 단위 반환 경로(`test_return_annotation`)는 그대로 `return_.to(u.deg)`를 탄다 → regression-trap 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 스택트레이스 마지막 프레임 `decorators.py, line 225, in wrapper → return return_.to(...)`를 그대로 따라가 `wrapped_signature.return_annotation` 분기를 연다. has-repro라 탐색이 사실상 0이다.
2. **픽스와 일반화 근거**: 가드를 `not in (inspect.Signature.empty, None)`로 확장한다. 올바른 일반화인 이유 — 파이썬 타입 시스템에서 `-> None`은 "단위로 변환할 반환값이 없다"는 의미라, `empty`(어노테이션 부재)와 동일 클래스의 "변환 스킵" 케이스다. `None`만 ad-hoc하게 `if return_ is None: return None` 식으로 거르는 것보다, 어노테이션 자체를 보고 분기하는 게 결함의 진짜 원인(어노테이션 오인)을 고치는 것이다.
3. **regression 안전**: `test_return_annotation`(`-> u.deg` → `.to(u.deg)`)와 인자 단위 검증 전체(P2P 339)를 안 깨야 한다. 기존 분기를 좁히지 않고 멤버십에 항목만 추가하는 단조 확장이라 안전하다.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 흔한 오답 — (a) `wrapper` 안에서 `if return_ is None: return return_`로 *반환값*을 검사하는 것. 이건 정상적으로 `None`을 반환해야 할 비-None 어노테이션 함수에서까지 변환을 건너뛰게 해 의미를 흐린다. 올바른 축은 *어노테이션*(`return_annotation`)이지 *값*이 아니다. (b) `try/except AttributeError`로 감싸 예외를 삼키는 것 — 진짜 단위 mismatch 버그까지 가려 silent-fail을 만든다. 정답은 분기 조건 한 곳을 어노테이션 기준으로 확장하는 것이다.
