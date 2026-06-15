---
instance_id: django__django-12193
repo: django/django
base_commit: 3fb7c12158a2402f0f80824f6778112071235803
version: 3.1
difficulty: <15 min fix
created_at: 2019-12-08T01:38:25Z
fail_to_pass: 1
pass_to_pass: 11
gold_files: [django/forms/widgets.py]
---

# django__django-12193

## 문제 요약
`SplitArrayField`에 `BooleanField`를 쓰고 기존 데이터를 채워 렌더링하면, 데이터 배열에서 첫 번째 `True`를 만난 이후의 모든 위젯이 백킹 데이터가 `False`임에도 전부 checked로 나온다. 원인은 `CheckboxInput.get_context()`가 전달받은 `attrs` dict를 in-place로 변형(`attrs['checked'] = True`)하기 때문이다. 사용자는 각 subwidget이 자기 데이터값(`True`/`False`)에 맞게 독립적으로 렌더링되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리(부수효과/dict 공유 변형) — 입력 인자 mutation으로 인한 상태 누수
- 서브시스템: django forms widgets (`CheckboxInput`, `SplitArrayWidget`)
- 증상 타입: silent-wrong (예외 없이 잘못된 렌더링 출력)
- 로컬라이제이션 신호: problem_statement가 `django/forms/widgets.py#L527`의 `CheckboxInput`이 `attrs['checked']`를 세팅하는 라인을 직접 지목하고, "this is the only widget that modifies the attrs dict"라고 명시 → 단일 파일/단일 메서드로 즉시 수렴.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/widgets.py` : `CheckboxInput.get_context`
- 근본 원인: `SplitArrayWidget`은 size만큼의 subwidget에 동일한 `final_attrs` dict를 재사용하며 루프를 돈다. `CheckboxInput.get_context`가 `attrs['checked'] = True`로 공유 dict를 in-place 변형하면, 첫 `True` 이후 같은 dict가 계속 `checked` 키를 보유한 채 다음 subwidget으로 넘어가 `False` 항목까지 checked가 새어나간다.
- 수정 요지: 공유 dict를 직접 건드리지 않고 새 dict를 만들어 전달하도록 변경. 기존의 `if attrs is None: attrs = {}` 후 `attrs['checked'] = True` 3줄을 `attrs = {**(attrs or {}), 'checked': True}` 한 줄로 교체. 이로써 호출자가 넘긴 dict는 불변으로 유지되고, checked 표시는 로컬 복사본에만 반영된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_get_context_does_not_mutate_attrs` — `attrs = {'checked': False}`를 넘기고 `get_context('name', True, attrs)` 호출 후 `attrs['checked']`가 여전히 `False`인지 확인(호출자 dict가 변형되지 않았음을 단언).
- 추가 회귀 테스트(postgres): `test_checkbox_get_context_attrs` — `SplitArrayWidget(CheckboxInput(), size=2)`에 `[True, False]`를 렌더링해 subwidget attrs가 정확히 `[{'checked': True}, {}]`로 나오는지 검증. 즉 두 번째 `False` 위젯에 checked가 누수되지 않음을 실제 SplitArray 경로로 증명.
- 재현 입력 → 기대 출력: `[True, False]` 입력 시 첫 위젯만 checked, 둘째 위젯 attrs는 빈 dict.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 파일·라인·메서드를 직접 명시하므로 `CheckboxInput.get_context`만 보면 된다. `attrs`를 mutate하는 패턴(`attrs[... ] =`)을 grep하면 단번에 잡힌다.
- 함정/난이도 메모: 버그 증상은 `SplitArrayWidget`(심지어 postgres contrib)에서 드러나지만 수정 지점은 `CheckboxInput`이다 — 증상 발생 위치와 원인 위치가 다른 멀티-위젯 상호작용. `attrs is None` 가드를 유지하면서 mutation만 제거해야 하므로 `{**(attrs or {})}`가 `None`/빈 dict 둘 다 안전하게 처리하는 점이 핵심.
- 우리 에이전트 관점: 막힐 만한 지점은 (1) 증상이 postgres SplitArray에 있어 거기서 수정하려 들면 잘못된 파일을 건드릴 위험, (2) mutation을 그냥 copy로 바꾸되 `None` 케이스를 깨뜨리는 회귀. problem_statement의 명시적 라인 포인터를 신뢰하면 5분 안에 수렴 가능한 저난도 문제.
