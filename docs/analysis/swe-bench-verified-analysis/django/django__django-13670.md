---
instance_id: django__django-13670
repo: django/django
base_commit: c448e614c60cc97c6194c62052363f4f501e0953
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-11-12T11:45:51Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [django/utils/dateformat.py]
---

# django__django-13670

## 문제 요약
`django.utils.dateformat`의 포맷 문자 `"y"`(2자리 연도)가 1000년 미만 연도에서 잘못된 결과를 낸다. 예를 들어 `datetime(123, ...)`을 `"y"`로 포맷하면 `'3'`이 나오는데, 파이썬 `strftime("%y")`와 PHP `date("y")`는 모두 `'23'`을 반환한다. 사용자는 항상 2자리(필요시 leading zero 포함)로 끝 두 자리 연도가 출력되기를 기대한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (작은 연도 입력에 대한 처리 부재)
- 서브시스템: django utils — date formatting (`dateformat`)
- 증상 타입: 잘못된 출력 (silent-wrong, 예외는 없음)
- 로컬라이제이션 신호: problem_statement에 `dateformat.format(...)`와 포맷 문자 `"y"`가 직접 명시됨 → `django/utils/dateformat.py`의 `y` 메서드로 바로 좁혀짐. 첨부된 PR 링크도 동일 파일을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/dateformat.py` : `DateFormat.y()`
- 근본 원인: 기존 구현 `return str(self.data.year)[2:]`는 연도를 문자열로 만든 뒤 인덱스 2부터 슬라이싱한다. 4자리 연도(`'1999'[2:]` → `'99'`)에서는 맞지만, 3자리(`'123'[2:]` → `'3'`), 2자리, 1자리 연도에서는 끝 두 자리가 아니라 잘못된 일부만 잘려 나가고 leading zero도 없다.
- 수정 요지: 문자열 슬라이싱 대신 산술 연산으로 교체했다. `'%02d' % (self.data.year % 100)` — `% 100`으로 끝 두 자리 값을 취하고, `%02d` 포맷으로 항상 2자리(부족하면 0 패딩)를 보장한다. docstring도 "with leading zeros"로 명확화했다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_year_before_1000` — 1000년 미만 연도에 대해 `"y"` 포맷 결과를 확인한다.
- 테스트가 어떻게 픽스를 증명하는지: `(476, '76')`, `(42, '42')`, `(4, '04')` 3쌍을 `subTest`로 검증한다. 각각 `dateformat.format(datetime(year, 9, 8, 5, 0), 'y')`를 호출해 끝 두 자리(`476→76`, `42→42`)와 leading-zero 케이스(`4→04`)를 모두 커버한다. 구버전 슬라이싱 코드는 `476→'6'`, `42→''`, `4→''`로 전부 실패하므로 픽스가 효과를 발휘함을 보인다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 모듈·함수·포맷 문자를 명시하므로 `git grep "def y"` 또는 `dateformat.py`에서 `y`/`Y` 메서드를 바로 찾는다. 단일 파일, 단일 메서드, 2줄 수정.
- 함정/난이도 메모: 바로 위/아래의 `Y()`(4자리) 메서드와 혼동하지 말 것 — `Y`는 손대면 안 된다. 또 `% 100`만 적용하고 `%02d` 패딩을 빼면 `4→'4'`가 되어 `test_year_before_1000`의 `(4, '04')` 케이스에서 여전히 실패한다. 음수 연도는 datetime이 애초에 표현 못 하므로 고려 불필요.
- 우리 에이전트 관점: 막힐 위험은 낮다. 단, 슬라이싱을 "leading zero만 추가"하는 식으로 어설프게 고치려다 끝 두 자리 추출 로직 자체가 틀렸음을 놓칠 수 있다. 정답은 슬라이싱 폐기 후 `% 100` + 2자리 포맷이라는 점을 정확히 짚어야 한다.
