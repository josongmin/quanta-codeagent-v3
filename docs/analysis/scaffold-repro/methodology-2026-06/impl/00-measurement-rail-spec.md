# 00 — 측정레일 구현 스펙 (Best@K / Pass@K 오프라인 K-후보 채점)

**목표.** "이미 디스크에 남은 후보 patch들(`cand-r{round}-i{i}.patch`)을 official 하네스로
**재실행 없이** 오프라인 채점"하는 잡을 우리 grading 경로에 붙이는 정확한 배선 지점을
추측 없이 코드 file:line으로 확정한다. 짝 문서 `00b-bestk-passk-hook-spec.md`가
"어디서 후보가 생성/선택/캡처되나"를 덮으므로, 이 문서는 **채점레일(base+gold 2-tree 여부 +
grade 위임 지점 + 최소 잡 배선)**에 집중한다.

---

## 10줄 요약 (먼저 읽어라)

1. **우리 채점은 stateless 함수다.** `GradeBackend.grade(predictionsPath, opts)` =
   `predictions.jsonl + dataset.jsonl ⇒ swebench report json` (`remote/backend.ts:9-13, 61-64`).
   patch 1개/instance를 넣으면 resolved/unresolved/error/empty id 배열이 나온다.
2. **official 하네스가 fail-to-pass를 대행한다.** 배선은 `ssh.ts:117-129`의
   `run_evaluation --predictions_path ~/preds.jsonl --dataset_name ~/instances.jsonl`.
   하네스가 **dataset의 `FAIL_TO_PASS`/`PASS_TO_PASS`/`base_commit`/`test_patch`를 읽어**
   base에 patch 적용 → test 실행 → resolved 판정을 **내부에서** 한다.
3. **⟹ 우리한텐 base-subtraction(SWT식 base+gold 2-tree)이 채점용으론 필요 없다.**
   candidate를 base·gold 둘 다 돌릴 필요 없음 — 하네스가 base 트리 위 patch-apply를 대행.
   base-subtraction은 **selection용(agent-side validator/oracle)**에만 쓰이고 채점레일과 분리돼 있다.
4. **gold는 채점이 아니라 sanity 게이트다.** `gold-sanity.ts:36-56` `validateGoldPatch`는 gold patch를
   적용해 "gold가 selected verifier 아래 resolve되나"만 확인(측정 신뢰용). Best@K/Pass@K와 무관.
5. **grade.ts는 이미 K-후보 채점 seam이다 — 단일 전용이 아님.** `cmdGrade`(`grade.ts:218-296`)는
   patch 1개가 아니라 **predictions.jsonl(N행) 전체**를 받아 `backend.grade`에 통째로 넘긴다
   (`grade.ts:271-276`). 즉 이미 "patch 리스트 배치 채점"이다. 재사용 지점이 여기다.
6. **하네스 join 키 = `instance_id`.** predictions row는 `{instance_id, model_name_or_path, model_patch}`
   (`dataset.ts:515-518`)이고 하네스가 `instance_id`로 dataset의 FAIL_TO_PASS를 찾는다. 따라서
   후보를 `<id>::r0i1` 같은 합성 id로 한 파일에 섞으면 **하네스가 dataset에서 못 찾아 error**가 된다.
7. **⟹ K-후보 채점의 옳은 형태 = "라운드/후보 슬롯별 predictions.jsonl 여러 벌"** (각 벌은
   real `instance_id` 유지, 1행/instance) → 각 벌을 `backend.grade`에 **순차** 태움. 이러면
   dataset 조작 0, `grade.ts` 경로 100% 재사용, 하네스 계약 불변.
8. **후보 patch는 이미 디스크에 다 있다.** `writeCandidatePool`(`candidate-ledger-sink.ts:18-42`)이
   observe root에 `repair-candidates/<id>/cand-r{round}-i{i}.patch`를 이미 씀. **재실행 불필요** —
   이 patch들을 slot별 predictions로 재조립만 하면 된다.
9. **최소 잡 = 신규 analyze 커맨드 1개**(`src/apps/bench/analyze/bestk-passk-grade.ts`, 신규):
   observe root 스캔 → slot별 predictions 작성(`writePredictions` 재사용) → `buildBackend`+`backend.grade`
   순차 호출(`grade.ts`의 `buildBackend` export 재사용) → 후보별 resolved 집계 → Pass@K/Best@K/gap.
10. **불변식: default-OFF, observe-only, `totals.resolved` 불변, SERIAL·max_workers=1.**
    knob OFF ⇒ 잡 미실행, 제출 여전히 1행/instance, byte-identical. 이 잡은 유저 live bench와
    **동시 금지**(동시 채점 = false-neg, MEMORY). arm64 레시피(prebuilt namespace=swebench) 준수.

