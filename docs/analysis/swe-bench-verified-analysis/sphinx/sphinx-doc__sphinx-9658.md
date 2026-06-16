---
instance_id: sphinx-doc__sphinx-9658
repo: sphinx-doc/sphinx
base_commit: 232dbe41c5250eb7d559d40438c4743483e95f15
version: "4.3"
difficulty: "15 min - 1 hour"
created_at: 2021-09-20T17:04:23Z
fail_to_pass: 1
pass_to_pass: 24
gold_files: [sphinx/ext/autodoc/mock.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`autodoc_mock_imports`로 mock된 외부 패키지(예: `torch.nn`)를 상속하는 클래스를 문서화할 때, "Bases" 섹션이 `torch.nn.Module`이 아니라 `torch.nn.` 처럼 클래스명이 빠진 채로 렌더된다. sphinx 3.4.2에서 누락 클래스가 다시 문서화되도록 고쳐진 뒤 새로 드러난 회귀로, mock 객체의 이름이 base-class 표시 경로에서 빈 문자열로 흘러들어간다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 `torch.nn.` ← 끝의 클래스명 손실을 명확히 지목한다. mock 객체가 base로 들어가므로 후보는 `sphinx/ext/autodoc/mock.py`의 `_MockObject`/`_make_subclass`와 `sphinx/util/typing.py`의 `restify`/`stringify` 두 군데로 빠르게 좁혀진다. grep 한 방은 아니지만 cross-module 추적이 짧다.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 좁지만, 올바른 식은 "`restify`/`stringify`가 base 이름을 뽑을 때 어떤 속성을 읽는가(`__qualname__`)" vs "mock이 어떤 속성을 비워두는가(`__qualname__ = ''`)"의 불변식을 따져야 나온다. 단순 가드 추가가 아니라 속성 채움 규칙을 일관되게 합성하는 추론.
- **K-Domain**: sphinx autodoc mock 메커니즘(`_MockObject`/`_make_subclass`)과 typing 렌더러가 `__qualname__`/`__name__`/`__module__`을 어떻게 소비하는지 알아야 한다. 일반 파이썬 추론만으론 부족.

primary type은 **T-ConstraintReason**: 위치는 비교적 명확하나, 빈 `__qualname__`이 렌더 경로를 어떻게 망가뜨리는지 데이터플로우 불변식을 추론해 올바른 채움값을 합성하는 것이 본질. APR 관점에서 SemFix/Angelix식 의미 수리(속성값의 올바른 명세 합성)이지, 템플릿 매칭(S1)이나 테스트 반복(S3)이 아니다.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 단일 파일·3 헌크·총 +3줄로 scope는 작다(48% solve 구간에 가까움). `has-repro`(readthedocs 빌드 링크 + 명확한 기대값)로 easiness가 올라간다. 그러나 (1) 근본원인이 mock.py에 있는데 증상은 typing.py 렌더 경로에서 나타나는 cross-module 인과라 localize에 한 단계 추론이 필요하고, (2) `__qualname__`을 직접 채우는 함정(아래)이 있어 단순 T2는 아니다. 공식 difficulty "15분-1시간"과 정합(T3 prior와 일치).

## 골드패치 분석

- 파일: `sphinx/ext/autodoc/mock.py`
- 함수/클래스: `_MockObject`(클래스 속성 + `__init__`), `_make_subclass`(attrs 딕셔너리)
- 근본원인: `_MockObject.__init__`이 무조건 `self.__qualname__ = ''`로 덮어썼다. `restify`/`stringify`(typing.py)는 base 클래스 이름을 `cls.__qualname__`(line 194·222 등)에서 읽어 `'%s.%s' % (module, qualname)`을 만든다. mock의 `__qualname__`이 빈 문자열이므로 `torch.nn.` + `''` = `torch.nn.`이 되어 클래스명이 사라진다. `_make_subclass`는 `__display_name__`에만 이름을 넣고 `__name__`은 채우지 않았다.
- 수정요지: (1) `_MockObject`에 클래스 속성 `__name__ = ''` 추가. (2) `__init__`을 `self.__qualname__ = self.__name__`으로 변경 — 빈 상수 대신 실제 이름을 반영. (3) `_make_subclass`의 attrs에 `'__name__': name` 추가하여 서브클래스가 진짜 이름을 갖도록. 결과적으로 `__qualname__`이 `name`을 받아 렌더가 `torch.nn.Module`로 복원된다.

## 검증 (test_patch)

- FAIL_TO_PASS: `test_restify_mock` — `with mock(['unknown']): import unknown; assert restify(unknown.secret.Class) == ':py:class:`unknown.secret.Class`'`. 픽스 전엔 `unknown.secret.` (마지막 `Class` 손실), 픽스 후 `__name__='Class'`→`__qualname__='Class'`로 정확히 복원.
- 동반 PASS_TO_PASS에 신규 `test_stringify_mock`(`'unknown.secret.Class'`)도 포함돼 두 렌더러(restify/stringify) 양쪽 경로를 모두 고정한다.
- overfit 관점: F2P가 1개로 얇지만, `_make_subclass`가 nested attribute(`secret.Class`)로 생성하는 실제 mock 동작을 통과하므로 special-case 통과 여지는 작다. `__name__`을 generic하게 채우는 픽스라 특정 입력에 맞춘 하드코딩이 아니다.
- regression 관점: PASS_TO_PASS 24개가 `restify`/`stringify`의 비-mock 경로(컨테이너/Union/Callable/TypeVar/ForwardRef/Literal/broken-type 등)를 광범위하게 커버 → `regression-trap`. mock.py만 건드려 typing.py 분기 로직을 안 바꿨으므로 이들 경로는 무영향.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 `torch.nn.` ← 끝 점만 남고 이름 손실 신호 → "Bases" 렌더는 `restify`/`stringify`(typing.py)가 base 이름을 만든다 → 거기서 `__qualname__`/`__name__`을 읽음을 확인 → base가 mock 객체이므로 `_MockObject`/`_make_subclass`의 속성 채움을 점검 → `__init__`의 `self.__qualname__ = ''`가 범인.
2. **픽스와 올바른 일반화**: 단순히 typing.py에서 빈 qualname을 가드하지 말고, 데이터의 출처인 mock 객체가 자기 이름을 일관되게 노출하도록 `__name__`을 도입하고 `__qualname__`을 그것으로 채운다. 모든 mock 서브클래스에 generic하게 적용되므로(`_make_subclass`에 `'__name__': name`) 입력공간 전반에 옳다.
3. **regression 안전**: typing.py의 24개 P2P(비-mock 타입 렌더)를 안 깨야 한다. mock.py만 수정해 렌더러 분기를 손대지 않음으로써 자동 보장. `__display_name__`(기존 mock repr/디버그 용도)은 유지해 mock의 다른 소비자도 안 깬다.
4. **함정 회피**: (a) 증상이 typing.py에서 나타난다고 거기에 `if not qualname` 류 가드를 넣으면 근본원인(빈 이름 전파)을 못 잡고 다른 경로에서 재발 — 데이터 출처인 mock에서 고쳐야 함. (b) `__init__`에서 `self.__qualname__ = ''`만 지우면 `__name__`이 없어 AttributeError 위험 → 클래스 기본값 `__name__ = ''`을 함께 둬야 안전. (c) `_make_subclass`에 `__name__`을 빠뜨리면 서브클래스는 여전히 빈 이름이라 F2P가 통과 안 됨 — 세 변경이 함께 가야 함.
