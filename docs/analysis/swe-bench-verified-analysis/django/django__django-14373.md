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
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [overfit-risk]
---

# django__django-14373

## 문제 요약
`django.utils.dateformat.DateFormat`의 `Y` 포맷 스펙은 항상 4자리 zero-padded 연도(예: `1999`)를 반환해야 한다. 그러나 연도가 1000 미만일 때 zero-padding이 적용되지 않아, 예를 들어 `datetime(1, 1, 1)`이 `0001`이 아니라 `1`로 출력된다. 예외 없이 잘못된 문자열이 나오는 silent-wrong 결함이며, 인접한 `y()`/`z()`는 이미 패딩하는데 `Y()`만 누락된 일관성 결함이다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement가 모듈(`django.utils.dateformat.DateFormat`), 스펙 문자(`Y`)를 명시적으로 지목한다. `grep "def Y(" django/utils/dateformat.py` 한 방으로 단일 메서드에 도달. cross-module 추적·후보 다수성 전무.
- **S1 (Direct-Map / template)** — 이슈가 사실상 픽스를 명세한다("supposed to always return a four-digit year padded with zeros"). 정형 결함클래스(누락된 포맷/패딩)에 템플릿 매칭되며, 픽스는 기계적 "정수 반환 → `%04d` 포맷 적용"이다. 올바른 식을 추론으로 합성(S2)할 것도, 후보 다수에서 테스트로 선택(S3)할 것도 없다. 기대 동작이 코드 외부 스펙에서 명확히 주어지므로 S5도 아니다.
- **K-Gen (General)** — `%04d` 패딩은 순수 파이썬 포맷팅 상식이다. django 내부 ORM/query-compiler 같은 도메인 지식이나 공개 API 계약 정밀맞춤이 필요 없다. (`Y()` 리턴 타입이 int→str로 바뀌는 미묘한 점은 있으나 일반 파이썬 추론으로 안전성 확인 가능.)
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 패딩 추가(S1). "찾으면 끝, 픽스 자명"한 T-LocTrivial과 거의 같으나, 정수→포맷문자열 변환이라는 정형 결함클래스 픽스를 명시적으로 적용하는 점에서 T-DirectMap이 더 정확하다.

왜 S1인가(APR 관점): PAR/TBar류 fix-pattern 라이브러리에 "출력 포맷 누락 → 포맷팅 함수 래핑"이라는 변환 템플릿이 존재한다. 이슈 본문 자체가 oracle 스펙("4-digit padded with zeros")을 제공하므로 후보공간이 사실상 단일점으로 붕괴한다. 탐색·합성·반복검증 단계가 모두 trivial하다.

## 난이도 티어
**T1 (존나쉬움)** — 공식 difficulty 라벨 `<15 min fix`와 일치한다.

이 티어로 미는 구조적 피처:
- **파일 1개 / 헌크 1개 / 실질 1줄** (docstring 제외): gold patch는 `django/utils/dateformat.py` 단일 파일의 `Y()` 본문 한 줄. ICLR 2024의 "1파일·<5줄 ≈ 48% solve" 구간보다도 더 작다.
- **localize 직접성 최상(L0)**: 이슈가 파일·메서드·스펙명·기대출력을 전부 명시. 실패의 ~51%를 차지하는 localization 에러 위험이 사실상 0.
- **도메인 지식 불필요(K-Gen)**: knowledge-deficiency 실패 경로 차단.
- **P2P trap 약함**: 19개 PASS_TO_PASS가 모두 같은 `DateFormatTests` 클래스 내 인접 포맷 테스트라, 회귀 범위가 좁고 직관적이다.