---

## 1. 현재 채점 경로 — patch 1개를 어떻게 채점하나

### 1.1 진입점 `cmdGrade` (`src/apps/bench/commands/grade.ts:218-296`)
- `--predictions <p.jsonl> --backend <ec2|ssh:host> --dataset <instances.jsonl>` 받음 (`grade.ts:221-229`).
- `--skip-resolved <prior-report.json>`로 incremental 필터(이미 resolved instance 드롭, `grade.ts:230-261`).
- backend 빌드: `buildBackend(spec, model)` (`grade.ts:264`, export `grade.ts:68-75`) → ec2 | ssh:host |
  fanout(`--shards>1`). `--max-workers N`는 하네스에 verbatim 전달(`grade.ts:34-43`).
- **핵심 위임:** `backend.grade(gradePredictions, { datasetPath, runId, family, outDir })`
  (`grade.ts:271-276`). 반환 = resolved/unresolved/errored/emptyPatch id 배열 + reportPath.

### 1.2 backend 계약 (`src/apps/bench/remote/backend.ts:15-64`)
```
GradeBackend.grade(predictionsPath, opts) : Promise<GradeOutcome>
  # "predictions.jsonl + dataset.jsonl ⇒ swebench report json" (backend.ts:9-13)
GradeOutcome = { reportPath, resolved[], unresolved[], errored[], emptyPatch[], errorLogDir? }
```
- **stateless.** 상태 없음, patch-gen 없음 — 순수 채점. 입력 predictions.jsonl의 **행 수 = 채점 대상 수**
  (1행이든 N행이든 무관). ⟹ **원래부터 리스트 배치 채점기다.**

### 1.3 official 위임 지점 (`src/apps/bench/remote/ssh.ts:102-131`)
- `buildRemoteGradeScript`가 실제 하네스 커맨드 조립:
  `uvx --from swebench python ra_shim.py --predictions_path ~/preds.jsonl --run_id RUNID
   --max_workers N --cache_level instance --namespace swebench --dataset_name ~/instances.jsonl`
  (`ssh.ts:117-129`).
- report 회수·파싱: `parseSwebenchReport`(`backend.ts` 하단, `resolved_ids`/`unresolved_ids`/
  `error_ids`/`empty_patch_ids`) (`ssh.ts:239-247`).
- **fail-to-pass 판정은 전적으로 `run_evaluation` 내부** — 우리는 predictions+dataset만 주고
  resolved 라벨을 받는다.

**요약:** 지금 patch 1개 채점 = "1행짜리 predictions.jsonl을 `backend.grade`에 넘김"의 특수 케이스.
경로 자체는 N행 리스트를 이미 처리한다.

---

## 2. base+gold 2-tree 필요한가 — **아니다(채점용). selection용으로만.**

### 2.1 채점: 하네스가 base-apply를 대행 ⟹ base-subtraction 불요
- `run_evaluation`(`ssh.ts:117-129`)에 넘기는 건 `model_patch` **하나**(`dataset.ts:515-518`).
- 하네스가 `base_commit` 체크아웃 → `model_patch` apply → `test_patch` apply → `FAIL_TO_PASS`/
  `PASS_TO_PASS` 실행 → resolved 판정을 **내부에서** 수행. dataset의 이 필드들이 진실원(`ssh.ts:128`
  `--dataset_name ~/instances.jsonl`).
- ⟹ candidate를 base·gold 두 트리에 돌려 차분낼 이유 없음. **SWT식 base-subtraction은 우리 채점레일에
  불필요**하고, 실제로 우리 경로엔 없다. (SWT는 docker-free지만 base+gold 2-tree를 스스로 돌려야 해서
  base-subtraction이 필요했던 것 — 우리는 official harness를 위임하므로 그 부담이 하네스에 있다.)

### 2.2 selection: agent-side validator/oracle에만 base 개념 존재 (채점 아님)
- repair breadth의 후보 validator는 **no-leak** — `FAIL_TO_PASS`/`test_patch`/official report를
  구조적으로 못 봄(`repair/types.ts:166-169`). exit-code/repro-consensus로만 후보 간 순위(=Best@K 선택).
- 이건 selection 신호이지 official resolved가 **아니다**(`candidate-ledger.ts:29-33`). Pass@K를
  못 준다(정답지 아님) — 바로 그래서 official 오프라인 채점이 필요.

