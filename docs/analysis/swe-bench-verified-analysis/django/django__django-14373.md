---
instance_id: django__django-14373
repo: django/django
base_commit: b1a4b1f0bdf05adbd3dc4dde14228e68da54c1a3
version: "4.0"
difficulty: <15 min fix
created_at: 2021-05-10T14:40:32Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [django/utils/dateformat.py]
---

# django__django-14373

## 문제 요약
`django.utils.dateformat.DateFormat`의 `Y` 포맷 스펙은 항상 4자리 zero-padded 연도(예: `1999`)를 반환해야 한다. 그러나 연도가 1000 미만일 때 zero-padding이 적용되지 않아, 예를 들어 연도 1이 `0001`이 아니라 `1`로 출력된다. 사용자는 모든 연도에서 항상 4자리 패딩 출력을 기대했다.

## 유형 분류
- 버그 카테고리: edge-case (경계값 year < 1000), 누락처리(패딩 누락)
- 서브시스템: django utils / dateformat (날짜 포맷팅)
- 증상 타입: silent-wrong (예외 없이 잘못된 문자열 출력)
- 로컬라이제이션 신호: problem_statement가 `django.utils.dateformat.DateFormat`와 `Y` 스펙을 명시적으로 지목 → `dateformat.py`의 `Y` 메서드로 직행

## 골드패치 분석
- 건드린 파일/함수: `django/utils/dateformat.py:DateFormat.Y()`
- 근본 원인: `Y()`가 `return self.data.year`로 정수를 그대로 반환했다. 정수가 문자열로 변환될 때 zero-padding이 전혀 적용되지 않아, year < 1000인 경우 4자리 미만 문자열이 된다. 인접한 `y()`(2자리), `z()` 등은 이미 `%`-포맷으로 패딩하는데 `Y`만 누락.
- 수정 요지: 반환을 `return '%04d' % self.data.year`로 변경하여 4자리 zero-padding을 강제. docstring도 "Year, 4 digits with leading zeros; e.g. '1999'."로 명확화. 반환 타입이 int→str로 바뀌지만 포맷 합성 시 문자열로 합쳐지므로 일관됨.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_Y_format_year_before_1000` — `dateformat.format(datetime(1, 1, 1), 'Y')`가 `'0001'`, `datetime(999, 1, 1)`이 `'0999'`임을 단언.
- 테스트가 어떻게 픽스를 증명하는지: 픽스 전에는 year=1 → `'1'`, year=999 → `'999'`가 나와 단언이 실패한다. `'%04d'` 적용 후 각각 `'0001'`, `'0999'`가 되어 통과. 기존 `test_year_before_1000`는 `Y`와 `y`를 구분하기 위해 `test_y_format_year_before_1000`으로 rename되어 PASS_TO_PASS에 남아 회귀 가드 역할.

## 공략 포인트 (뭘 조져야)
- localization 전략: `dateformat.py`에서 `def Y(` 검색 → 단일 메서드 한 줄 수정. problem_statement가 파일·메서드·스펙명을 모두 제공하므로 탐색 난이도 최저.
- 함정/난이도 메모: 단일 파일·단일 라인. 주의할 점은 (1) `'%04d'`처럼 4자리 zero-pad를 써야지 `str().zfill(4)` 같은 변형이어도 동작은 같지만 골드와 표현만 다름, (2) 반환 타입이 int에서 str로 바뀌는 점이 다른 포맷 합성 경로를 깨지 않는지 확인 필요(실제로는 안전). 멀티파일 아님.
- 우리 에이전트 관점: 막힐 지점 거의 없음. 위험은 과도수정(인접 `y`/`z`/`r` 등 다른 스펙까지 건드리거나, year >= 10000 같은 비현실적 케이스 방어 추가)으로 PASS_TO_PASS를 흔드는 것. 최소 변경 원칙 유지가 핵심.