공식 라벨과 티어가 어긋나지 않는 정상 케이스. 단, `overfit-risk` 플래그가 시간라벨에는 안 잡히는 잠재 함정(아래 참조)이라 점수가 아닌 메모로 남긴다.

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/dateformat.py` → `DateFormat.Y()` (단일 메서드).
- **근본 원인**: `Y()`가 `return self.data.year`로 **정수를 그대로 반환**했다. 이후 포맷 합성 단계에서 `str()` 변환될 때 zero-padding이 전혀 없어, year < 1000이면 4자리 미만 문자열이 된다. 동일 클래스의 `y()`(`'%02d' % ...`), `z()` 등 인접 스펙은 이미 `%`-포맷으로 패딩하는데 `Y`만 누락되어 발생한 일관성 결함이다.
- **수정 요지**: `return '%04d' % self.data.year`로 변경하여 4자리 zero-padding을 강제. docstring도 `"""Year, 4 digits with leading zeros; e.g. '1999'."""`로 의도를 명확화. 반환 타입이 int→str로 바뀌지만, 포맷 출력은 어차피 문자열로 합성되므로 동작이 일관된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_Y_format_year_before_1000` — `dateformat.format(datetime(1, 1, 1), 'Y') == '0001'`, `dateformat.format(datetime(999, 1, 1), 'Y') == '0999'`를 단언.
- **픽스 증명**: 픽스 전에는 year=1 → `'1'`, year=999 → `'999'`가 나와 단언 실패. `'%04d'` 적용 후 각각 `'0001'`, `'0999'`로 통과. 경계의 양끝(최소 자릿수 1, 패딩 경계 999)을 모두 짚는다.
- **regression 관점**: 기존 `test_year_before_1000`이 `Y`와 `y`를 구분하려 `test_y_format_year_before_1000`으로 rename되어 PASS_TO_PASS에 남았다. `y`(2자리) 동작이 안 깨졌음을 보증하는 회귀 가드. 나머지 18개 P2P는 `Y`를 쓰지 않는 인접 포맷이라, 정상 연도(year ≥ 1000)에서 `'%04d'`가 기존 출력과 byte-identical임을 간접 보증한다.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 `overfit-risk` 플래그를 단다. 다만 테스트가 두 경계점(1, 999)을 짚고, `'%04d'`라는 픽스가 입력공간 전체(모든 year < 1000)에 균일하게 일반화되므로 실제 overfit 위험은 낮다. special-case(`if year < 1000:` 분기 같은) 패치였다면 진짜 위험했을 것.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 신호 `django.utils.dateformat.DateFormat` + `Y` specifier → `django/utils/dateformat.py`에서 `def Y(` grep → 단일 메서드. 탐색 비용 거의 0.
2. **픽스와 일반화 근거**: `return self.data.year` → `return '%04d' % self.data.year`. 이게 올바른 일반화인 이유: (a) 인접 메서드 `y()`가 이미 `'%02d' % ...` 패턴을 쓰므로 동일 관용구로 통일 = 코드베이스 일관성. (b) `'%04d'`는 모든 year < 1000을 균일하게 패딩하고 year ≥ 1000은 변형 없이 그대로 두므로(4자리 이상은 `%04d`가 절단/패딩 안 함) **입력공간 전체에 정확**. `if`-분기 special-case가 아니라 단일 포맷식이라 CEGIS식 추가 입력이 필요 없다.
3. **regression 안전**: 깨지 말아야 할 핵심 P2P는 `test_y_format_year_before_1000`(`y` 2자리 유지)과 정상 연도를 쓰는 `test_date`/`test_dateformat`/`test_date_formats` 등이다. `'%04d'`는 year ≥ 1000에서 기존 정수의 str과 동일 출력이라 이들 단언을 흔들지 않는다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) **과도수정**: 인접 `y`/`z`/`r` 스펙까지 건드리거나 year ≥ 10000 같은 비현실 케이스 방어를 추가해 P2P를 흔드는 것. 최소 변경 원칙으로 `Y()` 한 메서드만 손대야 한다. (b) **special-case overfit**: `if self.data.year < 1000:` 분기로 테스트 두 점만 통과시키는 패치는 plausible-but-narrow다. `'%04d'` 단일식이 일반해임을 인지해야 한다. (c) **타입 변화 간과**: int→str 전환이 다른 포맷 합성 경로를 깨지 않는지 잠깐 확인하되, 실제로는 출력이 문자열 합성이라 안전.