### 2.3 gold = sanity 게이트 (측정 신뢰용, Best@K/Pass@K 무관)
- `validateGoldPatch`(`gold-sanity.ts:36-56`): gold patch 적용 후 selected verifier 아래 resolve
  확인. gold가 unresolve면 그 instance의 측정 자체가 무효(측정레일 버그 격리; jul-01 truncated-P2P가
  정확히 이걸로 잡혔음, MEMORY). **채점 파이프라인이 아니라 채점 신뢰성 게이트.**

**결론(맥락 질문 직답):** base-subtraction은 우리한텐 **selection 신호(no-leak validator)**로만 존재하고,
**채점(resolved 판정)은 official harness가 base-apply까지 전부 대행**한다. 따라서 Best@K/Pass@K
오프라인 잡은 base+gold 2-tree를 스스로 돌릴 필요 없이, **후보 patch를 harness에 그대로 위임**하면 된다.

---

## 3. 오프라인 K-후보 채점 가능성 — 재사용 지점

**가능하다. `grade.ts`가 이미 리스트 채점기이므로 신규 채점 로직 0.** 재조립만 신규.

### 3.1 재사용 자산 (신규 코드 없음)
| 자산 | file:line | 역할 |
|---|---|---|
| 후보 patch 파일 | `candidate-ledger-sink.ts:39-41` (`cand-r{round}-i{i}.patch`) | 이미 디스크에 있음 |
| sink 배선(observe root 있을 때만) | `driver/repair-phase.ts:111-121` | default-OFF면 미배선=byte-identical |
| predictions 작성기 | `dataset.ts:521-526` `writePredictions` | slot별 preds.jsonl 생성 |
| backend 빌더 | `grade.ts:68-75` `buildBackend` (export됨) | ec2\|ssh\|fanout |
| 채점 함수 | `backend.ts:61-64` `GradeBackend.grade` | official 위임, resolved 반환 |
| report 파서 | `backend.ts` `parseSwebenchReport` | resolved_ids 등 |

### 3.2 하네스 join 제약 — slot별 predictions "여러 벌"이 옳은 형태
- 하네스는 predictions row의 `instance_id`로 dataset의 FAIL_TO_PASS를 찾음(`ssh.ts:128`).
  ⟹ `<id>::r0i1` 합성 id를 **한 파일에 섞으면 dataset 미스매치 → error_ids로 샘**.
- **옳은 형태:** 후보 슬롯 `(round r, index i)`마다 predictions.jsonl **한 벌**을 만든다. 각 벌은
  해당 instance의 real `instance_id` + 그 슬롯의 후보 patch를 담아 **1행/instance**. 여러 instance를
  같은 슬롯 벌에 모아도 됨(instance마다 real id라 충돌 없음).
- 슬롯 벌 개수 = max(round×index) 조합 수 ≈ K. 각 벌을 `backend.grade`에 **순차** 태움 ⟹ 후보별 resolved.
  - dataset은 **원본 그대로** 재사용(조작 0). 하네스 계약 불변.

---

## 4. 최소 구현 스펙 (file:line, default-OFF, serial, max_workers=1)

### (A) 후보 pool patch 캡처 — 이미 존재, 재사용
- `candidate-ledger-sink.ts:39-41` — `cand-r{round}-i{i}.patch` 이미 씀.
- 활성 조건: observe root(`reproArtifactRootPath`, `repair-phase.ts:111`) + `QUANTA_BENCH_REPAIR_BREADTH>1`.
- (선택) winner 표기: `candidate-ledger.ts:20-42, 81-105`에 `adopted?: boolean` 추가 — 또는 잡이
  최종 제출 patch와 대조해 Best@K를 역산(배선 최소, 권장).

### (B) 오프라인 K-후보 채점 잡 — **신규 1파일**
- **신규:** `src/apps/bench/analyze/bestk-passk-grade.ts` (analyze 계열, `commands/`·`analyze/` 옆).
- 커맨드 표면: `quanta-bench analyze bestk-passk --observe-root <dir> --dataset <instances.jsonl>
  --backend <ec2|ssh:host> [--max-workers 1]`.
- 알고리즘:
  1. `<observe-root>/repair-candidates/<id>/cand-r*-i*.patch` 글롭 → `{id → slot(r,i) → patch}` 맵.
  2. 슬롯별로 `Prediction[]`(instance마다 real id + 그 슬롯 patch) 조립 → `writePredictions`
     (`dataset.ts:523`)로 임시 `preds-slot-r{r}i{i}.jsonl`.
  3. `buildBackend(spec, model)` (`grade.ts:68`) 1회 → 슬롯 벌들을 **순차**로 `backend.grade(prefFile,
     { datasetPath, runId:`bestk-r{r}i{i}`, family })` (`backend.ts:61`). ⚠️ **SERIAL** — 절대 병렬 금지
     (MEMORY: 동시 채점=false-neg). `maxWorkers` 미지정 시 **1로 강제**(arm64 안전, `grade.ts:34-43`).
  4. instance별 집계: `passK = OR(모든 슬롯 resolved)`, `bestK = (제출 patch == adopted 슬롯) resolved`,
     `gap = passK − bestK`.
