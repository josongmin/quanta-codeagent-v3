# SWE-bench E-tier 미스 RCA (gpt-5.4, agentless-v2, full-remote)

풀 = easy-untried E-tier(#≥14 프론티어 해결 = **천장 아님·회복가능**). graded & **unresolved 12건**.
(스캐폴드 매트릭스 134 전수에 이 12개 미포함 = ceiling-32도 아니고 표시 17-arm 컬럼에도 없는 "보통" 인스턴스 → 회복가능 확정.)

## 정정된 헤드라인 (closure-diagnostics 실측 기준)

**기존 "RIGHT-FILE-WRONG-FIX 9 · WRONG-FILE 2 · EMPTY 1 → 병목=fix 정확성(localize 아님)"은 근거가 diff-추측이라 약했고 부분적으로만 맞다.** closure-diagnostics(`bench/full-remote/closure-i-{0caa…,0cd6…,030515…}.json`)로 확정:

- **owner localize는 이미 ~92% 해결** — `owner_recall@1` 0.85~1.0, `first_edit_owner_match` 0.92~1.0, `stray_file_rate` 0 (3 wave). → 이 set엔 localize 추가투자 헤드룸 거의 없음. STRATEGY.md의 P0/P1(빈도 기준 최우선)은 이 회복가능 set에선 적용 안 됨(헤드룸은 P2/P3).
- **지배 실패 = `model_miss`** = 올바른 파일·owner 찍고 repro RED까지 띄운 뒤 **패치가 틀림**. `repro_red_but_unresolved_rate` = 0.18~0.33 (= closure-repair가 net-negative였던 원인인 repro-oracle false-negative 시그니처).
- 정확한 3분류: **file-level localize 성공 후 owner/fix 실패 9 + owner/file localize 실패 3(wrong-file 2 + empty 1) + grader-validity 별도 1(sphinx-9711)**.

### closure 실측 (per-instance)

| inst | term | turns | class | ownerHit | gold f/h | F2P/P2P | family |
|---|---|--:|---|:--:|---|---|---|
| 11951 | completed_unresolved | 24 | model_miss | ✅ | 1/1 | 1/21 | wrong-generalization (`else None`; issue가 정답식 줌) |
| 12039 | completed_unresolved | 25 | model_miss | ✅ | 1/2 | 1/11 | sibling-coverage (IndexColumns만, base Columns 누락) |
| 14311 | completed_unresolved | 27 | model_miss | ✅ | 1/1 | 1/59 | paired-regression (`.name` → package `__main__` 회귀) |
| 13121 | completed_unresolved | 39 | model_miss | ✅ | **4/9** | 1/168 | multi-site design-delete를 expressions.py 1조건으로 축소 |
| 12754 | max_turns | 60 | model_miss | ✅ | 1/1 | 1/112 | owner/lifecycle within-file |
| 13128 | max_turns | 60 | model_miss | ✅ | 1/3 | **7**/134 | wrong-condition, hard(1-4h) |
| 14017 | max_turns | 60 | model_miss | ✅ | 1/1 | 2/147 | wrong-structure (Q-wrap vs allow-through) |
| 14351 | max_turns | 60 | model_miss | ❌ | 1/1 | 1/58 | **wrong-file** (related_lookups.py vs gold lookups.py) |
| 12965 | max_turns | 60 | model_miss | ❌ | 1/1 | 1/52 | **wrong-file** (mysql/features.py vs gold sql/compiler.py) |
| 13964 | max_turns | 60 | empty_patch_other | ⬜ | 1/1 | 1/36 | **empty** (edit 후 빈손 복귀; no-patch breaker가 salvage 못 함; gold=L0 1줄 base.py) |
| sympy-24066 | (earlier) | — | — | ✅file | 1/1 | 1/30 | semantic-normalization wrong-fix |
| sphinx-9711 | (earlier) | — | — | ✅file | 1/2 | 1/0 | wrong-fix(InvalidVersion fallback 누락) — **단 grader-validity 오염** |

> ⚠️ trajectory(턴별 풀이로그)는 mining wave에서 미기록(`QUANTA_BENCH_RECORD_TRAJECTORY` off default). 풀이 추적엔 wave 스트림 로그(`sweep-eclassN.log`)서 인스턴스ID grep + 아래 인라인 패치 대조. wired vs **engaged** 분리는 M0 재런으로.
> ⚠️ sphinx-9711: 현 report상 gold patch가 selected verifier에서 미해결 → **clean grading proof 아님**. resolved-rate denominator에서 분리, grader-validity부터 재검.

## 구조 원인 (코드)

- **FaultEvidencePacket가 path/score/symbol name만** 담음 ([types.ts:6](src/agent/fault-evidence/types.ts#L6) "never raw source bodies", [build.ts:43](src/agent/fault-evidence/build.ts#L43) = stage1/issue-file/owner-resolve 점수 merge만). → sibling method·donor pattern·caller/ref·adjacent negative case가 prompt/gate authority로 못 올라옴.
- **agentless-v2는 closure knob은 켜도 closure-repair executor는 의도적 제외** ([presets.ts:108](src/runner/knobs/presets.ts#L108)). plan/rail telemetry ≠ 실제 finish blocking. driver도 split 명시 ([driver.ts:798](src/apps/bench/eval/driver.ts#L798)). closure-repair는 측정상 net-negative(9→7)였고 원인 = **repro oracle false-negative**(맞는 fix를 reproduced로 읽어 repair churn) → reprovote의 K-of-N resolved vote가 이걸 겨냥.
- repair loop의 typed predicate mismatch는 아직 observe/advisory ([repair/index.ts:79](src/runner/batch/eval/repair/index.ts#L79)) → 짧은 wrong-fix를 막는 "done 전 paired-control proof"로 부족.

## 조질 계획 (reprovote=SOTA floor 위에 적층)

reprovote = `agentless-v2` + `closure-repair:3` + `repro-vote:1`. 이게 false-neg oracle 한 겹만 벗김 → 이 set의 잔여(wrong-generalization·coverage·structure)는 **evidence v2 + paired-control**이 정조준.

### arm 매트릭스 (각 arm = 독립 preset; boolean env로 preset-ON knob OFF 불가 → 별도 preset 필수)

| arm | preset | reprovote 대비 추가 | 단일변수 |
|---|---|---|---|
| A0 | `agentless-v2-reprovote` | — (frozen floor) | control |
| A1 | `…-reprovote-evidence` | `fault-evidence:2` (bounded 본문) | 증거본문 효과 |
| A2 | `…-reprovote-paired` | `paired-control:1` (신규) | done-blocking proof 효과 |
| A3 | `…-reprovote-evidence-paired` | 둘 다 | v3 후보 |
| A4 | `…-reprovote-rescue` | `no-patch-rescue` (신규) | empty 구제 |

신규 knob:
- `fault-evidence:2` — v1 path/score/symbol → **bounded** ownerSnippet·siblingPatterns·callerRefs·donorPatterns·adjacentControls. raw-blob 금지·line-window cap(deterministic).
- `paired-control:1` — done 전 case-class별 **public issue/repo 유래** paired test 생성, **base-red 증명(vacuous-green 가드)** 후 required. self-critique 불가, hidden F2P/P2P label authority 금지.
- `no-patch-rescue` — high-confidence owner인데 empty면 제출 금지 → bounded rescue, 실패 시 `no_patch_exhausted` verdict 분리(resolved 오염 금지).

### case → arm 라우팅 (기대 flip)

- owner맞음·fix틀림 (A1/A2 정조준): **11951**(A2 max-cap 보존 / A1 issue 정답식), **12039**(A1 donor `Columns.col_str` / A2 DESC+opclass empty-suffix), **14311**(A2 module `foo.bar.baz`+package `foo.bar.__main__`), **14017**(A2 Exists&Q↔Q&Exists), **sympy-24066**(A1 donor / A2 dimensionless control).
- right-file thrash (A0 reprovote 단독이 false-neg 해소로 푸는지 = M0 핵심 관찰): **12754, 13128, 14017**. 13128은 F2P=7·1-4h라 기대 낮춤.
- **이 arm으로 안 잡힘 → 별도 트랙 (denominator 분리)**: **12965, 14351** wrong-file(exec-trace/call-graph SCG localize; owner-symbol admission 없으면 false-green), **13964** empty(A4), **sphinx-9711** grader-validity 재검.

### 측정 / 통과 게이트 (이미 도는 closure rail)

북극성 = **resolved**(공식 x86 harness, `report.json`+patch artifact 필수 — "full-remote done"·empty fail list는 증거 아님) + `repro_red_but_unresolved_rate ↓`.

| 게이트 | 기준 |
|---|---|
| resolved (12 set) | A1/A2/A3 > A0 |
| repro_red_but_unresolved | ↓ |
| 비용 | `verify_rounds_per_run`·repair rounds 폭증 금지(closure-repair churn 재발 방지) |
| empty | no empty patch, `no_patch_exhausted` 분리 |
| owner-symbol (신규 M3) | `owner_symbol_match`·`first_edit_owner_symbol_match`·`line_window@50` — 없으면 wrong-file false-green |
| grader | sphinx-9711 gold 재채점 clean 전까지 제외 |

⚠️ `primary_false_red_rate`는 vote arm 간 **비교 금지**(vote가 observed 안 냄 = 구조적 0).

### 시퀀스

- **M0 (먼저, engage-proof / 유저 트리거)**: 12개만 `QUANTA_BENCH_RECORD_TRAJECTORY=1` + `--preset agentless-v2-reprovote` 재런. 확인: LSP/tool 실호출·first-edit owner·final verify·primary rail present·**gate entered**(지난 run 전부 null = wired≠engages 의심)·empty-patch path. reprovote가 churn하면 **oracle부터** 고치고 A1/A2 보류.
- **M1**: 이 doc 정정 (← 완료).
- **M2**: `fault-evidence:2` (bounded typed evidence) — 12039·11951·14311·sympy-24066·sphinx 정조준.
- **M3**: owner-symbol admission + metric — 12965·14351·12754·13128 false-green 차단.
- **M4**: paired-control verification(done-blocking, public-derived only).
- **M5**: empty-patch fail-safe(13964; L0 1-line empty를 resolved에 안 섞음).
- **M6**: repair executor default-on 금지 — A0/A1/A2/A3/A4 12-case A/B로만. 통과 = resolved↑·repair rounds↓·no empty·grader clean.

### 적대 가드

- closure-repair net-positive 조건 = oracle이 reproduced→resolved를 신뢰성 있게 flip. reprovote가 그 주장인데 **미측정** → M0가 선증명. 안 되면 oracle 수리 선행.
- paired-control = public 유래 only(hidden label authority = STRATEGY heuristic-boundary 위반). base-red 후 required(vacuous-green 차단).
- n=12 = diagnostic A/B지 leaderboard 주장 아님. 500 일반화 금지. "improved" 주장 전 적대 어딧 ≥3.
- v1/v2/reprovote in-place 금지 — 신규 동작은 전부 신규 preset.

## M0 결과 — reprovote 12-case 재런 (2026-06-20, `closure-i-09d2d976ae56b6f9f`)

`--preset agentless-v2-reprovote` + trajectory, 12-case. **이전 agentless-v2에서 0/12 → reprovote 5/11 resolved**(sphinx-9711 grader_invalid 제외). engage 결정적.

### reprovote는 engage한다 (theater/churn 아님)
- `gate_enter_rate=1.0`·`gate_bypass_rate=0` (지난 run 전부 null이던 게 채워짐 = 게이트 100% 발화)
- `verify_rounds_per_run=2.875` (max churn 아님), `primary_false_green=0`·`primary_false_red=0` (oracle 오플래그 0)
- **flip 5건**: 11951(else None→고침)·12039(sibling)·12754(60t thrash였음)·13964(empty였음)·14311(.name 회귀). repair-loop+vote가 실제로 정답 attempt를 선택.
- ⟹ doc 기존 가정("reprovote는 false-neg 한 겹만 벗김")은 **틀림**: false_red=0 = 벗길 false-neg 자체가 없었고, 승리는 repair 시도수↑ + vote 선택.

### 🔴 신규 버그 — `__repro_*.py` leak (= `multi_file_drift`의 정체)
repair/verify loop가 디스크에 쓴 재현 스크립트가 **model_patch에 새 파일로 샌다**(patch-hygiene:1 ON인데 strip 안 함). 실측:
- 12039 PASS = 18파일 중 **16개 `__repro_*.py`** + gold(ddl_references.py)✅ + indexes.py stray. 13128=20 repro leak, 12965=16, 14017=12.
- ⟹ `owner_recall@1` 0.92→**0.27 폭락은 artifact**: repro 파일이 file 목록 오염 → first-edit=repro파일 → ownerHit=False (resolved인데도). 실제 gold-file hit는 graded 전부 ✅(14351 제외).
- ⟹ `multi_file_drift=5`도 대부분 이 leak + 소수 real stray(deprecation.py/indexes.py/expressions.py).
- **이건 leaderboard 제출 hygiene로도 치명**(스크래치 16파일 동봉).
- ✅ **이미 픽스됨** — `83663bc6`(2026-06-20 03:24, `REPRO_SCAFFOLD_RE` in snapshot.ts `sourceOnlyDiff`, `reproduce_issue.py`+`__repro_*`까지 strip). M0(02:21)는 이 픽스 **이전** stale main이라 leak이 보인 것. 03:24 이후 모든 wave는 clean. (재채점 시 leak-mislabel 사라짐 예상 — 미검증, sweep 결과가 그 검증.)

### 잔여 타겟 (hygiene 픽스 후 재채점 전제)
- **14351** — 유일 잔여 wrong-FILE (related_lookups.py vs gold lookups.py) → owner-symbol/exec-trace localize.
- **12965** — reprovote가 **right-file(compiler.py)로 이동**시켰으나 wrong-fix + deprecation.py drift → fix-synthesis.
- **13128·14017·sympy-24066** — right-file, wrong-fix (hard synthesis; 13128 F2P=7·1-4h).
- **13121** — wrong-patch→**EMPTY 퇴행**(reprovote가 4-file 멀티사이트서 churn하다 빈손) → M5 empty-floor가 정조준(reprovote-유발 회귀).
- **sphinx-9711** — grader_invalid, denominator 제외(doc 기존 플래그 확인됨).

### 우선순위 재정렬 (M0 기준)
1. **patch-hygiene repro-strip** (cheap·high-ROI: 패치정화 + multi_file_drift 오분류 제거 + owner metric 복원 + 제출 hygiene). → **재채점**으로 clean verdict/metric 확보.
2. **M5 empty-floor** — 13121 reprovote-유발 회귀 salvage.
3. **M3 owner-symbol** — 14351 + 메트릭 신뢰성(파일단위는 repair drift로 깨짐 확정).
4. **M2/M4(evidence/paired) 강등** — reprovote vote가 "done前 verify" 역할 이미 수행(easy/medium flip). 잔여는 happy-path-overfit 아니라 hard-synthesis+localize 1건 → 기대수율 낮음. hygiene+재채점 후 재평가.

---

## django__django-11951  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  bulk_create batch_size param overrides the compatible batch size calculation
  Description
  	 
  		(last modified by Ahmet Kucuk)
  	 
  At this line: ​https://github.com/django/django/blob/stable/2.2.x/django/db/models/query.py#L1197
  batch_size param overrides compatible batch size calculation. This looks like a bug as bulk_update properly picks the minimum of two:
  ​https://github.com/django/django/blob/stable/2.2.x/django/db/models/query.py#L504
  I suggest using similar
   batch_size = min(batch_size, max_batch_size) if batch_size else max_batch_size
  logic in bulk_create as well. I am happy to open a PR for it.
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass4.log`  ← `grep django__django-11951 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass4.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0caa5141ee7f1f946.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0caa5141ee7f1f946.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/models/query.py b/django/db/models/query.py
  index 794e0faae7..09ea40e113 100644
  --- a/django/db/models/query.py
  +++ b/django/db/models/query.py
  @@ -470,6 +470,7 @@ class QuerySet:
           opts = self.model._meta
           fields = opts.concrete_fields
           objs = list(objs)
  +        batch_size = min(batch_size, connection.ops.bulk_batch_size(fields, objs)) if batch_size else None
           self._populate_pk_values(objs)
           with transaction.atomic(using=self.db, savepoint=False):
               objs_with_pk, objs_without_pk = partition(lambda o: o.pk is None, objs)
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/models/query.py b/django/db/models/query.py
  --- a/django/db/models/query.py
  +++ b/django/db/models/query.py
  @@ -1209,7 +1209,8 @@ def _batched_insert(self, objs, fields, batch_size, ignore_conflicts=False):
           if ignore_conflicts and not connections[self.db].features.supports_ignore_conflicts:
               raise NotSupportedError('This database backend does not support ignoring conflicts.')
           ops = connections[self.db].ops
  -        batch_size = (batch_size or max(ops.bulk_batch_size(fields, objs), 1))
  +        max_batch_size = max(ops.bulk_batch_size(fields, objs), 1)
  +        batch_size = min(batch_size, max_batch_size) if batch_size else max_batch_size
           inserted_rows = []
           bulk_return = connections[self.db].features.can_return_rows_from_bulk_insert
           for item in [objs[i:i + batch_size] for i in range(0, len(objs), batch_size)]:
  ```

## django__django-12039  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  Use proper whitespace in CREATE INDEX statements
  Description
  	 
  		(last modified by Hannes Ljungberg)
  	 
  Creating an index through:
  index = Index(
  	fields=['-name’],
  	name='idx'
  )
  Will generate the valid but not so pretty CREATE INDEX statement: 
  CREATE INDEX "idx" ON "schema_author" ("name"DESC)
  The following would be expected:
  CREATE INDEX "idx" ON "schema_author" ("name" DESC)
  This was partially fixed for indexes using opclasses in https://code.djangoproject.com/ticket/30903#ticket but it introduced a new quirk when opclasses is used without explicit ordering:
  index = Index(
  	fields=['name’],
  	name='idx'
  	opclasses=['text_pattern_ops’]
  )
  Will result in:
  CREATE INDEX "idx" ON "schema_autho
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass4.log`  ← `grep django__django-12039 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass4.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0caa5141ee7f1f946.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0caa5141ee7f1f946.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/backends/ddl_references.py b/django/db/backends/ddl_references.py
  index 44e49806f8..bc3ece61f3 100644
  --- a/django/db/backends/ddl_references.py
  +++ b/django/db/backends/ddl_references.py
  @@ -114,9 +114,11 @@ class IndexColumns(Columns):
               # length as self.columns.
               col = '{} {}'.format(self.quote_name(column), self.opclasses[idx])
               try:
  -                col = '{} {}'.format(col, self.col_suffixes[idx])
  +                suffix = self.col_suffixes[idx]
               except IndexError:
  -                pass
  +                suffix = ''
  +            if suffix:
  +                col = '{} {}'.format(col, suffix)
               return col
   
           return ', '.join(col_str(column, idx) for idx, column in enumerate(self.columns))
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/backends/ddl_references.py b/django/db/backends/ddl_references.py
  --- a/django/db/backends/ddl_references.py
  +++ b/django/db/backends/ddl_references.py
  @@ -83,10 +83,14 @@ def __init__(self, table, columns, quote_name, col_suffixes=()):
   
       def __str__(self):
           def col_str(column, idx):
  +            col = self.quote_name(column)
               try:
  -                return self.quote_name(column) + self.col_suffixes[idx]
  +                suffix = self.col_suffixes[idx]
  +                if suffix:
  +                    col = '{} {}'.format(col, suffix)
               except IndexError:
  -                return self.quote_name(column)
  +                pass
  +            return col
   
           return ', '.join(col_str(column, idx) for idx, column in enumerate(self.columns))
   
  @@ -114,7 +118,9 @@ def col_str(column, idx):
               # length as self.columns.
         
  ```

## django__django-12754  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  FieldError when migrating field to new model subclass.
  Description
  	
  Analogous to #21890. If creating a model subclass and moving a field onto it in the same step, makemigrations works but migrate dies with django.core.exceptions.FieldError: Local field 'title' in class 'Book' clashes with field of the same name from base class 'Readable'.
  For example, take this model:
  from django.db import models
  class Readable(models.Model):
  	title = models.CharField(max_length=200)
  And change to this:
  from django.db import models
  class Readable(models.Model):
  	pass
  class Book(Readable):
  	title = models.CharField(max_length=200)
  The migration generates with CreateModel for Book, then RemoveField for Readab
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`  ← `grep django__django-12754 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0cd6758826892f79a.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0cd6758826892f79a.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/migrations/autodetector.py b/django/db/migrations/autodetector.py
  index 30616c0172..a7e3fc92f7 100644
  --- a/django/db/migrations/autodetector.py
  +++ b/django/db/migrations/autodetector.py
  @@ -888,19 +888,29 @@ class MigrationAutodetector:
               self._generate_removed_field(app_label, model_name, field_name)
   
       def _generate_removed_field(self, app_label, model_name, field_name):
  +        dependencies = [
  +            # We might need to depend on the removal of an
  +            # order_with_respect_to or index/unique_together operation;
  +            # this is safely ignored if there isn't one
  +            (app_label, model_name, field_name, "order_wrt_unset"),
  +            (app_label, model_name, field_name, "foo_together_change"),
  +        ]
  +        removed_field = self.old_apps.get_model(app_label, model_name)._meta.get_field(field_name)
  +        for re
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/migrations/autodetector.py b/django/db/migrations/autodetector.py
  --- a/django/db/migrations/autodetector.py
  +++ b/django/db/migrations/autodetector.py
  @@ -563,6 +563,16 @@ def generate_created_models(self):
                   if isinstance(base, str) and "." in base:
                       base_app_label, base_name = base.split(".", 1)
                       dependencies.append((base_app_label, base_name, None, True))
  +                    # Depend on the removal of base fields if the new model has
  +                    # a field with the same name.
  +                    old_base_model_state = self.from_state.models.get((base_app_label, base_name))
  +                    new_base_model_state = self.to_state.models.get((base_app_label, base_name))
  +                    if old_base_model_state and new_base_model_state:
  +                        removed_base_fields = set(old_base
  ```

## django__django-12965  (WRONG-FILE)
- repo `django/django`
- **문제설명**:
  ```
  Model.objects.all().delete() subquery usage performance regression
  Description
  	
  Lock tests are failing with Django-MySQL on Django 3.1: ​https://github.com/adamchainz/django-mysql/pull/660 .
  The tests run Model.objects.all().delete().
  Django 3.0 generates this SQL:
  DELETE FROM `testapp_alphabet`
  Django 3.1 generates this SQL:
  DELETE FROM `testapp_alphabet` WHERE `testapp_alphabet`.`id` IN (SELECT `testapp_alphabet`.`id` FROM `testapp_alphabet`)
  The subquery is a blocker for using LOCK TABLES along with delete() - as per ​the mysql docs:
  You cannot refer to a locked table multiple times in a single query using the same name. Use aliases instead, and obtain a separate lock for the table and e
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`  ← `grep django__django-12965 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0cd6758826892f79a.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0cd6758826892f79a.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/backends/mysql/features.py b/django/db/backends/mysql/features.py
  index 499c303d9e..4e1679415a 100644
  --- a/django/db/backends/mysql/features.py
  +++ b/django/db/backends/mysql/features.py
  @@ -65,6 +65,8 @@ class DatabaseFeatures(BaseDatabaseFeatures):
       def update_can_self_select(self):
           return self.connection.mysql_is_mariadb and self.connection.mysql_version >= (10, 3, 2)
   
  +    delete_can_self_reference_subquery = False
  +
       @cached_property
       def can_introspect_foreign_keys(self):
           "Confirm support for introspected foreign keys"
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/models/sql/compiler.py b/django/db/models/sql/compiler.py
  --- a/django/db/models/sql/compiler.py
  +++ b/django/db/models/sql/compiler.py
  @@ -1407,6 +1407,8 @@ def execute_sql(self, returning_fields=None):
   class SQLDeleteCompiler(SQLCompiler):
       @cached_property
       def single_alias(self):
  +        # Ensure base table is in aliases.
  +        self.query.get_initial_alias()
           return sum(self.query.alias_refcount[t] > 0 for t in self.query.alias_map) == 1
   
       def _as_sql(self, query):
  ```

## django__django-13121  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  durations-only expressions doesn't work on SQLite and MySQL
  Description
  	
  class Experiment(models.Model):
  	estimated_time = models.DurationField()
  list(Experiment.objects.annotate(duration=F('estimated_time') + datime.timedelta(1)))
  Traceback (most recent call last):
   File "/home/sergey/dev/django/tests/expressions/tests.py", line 1218, in test_duration_expressions
  	list(Experiment.objects.annotate(duration=F('estimated_time') + delta))
   File "/home/sergey/dev/django/django/db/models/query.py", line 269, in __iter__
  	self._fetch_all()
   File "/home/sergey/dev/django/django/db/models/query.py", line 1172, in _fetch_all
  	self._result_cache = list(self._iterable_class(self))
   File "/home/sergey/
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`  ← `grep django__django-13121 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0cd6758826892f79a.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0cd6758826892f79a.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/models/expressions.py b/django/db/models/expressions.py
  index a156c5e881..894f8dea4e 100644
  --- a/django/db/models/expressions.py
  +++ b/django/db/models/expressions.py
  @@ -450,8 +450,9 @@ class CombinedExpression(SQLiteNumericMixin, Expression):
           except FieldError:
               rhs_output = None
           if (not connection.features.has_native_duration_field and
  -                ((lhs_output and lhs_output.get_internal_type() == 'DurationField') or
  -                 (rhs_output and rhs_output.get_internal_type() == 'DurationField'))):
  +                lhs_output and rhs_output and
  +                lhs_output.get_internal_type() == 'DurationField' and
  +                rhs_output.get_internal_type() == 'DurationField'):
               return DurationExpression(self.lhs, self.connector, self.rhs).as_sql(compiler, connection)
           if (lhs_output and rhs_output
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/backends/base/operations.py b/django/db/backends/base/operations.py
  --- a/django/db/backends/base/operations.py
  +++ b/django/db/backends/base/operations.py
  @@ -99,12 +99,6 @@ def date_extract_sql(self, lookup_type, field_name):
           """
           raise NotImplementedError('subclasses of BaseDatabaseOperations may require a date_extract_sql() method')
   
  -    def date_interval_sql(self, timedelta):
  -        """
  -        Implement the date interval functionality for expressions.
  -        """
  -        raise NotImplementedError('subclasses of BaseDatabaseOperations may require a date_interval_sql() method')
  -
       def date_trunc_sql(self, lookup_type, field_name):
           """
           Given a lookup_type of 'year', 'month', or 'day', return the SQL that
  diff --git a/django/db/backends/mysql/operations.py b/django/db/backends/mysql/operations.py
  --- a/django/db/backe
  ```

## django__django-13128  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  make temporal subtraction work without ExpressionWrapper
  Description
  	
  class Experiment(models.Model):
  	start = models.DateTimeField()
  	end = models.DateTimeField()
  Experiment.objects.annotate(
  	delta=F('end') - F('start') + Value(datetime.timedelta(), output_field=DurationField())
  )
  This gives:
  django.core.exceptions.FieldError: Expression contains mixed types: DateTimeField, DurationField. You must set output_field.
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`  ← `grep django__django-13128 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass5.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0cd6758826892f79a.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0cd6758826892f79a.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/models/expressions.py b/django/db/models/expressions.py
  index d913658291..0608e0fcc3 100644
  --- a/django/db/models/expressions.py
  +++ b/django/db/models/expressions.py
  @@ -478,6 +478,18 @@ class CombinedExpression(SQLiteNumericMixin, Expression):
           c.is_summary = summarize
           c.lhs = c.lhs.resolve_expression(query, allow_joins, reuse, summarize, for_save)
           c.rhs = c.rhs.resolve_expression(query, allow_joins, reuse, summarize, for_save)
  +        if not isinstance(c, (DurationExpression, TemporalSubtraction)):
  +            lhs_type = getattr(c.lhs, '_output_field_or_none', None)
  +            rhs_type = getattr(c.rhs, '_output_field_or_none', None)
  +            datetime_fields = {'DateField', 'DateTimeField', 'TimeField'}
  +            if (
  +                c.connector == c.SUB and
  +                lhs_type is not None and
  +                rhs_type
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/models/expressions.py b/django/db/models/expressions.py
  --- a/django/db/models/expressions.py
  +++ b/django/db/models/expressions.py
  @@ -443,23 +443,6 @@ def set_source_expressions(self, exprs):
           self.lhs, self.rhs = exprs
   
       def as_sql(self, compiler, connection):
  -        try:
  -            lhs_type = self.lhs.output_field.get_internal_type()
  -        except FieldError:
  -            lhs_type = None
  -        try:
  -            rhs_type = self.rhs.output_field.get_internal_type()
  -        except FieldError:
  -            rhs_type = None
  -        if (
  -            not connection.features.has_native_duration_field and
  -            'DurationField' in {lhs_type, rhs_type} and
  -            lhs_type != rhs_type
  -        ):
  -            return DurationExpression(self.lhs, self.connector, self.rhs).as_sql(compiler, connection)
  -        datetime_fields = {'DateField
  ```

## django__django-13964  (EMPTY)
- repo `django/django`
- **문제설명**:
  ```
  Saving parent object after setting on child leads to data loss for parents with non-numeric primary key.
  Description
  	 
  		(last modified by Charlie DeTar)
  	 
  Given a model with a foreign key relation to another model that has a non-auto CharField as its primary key:
  class Product(models.Model):
  	sku = models.CharField(primary_key=True, max_length=50)
  class Order(models.Model):
  	product = models.ForeignKey(Product, on_delete=models.CASCADE)
  If the relation is initialized on the parent with an empty instance that does not yet specify its primary key, and the primary key is subsequently defined, the parent does not "see" the primary key's change:
  with transaction.atomic():
  	order = Order()
  	ord
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`  ← `grep django__django-13964 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-030515a1a0381e95b.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-030515a1a0381e95b.json`
- **우리 패치**:
  ```diff
  
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/models/base.py b/django/db/models/base.py
  --- a/django/db/models/base.py
  +++ b/django/db/models/base.py
  @@ -933,7 +933,7 @@ def _prepare_related_fields_for_save(self, operation_name):
                           "%s() prohibited to prevent data loss due to unsaved "
                           "related object '%s'." % (operation_name, field.name)
                       )
  -                elif getattr(self, field.attname) is None:
  +                elif getattr(self, field.attname) in field.empty_values:
                       # Use pk from related object if it has been saved after
                       # an assignment.
                       setattr(self, field.attname, obj.pk)
  ```

## django__django-14017  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  Q(...) & Exists(...) raises a TypeError
  Description
  	
  Exists(...) & Q(...) works, but Q(...) & Exists(...) raise a TypeError
  Here's a minimal example:
  In [3]: Exists(Product.objects.all()) & Q()
  Out[3]: <Q: (AND: <django.db.models.expressions.Exists object at 0x7fc18dd0ed90>, (AND: ))>
  In [4]: Q() & Exists(Product.objects.all())
  ---------------------------------------------------------------------------
  TypeError								 Traceback (most recent call last)
  <ipython-input-4-21d3dea0fcb9> in <module>
  ----> 1 Q() & Exists(Product.objects.all())
  ~/Code/venv/ecom/lib/python3.8/site-packages/django/db/models/query_utils.py in __and__(self, other)
  	 90 
  	 91	 def __and__(self, other):
  ---> 92		 retur
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`  ← `grep django__django-14017 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-030515a1a0381e95b.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-030515a1a0381e95b.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/models/query_utils.py b/django/db/models/query_utils.py
  index c957ffa564..fc573d3385 100644
  --- a/django/db/models/query_utils.py
  +++ b/django/db/models/query_utils.py
  @@ -40,6 +40,8 @@ class Q(tree.Node):
           super().__init__(children=[*args, *sorted(kwargs.items())], connector=_connector, negated=_negated)
   
       def _combine(self, other, conn):
  +        if getattr(other, 'conditional', False) and not isinstance(other, Q):
  +            return self._combine(type(self)(other), conn)
           if not isinstance(other, Q):
               raise TypeError(other)
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/models/query_utils.py b/django/db/models/query_utils.py
  --- a/django/db/models/query_utils.py
  +++ b/django/db/models/query_utils.py
  @@ -40,7 +40,7 @@ def __init__(self, *args, _connector=None, _negated=False, **kwargs):
           super().__init__(children=[*args, *sorted(kwargs.items())], connector=_connector, negated=_negated)
   
       def _combine(self, other, conn):
  -        if not isinstance(other, Q):
  +        if not(isinstance(other, Q) or getattr(other, 'conditional', False) is True):
               raise TypeError(other)
   
           # If the other Q() is empty, ignore it and just use `self`.
  ```

## django__django-14311  (RIGHT-FILE-WRONG-FIX)
- repo `django/django`
- **문제설명**:
  ```
  Allow autoreloading of `python -m custom_module runserver`
  Description
  	 
  		(last modified by Mariusz Felisiak)
  	 
  The original fix [1] only attempted to deal with -m foo.bar where bar is a package and __main__.py exists under foo/bar.
  When a dotted name for a module (for example, foo.bar.baz where baz.py resides under foo/bar) is specified like -m foo.bar.baz, the resulting arguments end up being -m foo.bar, which is uncalled for.
  [1] ​https://github.com/django/django/commit/ec6d2531c59466924b645f314ac33f54470d7ac3 
  Fixed detection when started non-django modules with "python -m" in autoreloader.
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`  ← `grep django__django-14311 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-030515a1a0381e95b.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-030515a1a0381e95b.json`
- **우리 패치**:
  ```diff
  diff --git a/django/utils/autoreload.py b/django/utils/autoreload.py
  index b6af5f5491..79a4c651ce 100644
  --- a/django/utils/autoreload.py
  +++ b/django/utils/autoreload.py
  @@ -224,7 +224,7 @@ def get_child_arguments():
       # see https://docs.python.org/3/reference/import.html#main-spec
       # __spec__ may not exist, e.g. when running in a Conda env.
       if getattr(__main__, '__spec__', None) is not None and __main__.__spec__.parent:
  -        args += ['-m', __main__.__spec__.parent]
  +        args += ['-m', __main__.__spec__.name]
           args += sys.argv[1:]
       elif not py_script.exists():
           # sys.argv[0] may not exist for several reasons on Windows.
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/utils/autoreload.py b/django/utils/autoreload.py
  --- a/django/utils/autoreload.py
  +++ b/django/utils/autoreload.py
  @@ -223,8 +223,13 @@ def get_child_arguments():
       # __spec__ is set when the server was started with the `-m` option,
       # see https://docs.python.org/3/reference/import.html#main-spec
       # __spec__ may not exist, e.g. when running in a Conda env.
  -    if getattr(__main__, '__spec__', None) is not None and __main__.__spec__.parent:
  -        args += ['-m', __main__.__spec__.parent]
  +    if getattr(__main__, '__spec__', None) is not None:
  +        spec = __main__.__spec__
  +        if (spec.name == '__main__' or spec.name.endswith('.__main__')) and spec.parent:
  +            name = spec.parent
  +        else:
  +            name = spec.name
  +        args += ['-m', name]
           args += sys.argv[1:]
       elif not py_script.exists():
           # sys.argv[0]
  ```

## django__django-14351  (WRONG-FILE)
- repo `django/django`
- **문제설명**:
  ```
  Q object __or__ appears to get all dunder related's default columns and queryset raises ProgrammingError.
  Description
  	
  There appears to be a difference in how Q object aliases are setup, when OR'd. The get_default_columns for this agent__property_groups__id__in only uses 1, where as get_default_columns for this agent__property_groups__in gets all fields, which later results in a " subquery must return only one column" error.
  # working in 3.2
  queryset.filter(
  	Q(agent__property_groups__id__in=property_groups.values_list("id", flat=True))
  	| Q(agent__property_groups__count=0)
  ).distinct()
  # VS
  # not working in 3.2, was working in 2.2.5, now causes all the fields to be added as part of the get
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`  ← `grep django__django-14351 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass7.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-030515a1a0381e95b.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-030515a1a0381e95b.json`
- **우리 패치**:
  ```diff
  diff --git a/django/db/models/fields/related_lookups.py b/django/db/models/fields/related_lookups.py
  index d745ecd5f9..2d6715c230 100644
  --- a/django/db/models/fields/related_lookups.py
  +++ b/django/db/models/fields/related_lookups.py
  @@ -86,9 +86,7 @@ class RelatedIn(In):
                       AND)
               return root_constraint.as_sql(compiler, connection)
           else:
  -            if (not getattr(self.rhs, 'has_select_fields', True) and
  -                    not getattr(self.lhs.field.target_field, 'primary_key', False)):
  -                self.rhs.clear_select_clause()
  +            if not getattr(self.rhs, 'has_select_fields', True):
                   if (getattr(self.lhs.output_field, 'primary_key', False) and
                           self.lhs.output_field.model == self.rhs.model):
                       # A case like Restaurant.objects.filter(place__in=restaurant_qs),
  @@ -97,6 +95
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/django/db/models/lookups.py b/django/db/models/lookups.py
  --- a/django/db/models/lookups.py
  +++ b/django/db/models/lookups.py
  @@ -406,6 +406,15 @@ def process_rhs(self, compiler, connection):
                   self.rhs.add_fields(['pk'])
               return super().process_rhs(compiler, connection)
   
  +    def get_group_by_cols(self, alias=None):
  +        cols = self.lhs.get_group_by_cols()
  +        if hasattr(self.rhs, 'get_group_by_cols'):
  +            if not getattr(self.rhs, 'has_select_fields', True):
  +                self.rhs.clear_select_clause()
  +                self.rhs.add_fields(['pk'])
  +            cols.extend(self.rhs.get_group_by_cols())
  +        return cols
  +
       def get_rhs_op(self, connection, rhs):
           return 'IN %s' % rhs
  ```

## sphinx-doc__sphinx-9711  (RIGHT-FILE-WRONG-FIX)
- repo `sphinx-doc/sphinx`
- **문제설명**:
  ```
  needs_extensions checks versions using strings
  ### Describe the bug
  
  The `needs_extensions` check is handy for verifying minimum extension versions, but it only checks versions in a 'string-like' manner. This means any version >9 is not allowed for any check of something >1. That is, treated as string '0.6' > '0.10', but treated as versions '0.6' < '0.10'. Since Sphinx does the former, some extension versions may not be allowed when they should be.
  
  ### How to Reproduce
  
  ```
  $ git clone https://github.com/anntzer/mplcursors
  $ cd mplcursors
  $ pip install -r .doc-requirements.txt
  $ pip install -e .
  $ make -C doc html
  ```
  This passes just fine, because the requirements pin sphinx-gallery to 0.9
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass16.log`  ← `grep sphinx-doc__sphinx-9711 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass16.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-083a1e591648294d1.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-083a1e591648294d1.json`
- **우리 패치**:
  ```diff
  diff --git a/sphinx/extension.py b/sphinx/extension.py
  index 7ec6c8518..eb63ebbfd 100644
  --- a/sphinx/extension.py
  +++ b/sphinx/extension.py
  @@ -10,6 +10,8 @@
   
   from typing import TYPE_CHECKING, Any, Dict
   
  +from packaging.version import Version
  +
   from sphinx.config import Config
   from sphinx.errors import VersionRequirementError
   from sphinx.locale import __
  @@ -51,7 +53,7 @@ def verify_needs_extensions(app: "Sphinx", config: Config) -> None:
                                 'but it is not loaded.'), extname)
               continue
   
  -        if extension.version == 'unknown version' or reqversion > extension.version:
  +        if extension.version == 'unknown version' or Version(reqversion) > Version(extension.version):
               raise VersionRequirementError(__('This project needs the extension %s at least in '
                                                'version %s and therefore c
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/sphinx/extension.py b/sphinx/extension.py
  --- a/sphinx/extension.py
  +++ b/sphinx/extension.py
  @@ -10,6 +10,8 @@
   
   from typing import TYPE_CHECKING, Any, Dict
   
  +from packaging.version import InvalidVersion, Version
  +
   from sphinx.config import Config
   from sphinx.errors import VersionRequirementError
   from sphinx.locale import __
  @@ -51,7 +53,18 @@ def verify_needs_extensions(app: "Sphinx", config: Config) -> None:
                                 'but it is not loaded.'), extname)
               continue
   
  -        if extension.version == 'unknown version' or reqversion > extension.version:
  +        fulfilled = True
  +        if extension.version == 'unknown version':
  +            fulfilled = False
  +        else:
  +            try:
  +                if Version(reqversion) > Version(extension.version):
  +                    fulfilled = False
  +            except InvalidVersion:
  +   
  ```

## sympy__sympy-24066  (RIGHT-FILE-WRONG-FIX)
- repo `sympy/sympy`
- **문제설명**:
  ```
  SI._collect_factor_and_dimension() cannot properly detect that exponent is dimensionless
  How to reproduce:
  
  ```python
  from sympy import exp
  from sympy.physics import units
  from sympy.physics.units.systems.si import SI
  
  expr = units.second / (units.ohm * units.farad)
  dim = SI._collect_factor_and_dimension(expr)[1]
  
  assert SI.get_dimension_system().is_dimensionless(dim)
  
  buggy_expr = 100 + exp(expr)
  SI._collect_factor_and_dimension(buggy_expr)
  
  # results in ValueError: Dimension of "exp(second/(farad*ohm))" is Dimension(time/(capacitance*impedance)), but it should be Dimension(1)
  ```
  ```
- **풀이 로그 경로**:
  - wave 스트림(이 인스턴스 풀이 출력): `/Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass13.log`  ← `grep sympy__sympy-24066 /Users/songmin/Library/quanta-codeagent-v3/bench-slices/sweep-eclass13.log`
  - preds: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-04e08752e13d7bf74.jsonl`
  - closure: `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-04e08752e13d7bf74.json`
- **우리 패치**:
  ```diff
  diff --git a/sympy/physics/units/unitsystem.py b/sympy/physics/units/unitsystem.py
  index 3daf84c108..c76d7feb9e 100644
  --- a/sympy/physics/units/unitsystem.py
  +++ b/sympy/physics/units/unitsystem.py
  @@ -192,8 +192,15 @@ def _collect_factor_and_dimension(self, expr):
           elif isinstance(expr, Function):
               fds = [self._collect_factor_and_dimension(
                   arg) for arg in expr.args]
  -            return (expr.func(*(f[0] for f in fds)),
  -                    *(d[1] for d in fds))
  +            dimensional_expr = self.get_dimensional_expr(expr)
  +            if dimensional_expr.func == expr.func:
  +                for _, dimension in fds:
  +                    if not self.get_dimension_system().is_dimensionless(dimension):
  +                        raise ValueError(
  +                            'Dimension of "{}" is {}, but it should be Dimension(1)'.format(
  +             
  ```
- **GOLD 패치**:
  ```diff
  diff --git a/sympy/physics/units/unitsystem.py b/sympy/physics/units/unitsystem.py
  --- a/sympy/physics/units/unitsystem.py
  +++ b/sympy/physics/units/unitsystem.py
  @@ -190,10 +190,9 @@ def _collect_factor_and_dimension(self, expr):
                   dim /= idim**count
               return factor, dim
           elif isinstance(expr, Function):
  -            fds = [self._collect_factor_and_dimension(
  -                arg) for arg in expr.args]
  -            return (expr.func(*(f[0] for f in fds)),
  -                    *(d[1] for d in fds))
  +            fds = [self._collect_factor_and_dimension(arg) for arg in expr.args]
  +            dims = [Dimension(1) if self.get_dimension_system().is_dimensionless(d[1]) else d[1] for d in fds]
  +            return (expr.func(*(f[0] for f in fds)), *dims)
           elif isinstance(expr, Dimension):
               return S.One, expr
           else:
  ```

---

## 부록 — M2~M5 build map (draft; 구현 시점 사이트 재확인 필수)

> Explore 스코핑 결과. line number/shape엔 추정 포함 → 편집 직전 grep로 확정(narrow-symbol false-gap 방지). 4건 모두 기존 SSOT 접합점에 꽂힘, 새 병렬경로 없음.

**M2 `fault-evidence:2` (bounded evidence)**
- type: `src/agent/fault-evidence/types.ts` `FaultEvidencePacket` — 현 candidates(path/score/sources/symbols)+issueSymbols+truncated/partial. 추가: ownerSnippet(line-window cap)·siblingPatterns·callerRefs·donorPatterns·adjacentControls (raw-blob 금지).
- builder: `src/agent/fault-evidence/build.ts` `buildFaultEvidencePacket` (score merge 직후 bounded 필드 attach).
- knob read: `knobs-bench.ts`(`benchPostureFromState`) — 현 binary gate → value parse("1" vs "2"). posture가 driver→closure-session으로 thread.
- renderer: `src/runner/batch/eval/fault-evidence.ts` `renderFaultEvidenceHint` (level=2 조건 렌더). ⚠️SSOT: apps/bench 재export 경유 — 한 곳서 parse 후 양 driver 동일 thread.

**M3 owner-SYMBOL metric (observe-only)**
- `src/runner/batch/eval/closure-diagnostics.ts` `computeClosureDiagnostics` — 현 owner_recall@1/first_edit_owner_match = FILE 단위. 추가: owner_symbol_match·first_edit_owner_symbol_match·line_window@50.
- `ClosureRunFact`에 firstEditSymbol/firstEditLineNum/symbolOwnerGoldFiles(optional) 추가. stream-tap 기록부(driver.ts ~1895)서 stamp.
- LSP 없으면 graceful `available:false`(knob 커플링 없음).

**M4 paired-control verification (done-blocking, public-derived only)**
- 기존 finish-blocking chokepoint 재사용(새 경로 X): primary-rail 경로(`closure/types.ts PrimaryRailStep`, `repair/index.ts` validator ~79 = 현 observe-only), driver verify 결정부(~1876).
- closure-session 플랜 빌더서 paired-control 생성(issue/repo 텍스트 only, base-red 증명 후 required), validator서 primary 통과해도 paired 실패면 round fail. gate 순서 = primary-rail → paired-control → finish. 신규 knob 필요.

**M5 no-patch-rescue**
- `src/agent/no-patch-breaker.ts` `decideNoPatch`(pure, 무변경). empty-patch 검출부(driver.ts ~1677 즉시 return) 사이에 bounded rescue 삽입: high-conf owner(closure bundle owner.admit) 있으면 owner 기반 minimal edit 1회 verify, 성공시 patch 채택·실패시 `no_patch_exhausted` verdict 분리.
- 신규 knob `no-patch-rescue` + posture. ⚠️knob OFF시 report shape byte-identical 유지(신규 verdict 타입 금지).