- 재사용: 채점/파싱/하네스 위임은 (A)/`backend.grade`/`parseSwebenchReport` 그대로. **신규는 글롭+재조립+집계뿐.**

### (C) report 직렬화 — 신규 observe 필드
- `src/runner/batch/report.ts` — 기존 observe-only 필드(`gradeBreakdown` `report.ts:129`,
  `report.ts:126-142` observe 블록) 옆에:
  ```ts
  /** observe-ONLY: Best@K vs Pass@K 갭. 오프라인 후보-전량 채점 잡이 채움.
   *  totals.resolved(=Best@K/제출)와 무관, 점수 불변. 없으면 byte-identical. */
  readonly bestKPassKGap?: {
    readonly k: number
    readonly passK: number   // K개 중 official resolved instance 수(천장)
    readonly bestK: number   // verifier 선택이 official resolved instance 수(≡ totals.resolved)
    readonly gap: number     // passK − bestK ("만들고도 못 고른" 수)
  }
  ```
- sanity assert: `bestK ≡ totals.resolved` (다르면 잡/제출 불일치 = 버그).

### (D) knob — 신규, default-OFF
- `src/runner/batch/eval/knobs-bench.ts` (기존 knob 패턴, MEMORY: KnobSchema SSOT `config/knob-schema`).
- `QUANTA_BENCH_BESTK_PASSK` (default-OFF). OFF ⇒ (B)/(C) 미실행, 제출 1행/instance, byte-identical.

### 배선 요약 (3지점 신규, 나머지 재사용)
| 단계 | 파일:line | 신규/재사용 |
|---|---|---|
| 후보 patch 캡처 | `candidate-ledger-sink.ts:39-41` | 재사용 |
| winner(adopted) 표기 or 역산 | `candidate-ledger.ts:20-42,81-105` (선택) | 소폭 신규(선택) |
| 슬롯별 predictions 재조립 | `dataset.ts:521-526` `writePredictions` | 재사용 |
| backend 빌드+순차 채점 | `grade.ts:68-75` `buildBackend` + `backend.ts:61-64` `grade` | 재사용 |
| **오프라인 잡(글롭+집계)** | `src/apps/bench/analyze/bestk-passk-grade.ts` | **신규** |
| report 필드 `bestKPassKGap` | `report.ts:126-142` 옆 | 신규 |
| knob `QUANTA_BENCH_BESTK_PASSK` | `knobs-bench.ts` | 신규, default-OFF |

**불변식:** knob OFF ⇒ 잡 미실행, prediction 1행/instance, `totals.resolved`·제출 경로 byte-identical.
K-후보 채점은 opt-in 오프라인 잡이 후보 patch를 **사후** 채점할 때만. **SERIAL, max_workers=1, 유저 live
bench와 동시 금지.**

---

## 부록 — 검증한 파일 (file:line)

- 채점 진입점: `src/apps/bench/commands/grade.ts:218-296` (`cmdGrade`), `:68-75` (`buildBackend`),
  `:271-276` (grade 위임), `:34-43` (max-workers verbatim).
- backend 계약: `src/apps/bench/remote/backend.ts:9-13, 15-64` (`GradeBackend`/`GradeOutcome`/stateless),
  `parseSwebenchReport`(하단).
- official 위임: `src/apps/bench/remote/ssh.ts:102-131` (`buildRemoteGradeScript`,
  `--predictions_path`+`--dataset_name`), `:171,239-247` (grade fn + report 파싱).
- prediction/predictions: `src/runner/batch/corpus/dataset.ts:515-518` (`Prediction`, join 키=instance_id),
  `:521-526` (`writePredictions`).
- gold-sanity(채점 아님): `src/runner/batch/eval/gold-sanity.ts:36-56` (`validateGoldPatch`).
- validator no-leak(selection용, official 아님): `src/runner/batch/eval/repair/types.ts:166-169`;
  `candidate-ledger.ts:29-33`.
- 후보 patch 캡처: `src/runner/batch/eval/repair/candidate-ledger-sink.ts:18-42` (`writeCandidatePool`,
  `:39-41` `.patch` 파일); 배선 `src/runner/batch/eval/driver/repair-phase.ts:111-121`.
- report observe 필드: `src/runner/batch/report.ts:126-142`.
- 짝 문서(후보 생성/선택 상세): `docs/analysis/scaffold-repro/methodology-2026-06/impl/00b-bestk-passk-hook-spec.md`.
