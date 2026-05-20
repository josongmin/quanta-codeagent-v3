# Codex Thread Storage and DB Audit

Overview router: [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/README.md)

이 문서는 Codex의 `thread/session storage`를 현재 로컬에서 직접 보인 artifact 기준으로 정리한다.

범위:
- `~/.codex` 아래에서 직접 확인된 JSONL and SQLite artifacts
- thread/session/automation/logging 관련 table names and columns
- 각 저장 rail이 어떤 역할로 보이는지
- 무엇이 `FACT`이고, 무엇이 overclaim인지

표기:
- `[FACT]`: 현재 로컬 filesystem, JSONL head/sample, SQLite schema에서 직접 확인된 사실
- `[STRONG-INFERENCE]`: 위 사실을 가장 잘 설명하는 고신뢰 구조 추론
- `[WEAK-INFERENCE]`: plausible 하지만 직접 근거가 부족한 해석
- `[SOTA-INFERENCE]`: 2025-2026 desktop agent/local control-plane 일반 패턴과 현재 evidence를 합친 합리적 추론

주의:
- 이 문서는 local visible persistence layer를 다룬다.
- hidden service-side DB, sync backend, retention GC policy는 직접 보지 못했다.

---

## 1. Executive summary

### 1.1 Top conclusions

1. visible local persistence는 단일 DB가 아니라 `JSONL + SQLite + workspace artifact` 혼합 구조다. `[FACT]` + `[STRONG-INFERENCE]`
2. thread index 성격의 JSONL, archived rollout JSONL, lightweight input history JSONL이 별도로 보인다. `[FACT]`
3. SQLite도 최소 세 갈래가 보인다:
   - `state_5.sqlite` for thread/session/job state `[FACT]`
   - `logs_2.sqlite` for structured logs `[FACT]`
   - `sqlite/codex-dev.db` for automation/inbox/local-app feature state `[FACT]`
4. 따라서 “Codex는 DB를 안 쓰고 파일만 쓴다”도 틀리고, “모든 thread state가 하나의 SQLite에만 있다”도 틀릴 가능성이 높다. `[STRONG-INFERENCE]`

---

## 2. Direct artifact inventory

직접 확인한 local artifacts:

- `/Users/songmin/.codex/session_index.jsonl` `[FACT]`
- `/Users/songmin/.codex/history.jsonl` `[FACT]`
- `/Users/songmin/.codex/archived_sessions/rollout-*.jsonl` 다수 `[FACT]`
- `/Users/songmin/.codex/logs_2.sqlite` `[FACT]`
- `/Users/songmin/.codex/state_5.sqlite` `[FACT]`
- `/Users/songmin/.codex/sqlite/codex-dev.db` `[FACT]`

이 자체로:
- JSONL rail 존재 `[FACT]`
- SQLite rail 존재 `[FACT]`
- thread/session persistence가 단일 포맷이 아님 `[STRONG-INFERENCE]`

### 2.1 Snapshot size on 2026-05-21

현재 local snapshot에서 직접 확인한 대략적 규모:

- `session_index.jsonl`: 5570 lines `[FACT]`
- `history.jsonl`: 1358 lines `[FACT]`
- `archived_sessions/rollout-*.jsonl`: 6211 files `[FACT]`
- `threads` rows: 6950 `[FACT]`
- `thread_spawn_edges` rows: 5986 `[FACT]`
- `thread_dynamic_tools` rows: 8472 `[FACT]`
- `logs` rows: 4326814 `[FACT]`

이 규모 자체는:
- thread/session surface가 장난감 1-file cache가 아니라 꽤 오래 누적되는 local control plane임을 시사한다 `[STRONG-INFERENCE]`

### 2.2 Population skew caveat

현재 local snapshot에서 직접 확인한 분포:

- `threads.thread_source='subagent'`: 4304 rows `[FACT]`
- `threads.thread_source='user'`: 318 rows `[FACT]`
- `thread_source` empty/null-like rows: 2336 rows `[FACT]`
- `session_index.jsonl` lines `5570`는 `threads` rows `6950`보다 적다 `[FACT]`

안전한 결론:
- `threads` table은 user-visible top-level chat만의 table로 보기 어렵다 `[STRONG-INFERENCE]`
- `session_index.jsonl`도 full canonical thread SSOT라기보다 filtered/materialized index일 가능성이 높다 `[STRONG-INFERENCE]`

---

## 3. JSONL rails

## 3.1 `session_index.jsonl`

head sample에서 직접 보인 row shape:

```json
{"id":"...","thread_name":"...","updated_at":"..."}
```

안전한 결론:
- session/thread index row가 JSONL로 남는다 `[FACT]`
- 최소 필드는 `id`, `thread_name`, `updated_at`다 `[FACT]`

가장 설명력 높은 해석:
- sidebar나 thread picker가 직접 쓰는 filtered/materialized index substrate 중 하나다 `[STRONG-INFERENCE]`
- full canonical thread universe 전체를 1:1로 대표하는 SSOT라고 보긴 어렵다 `[STRONG-INFERENCE]`

## 3.2 `history.jsonl`

head sample에서 직접 보인 row shape:

```json
{"session_id":"...","ts":1777859141,"text":"..."}
```

안전한 결론:
- lightweight user text history rail이 JSONL로 별도 존재한다 `[FACT]`
- 최소 필드는 `session_id`, `ts`, `text`다 `[FACT]`

## 3.3 `archived_sessions/rollout-*.jsonl`

sample head에서 직접 보인 record types:

```json
{"timestamp":"...","type":"session_meta","payload":{...}}
{"timestamp":"...","type":"response_item","payload":{...}}
```

안전한 결론:
- archived rollout은 append-only event log에 가까운 JSONL artifact로 남는다 `[FACT]`
- `session_meta`, `response_item`, `event_msg` 류 record family가 존재한다 `[FACT]`
- one session/thread에 여러 event line이 누적된다 `[FACT]`

가장 설명력 높은 해석:
- detailed replay/debug/handoff rail은 archived rollout JSONL이 맡는다 `[STRONG-INFERENCE]`

## 3.4 Active session rollout rail

직접 확인한 facts:

- `/Users/songmin/.codex/sessions/**/rollout-*.jsonl` files도 존재한다 `[FACT]`
- current snapshot에서 count는 `739`였다 `[FACT]`
- `threads.rollout_path`는 null 없이 전부 `~/.codex/sessions/...` 또는 `~/.codex/archived_sessions/...`를 가리켰다 `[FACT]`
- `threads.rollout_path like '/Users/songmin/.codex/sessions/%'` rows는 `673`이었다 `[FACT]`
- `threads.rollout_path like '/Users/songmin/.codex/archived_sessions/%'` rows는 `6285`였다 `[FACT]`

안전한 결론:
- rollout JSONL rail은 archived rail과 active session rail로 분리되어 있다 `[FACT]`

가장 설명력 높은 해석:
- active threads/non-archived rows는 `~/.codex/sessions/...` 쪽 live rollout rail을, archived threads는 `~/.codex/archived_sessions/...` 쪽 archival rail을 주로 쓰는 구조가 가장 자연스럽다 `[STRONG-INFERENCE]`

---

## 4. SQLite rails

## 4.0 Engine and migration evidence

직접 보인 facts:

- `state_5.sqlite`에는 `_sqlx_migrations` table이 있다 `[FACT]`
- `logs_2.sqlite`에도 `_sqlx_migrations` table이 있다 `[FACT]`
- `state_5.sqlite` migration descriptions sample:
  - `threads preview`
  - `thread goals`
  - `thread dynamic tools namespace`
  - `threads thread source`
  모두 `[FACT]`
- `logs_2.sqlite` migration descriptions sample:
  - `logs`
  - `logs feedback log body`
  모두 `[FACT]`

가장 보수적인 해석:
- 적어도 `state_5.sqlite`와 `logs_2.sqlite`는 SQLx-managed SQLite migration path를 쓸 가능성이 높다 `[STRONG-INFERENCE]`
- 즉 local state/log persistence layer의 일부는 Rust ecosystem migration stack과 매우 잘 맞는다 `[SOTA-INFERENCE]`

## 4.1 `state_5.sqlite`

visible tables:

- `threads` `[FACT]`
- `thread_goals` `[FACT]`
- `thread_spawn_edges` `[FACT]`
- `thread_dynamic_tools` `[FACT]`
- `agent_jobs` `[FACT]`
- `agent_job_items` `[FACT]`
- `backfill_state`, `jobs`, `remote_control_enrollments`, `stage1_outputs` `[FACT]`

### `threads` table

직접 보인 주요 columns:

- `id` `[FACT]`
- `rollout_path` `[FACT]`
- `created_at`, `updated_at`, `created_at_ms`, `updated_at_ms` `[FACT]`
- `source`, `model_provider`, `cli_version`, `thread_source` `[FACT]`
- `cwd`, `title`, `preview` `[FACT]`
- `sandbox_policy`, `approval_mode` `[FACT]`
- `tokens_used`, `has_user_event`, `memory_mode` `[FACT]`
- `git_sha`, `git_branch`, `git_origin_url` `[FACT]`
- `first_user_message`, `agent_nickname`, `agent_role`, `model`, `reasoning_effort`, `agent_path` `[FACT]`
- `archived`, `archived_at` `[FACT]`
- current snapshot row count: `6950` `[FACT]`

안전한 결론:
- thread/session metadata는 SQLite table에도 명시적으로 존재한다 `[FACT]`
- JSONL index와 별도로 richer structured thread row가 있다 `[FACT]`
- thread row가 archived rollout JSONL path를 직접 가리키는 field를 가진다 `[FACT]`

가장 설명력 높은 해석:
- SQLite metadata rail과 archived rollout JSONL rail이 `rollout_path`로 연결될 가능성이 높다 `[STRONG-INFERENCE]`

### `thread_goals` table

직접 보인 주요 columns:

- `thread_id`, `goal_id`, `objective`, `status` `[FACT]`
- `token_budget`, `tokens_used`, `time_used_seconds` `[FACT]`
- `created_at_ms`, `updated_at_ms` `[FACT]`

의미:
- thread-level goal/accounting state가 구조화되어 있다 `[STRONG-INFERENCE]`

### `thread_spawn_edges` table

직접 보인 columns:

- `parent_thread_id` `[FACT]`
- `child_thread_id` `[FACT]`
- `status` `[FACT]`
- current snapshot row count: `5986` `[FACT]`
- distinct parent threads: `471` `[FACT]`
- distinct child threads: `5986` `[FACT]`
- row sample에는 `open`과 `closed` status가 모두 보였다 `[FACT]`
- joined sample에서 child rows 다수는 `thread_source='subagent'`였다 `[FACT]`
- child-source aggregate sample에서는 `subagent=4220`가 가장 컸다 `[FACT]`
- one parent가 5개 초과 child를 가지는 경우가 `326`개였고, max children per parent는 `80`이었다 `[FACT]`

의미:
- parent-child thread edge를 구조적으로 저장하는 local state가 있다 `[FACT]`
- 특히 subagent/delegation lineage에 강하게 쓰이는 rail일 가능성이 높다 `[STRONG-INFERENCE]`
- UI fork도 같은 rail을 공유할 수는 있지만, 현재 evidence만으로 UI fork 주증거라고 보긴 어렵다 `[STRONG-INFERENCE]`

### `thread_dynamic_tools` table

직접 보인 columns:

- `thread_id`, `position`, `name`, `description`, `input_schema`, `defer_loading`, `namespace` `[FACT]`
- current snapshot row count: `8472` `[FACT]`
- sample rows에는 `automation_update`, `read_thread_terminal`, `load_workspace_dependencies`가 반복적으로 보였다 `[FACT]`

의미:
- thread별 tool surface 또는 tool exposure ordering이 동적으로 붙을 수 있다 `[STRONG-INFERENCE]`
- tool availability가 static global list만이 아니라 thread-local projection일 가능성이 높다 `[STRONG-INFERENCE]`

### `agent_jobs` / `agent_job_items`

직접 보인 columns:

- `agent_jobs`: `id`, `name`, `status`, `instruction`, `output_schema_json`, `input_headers_json`, `input_csv_path`, `output_csv_path`, `auto_export`, `started_at`, `completed_at`, `last_error`, `max_runtime_seconds` `[FACT]`
- `agent_job_items`: `job_id`, `item_id`, `row_index`, `source_id`, `row_json`, `status`, `assigned_thread_id`, `attempt_count`, `result_json`, `last_error`, `completed_at`, `reported_at` `[FACT]`

의미:
- batch/job-like orchestration state도 local SQLite에 존재한다 `[STRONG-INFERENCE]`

## 4.2 `logs_2.sqlite`

visible table:
- `logs` `[FACT]`
- current snapshot row count: `4326814` `[FACT]`

직접 보인 주요 columns:

- `ts`, `ts_nanos`, `level`, `target` `[FACT]`
- `feedback_log_body`, `module_path`, `file`, `line` `[FACT]`
- `thread_id`, `process_uuid` `[FACT]`
- `estimated_bytes` `[FACT]`
- sample target에는 `codex_api::sse::responses`, `codex_otel.log_only`, `hyper_util::client::legacy::*`가 보였다 `[FACT]`
- sample `feedback_log_body`에는 `session_loop{thread_id=...}:submission_dispatch`가 보였다 `[FACT]`

안전한 결론:
- structured log rail은 SQLite logs table로 남는다 `[FACT]`
- log row가 thread와 process identity를 함께 가질 수 있다 `[FACT]`
- local runtime/network/SSE observability가 별도 log rail에 남는다 `[FACT]`

## 4.3 `sqlite/codex-dev.db`

visible tables:

- `automations` `[FACT]`
- `automation_runs` `[FACT]`
- `inbox_items` `[FACT]`
- `local_app_server_feature_enablement` `[FACT]`

### `automations`

직접 보인 주요 columns:

- `id`, `name`, `prompt`, `status` `[FACT]`
- `next_run_at`, `last_run_at` `[FACT]`
- `cwds`, `rrule`, `model`, `reasoning_effort` `[FACT]`
- `created_at`, `updated_at` `[FACT]`

의미:
- automation state는 local SQLite에 구조적으로 남는다 `[FACT]`

### `automation_runs`

직접 table 존재만 확인됐다. `[FACT]`

가장 설명력 높은 해석:
- run history or execution bookkeeping rail일 가능성이 높다 `[STRONG-INFERENCE]`

### `inbox_items`

직접 보인 주요 columns:

- `thread_id`, `automation_id`, `status`, `read_at` `[FACT]`
- `thread_title`, `source_cwd`, `inbox_title`, `inbox_summary` `[FACT]`
- `archived_user_message`, `archived_assistant_message`, `archived_reason` `[FACT]`

의미:
- automation-triggered follow-up나 thread-linked inbox concept가 local DB에 존재한다 `[STRONG-INFERENCE]`

### `automation.toml` evidence gap

현재 로컬 quick check에서는 `~/.codex/automations/**/automation.toml` 파일을 확인하지 못했다. `[FACT]`

안전한 결론:
- 이 세션에서 직접 확인된 automation persistence evidence는 SQLite 쪽이 더 강하다 `[FACT]`

안전하지 않은 단정:
- automation이 절대 TOML을 쓰지 않는다
- 다른 설치나 버전에서도 동일하다

둘 다 `NON-CLAIM`.

---

## 5. Best-fit storage model

```mermaid
flowchart TD
    A["Thread/session activity"] --> B["session_index.jsonl"]
    A --> C["history.jsonl"]
    A --> D["~/.codex/sessions/*.jsonl"]
    A --> E["archived_sessions/*.jsonl"]
    A --> F["state_5.sqlite"]
    A --> G["logs_2.sqlite"]
    A --> H["sqlite/codex-dev.db"]
```

가장 설명력 높은 역할 분해:

- `session_index.jsonl`: lightweight list/index rail `[STRONG-INFERENCE]`
- `history.jsonl`: lightweight prompt/text recall rail `[STRONG-INFERENCE]`
- `~/.codex/sessions/*.jsonl`: active session rollout rail `[STRONG-INFERENCE]`
- `archived_sessions/*.jsonl`: detailed archived event/replay rail `[STRONG-INFERENCE]`
- `state_5.sqlite`: live thread/session/goal/fork/job state rail `[STRONG-INFERENCE]`
- `logs_2.sqlite`: structured operational log rail `[STRONG-INFERENCE]`
- `codex-dev.db`: automation/inbox/local app feature rail `[STRONG-INFERENCE]`

---

## 6. What can be said about “which DB Codex uses”

안전한 답:

1. local visible persistence에는 SQLite가 실제로 사용된다 `[FACT]`
2. local visible persistence에는 JSONL도 실제로 사용된다 `[FACT]`
3. 따라서 Codex local desktop state는 `SQLite only`도 아니고 `JSONL only`도 아니다 `[STRONG-INFERENCE]`

안전하지 않은 답:

1. “모든 thread state는 `state_5.sqlite` 하나에만 있다”
2. “service-side backend도 SQLite다”
3. “UI 메뉴 action이 항상 특정 table 하나에 1:1 매핑된다”

모두 `NON-CLAIM`.

---

## 7. Why this split is the most plausible SOTA shape

### 7.1 Why not SQLite-only

SQLite-only로 보기 어려운 이유:
- archived rollout JSONL이 별도로 존재한다 `[FACT]`
- session index와 lightweight history도 JSONL이 별도다 `[FACT]`

가장 자연스러운 해석:
- queryable control-plane state와 append-only replay/export rail을 분리한 구조다 `[SOTA-INFERENCE]`

### 7.2 Why not JSONL-only

JSONL-only로 보기 어려운 이유:
- `threads`, `thread_spawn_edges`, `thread_dynamic_tools`, `logs`, `automations` 같은 relational schema가 직접 보인다 `[FACT]`

가장 자연스러운 해석:
- sidebar/thread lifecycle, lineage edges, tool exposure, logs filtering 같은 기능은 SQLite가 더 잘 맞는다 `[SOTA-INFERENCE]`

### 7.3 Why a split store is operationally rational

best-fit rationale:
- `state_5.sqlite`: canonical local control-plane state `[SOTA-INFERENCE]`
- `logs_2.sqlite`: high-volume observability 분리 `[SOTA-INFERENCE]`
- `~/.codex/sessions/*.jsonl`: active rollout append-only rail `[SOTA-INFERENCE]`
- `archived_sessions/*.jsonl`: replay/debug/handoff export rail `[SOTA-INFERENCE]`
- workspace files: user-facing durable truth `[STRONG-INFERENCE]`

이 조합은 2025-2026 desktop coding-agent에서 가장 흔한 local-operability tradeoff와 잘 맞는다. `[SOTA-INFERENCE]`

---

## 8. Non-claims

이 문서가 주장하지 않는 것:

- hidden remote sync backend exact shape
- ~~retention/compaction/GC rules~~ **CORRECTED 2026-05-21**: `logs_2.sqlite`의 sliding-window retention algorithm은 round-2에서 직접 binary string으로 확인됐다 (§ Round 2 update 참조). 다만 exact byte threshold parameter는 여전히 안 보인다.
- JSONL and SQLite write ordering guarantees
- UI action to table write 1:1 mapping
- whether `thread_spawn_edges` is UI fork only, subagent only, or mixed lineage

---

## Round 2 update (2026-05-21 deep dive)

이 섹션은 2026-05-21 deep dive에서 직접 확인된 schema, retention algorithm, 디스크 inventory를 정리한다. 이전 sections와 충돌하면 이쪽이 더 정확하다.

### R2.1 `~/.codex/` directory inventory (snapshot)

이 머신 기준 `~/.codex/` 실제 layout이다. `[FACT]`

| Path | Size / Count | Mode | Role |
| --- | --- | --- | --- |
| `config.toml` | 1.2K | 0600 | user preferences + project trust + feature flags |
| `auth.json` | 4.3K | 0600 | OAuth token bundle (`auth_mode="chatgpt"`, `id_token`, `access_token`, `refresh_token`, `account_id`, `last_refresh`) |
| `.codex-global-state.json` (+ `.bak`) | 112K | - | electron-persisted atom state (onboarding, agent-mode-by-host-id, prompt-history) |
| `models_cache.json` | 226K | - | ETag-keyed cache of 7 models, embeds base_instructions + personality templates |
| `history.jsonl` | 654K | - | lightweight user-input log |
| `session_index.jsonl` | 736K (5607 sessions) | - | thread index |
| `archived_sessions/` | 6326 files | - | per-session rollout JSONL |
| `memories/` | (git-versioned) | - | `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries/`, `extensions/chronicle/resources/` |
| `rules/default.rules` | 353K | - | bash command prefix_rule allowlist |
| `logs_2.sqlite` (+ SHM + WAL) | 14.8GB + 27MB + 14GB | - | structured operational logs (§ R2.4) |
| `state_5.sqlite` | - | - | thread/session control plane |
| `sqlite/codex-dev.db` | - | - | automation/inbox |
| `installation_id` | 36B | - | UUID |
| `.personality_migration` | 3B | - | migration marker |
| `.codex-chronicle-assets-to-install.marker` | 16B hex | - | chronicle install marker |
| `automations/`, `browser/`, `computer-use/`, `plugins/`, `node_repl/`, `log/`, `cache/`, `.tmp/` | (dirs) | - | feature-scoped subdirs |
| `pets/` | empty | - | purpose unknown; no string refs found in bundles |

모두 `[FACT]` (filesystem inspection 결과).

### R2.2 `~/.codex/config.toml` schema

직접 본 top-level keys: `[FACT]`

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "xhigh"
approvals_reviewer = "user"
plan_mode_reasoning_effort = "high"
personality = "pragmatic"

[marketplaces.<name>]
source_type = "..."
source = "..."

[projects."<absolute-path>"]
trust_level = "untrusted"  # or "trusted"

[notice]
hide_<model>_migration_prompt = true

[tui.model_availability_nux]
"<model-id>" = <seen_count>

[features]
memories = true
chronicle = true

[plugins."<name>@<marketplace>"]
enabled = true
```

의미:
- model/reasoning/personality default가 config 한곳에 모인다 `[FACT]`
- per-project trust level이 `~/.codex` 전역 config에 기록된다 `[FACT]`
- feature flag (memories, chronicle)는 config에 직접 보인다 `[FACT]`

### R2.3 Session/turn JSONL record types (archived rollout)

`archived_sessions/rollout-{ISO timestamp}.jsonl`는 한 session 하나당 한 file이며, 각 line의 `type` 값으로 다음이 보인다. `[FACT]`

| `type` | Payload keys (observed) |
| --- | --- |
| `session_meta` | `id, timestamp, cwd, originator, cli_version, source, model_provider, base_instructions, git` |
| `turn_context` | `turn_id, cwd, current_date, timezone, approval_policy, sandbox_policy, permission_profile, model, personality, collaboration_mode, realtime_active, effort, summary, user_instructions, truncation_policy` |
| `event_msg:task_started` | task lifecycle event |
| `response_item:message` | assistant/tool response |
| `event_msg:user_message` | user input |
| `event_msg:token_count` | token accounting |
| `event_msg:turn_aborted` | turn cancellation |

핵심:
- `turn_context`는 매 turn마다 **full snapshot**으로 기록된다 `[FACT]`
- 즉 fork/resume이 self-contained하게 가능하도록 turn 단위로 cwd/policy/model/personality/collaboration_mode 전체가 박힌다 `[STRONG-INFERENCE]`
- 이건 round-1에서 `session_meta` + `response_item` 두 family만 언급한 것보다 더 정확하다

`session_index.jsonl` line schema (확정):

```json
{"id":"019df0da-7f60-7f20-9d1a-d128bf054cea","thread_name":"...","updated_at":"<ISO8601>"}
```

- `id`는 UUID v7-like 시간순 prefix를 가진다 `[FACT]`

`history.jsonl` line schema (확정):

```json
{"session_id":"...","ts":<unix-seconds>,"text":"<user input>"}
```

- 한 line = 한 user-input log `[FACT]`

### R2.4 `logs_2.sqlite` deep dive

이 round의 가장 큰 발견이다. `[FACT]`

#### File-level facts

- Path: `~/.codex/logs_2.sqlite`
- 이 머신 disk usage: 14.8GB (main) + 27MB (SHM) + 14GB (WAL)
- PRAGMA: `page_size=4096`, `page_count=3,636,521`, `wal_autocheckpoint=1000`, `auto_vacuum=2 (INCREMENTAL)`

#### Schema (recovered from binary)

```sql
CREATE TABLE logs (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER,           -- unix epoch seconds
    ts_nanos  INTEGER,
    level     TEXT,
    target    TEXT,
    feedback_log_body TEXT,
    module_path TEXT,
    file      TEXT,
    line      INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE _sqlx_migrations (...);   -- 2 migrations; estimated_bytes added in migration #2
```

#### Indexes (4 total)

- `idx_logs_ts (ts DESC, ts_nanos DESC, id DESC)` — global time-range scan
- `idx_logs_thread_id (thread_id)` — thread filter
- `idx_logs_thread_id_ts (thread_id, ts DESC, ts_nanos DESC, id DESC)` — thread-scoped time scan
- `idx_logs_process_uuid_threadless_ts (process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL` — partial index for threadless rows

모두 `[FACT]`.

#### Retention algorithm (binary string recovery)

codex Rust binary에서 직접 추출한 query 형태:

```sql
SELECT ts, ts_nanos, level, feedback_log_body FROM (
    SELECT … , SUM(estimated_bytes) OVER (…) AS cumulative_estimated_bytes
    FROM feedback_logs
) WHERE cumulative_estimated_bytes <= ?

-- and:
DELETE FROM logs WHERE ts < ?;
PRAGMA wal_checkpoint(PASSIVE);
```

가장 설명력 높은 해석:
- cumulative `estimated_bytes` over time window를 sliding-window cap으로 사용한다 `[MODEL]`
- exact byte threshold는 binary 안에서 static하게 안 보인다 → runtime parameter `[FACT]`
- WAL checkpoint는 PASSIVE (non-blocking) — long-running write connection이 disk I/O spike를 피하려는 의도다 `[MODEL]`

#### Observed metrics on this machine

| Metric | Value |
| --- | --- |
| Row count | 4,379,296 |
| Time window | 2026-05-10 → 2026-05-20 (~9.95 days) |
| Avg row size | ~3.6KB |
| Daily growth | ~1.49 GB/day |
| Distinct `process_uuid` | 2,983 |

모두 `[FACT]`.

#### Derived interpretation

- 현재 write rate에서 effective retention cap ≈ ~10 days `[MODEL]`
- WAL이 14GB까지 부푼 이유: long-running write connection이 checkpoint를 피해서 I/O spike를 막는 패턴 `[MODEL]`
- error message가 token이나 path를 담을 가능성이 있으나, on-disk mitigation은 file mode 0600/0644 + OS-level FileVault encryption뿐 `[MODEL]`
- 즉 app-level encryption은 관측되지 않았다 `[FACT]`

이 round-2 발견은 round-1의 “sample target/body” evidence와 충돌하지 않고, 그것을 schema + retention level로 확장한 것이다.

### R2.5 Updated storage rail map

round-2 confirmed roles:

| Store | Role | Round-2 evidence |
| --- | --- | --- |
| `state_5.sqlite` | canonical thread/session control plane | (round-1) |
| `logs_2.sqlite` | high-volume telemetry with sliding-window retention (~10 days, PASSIVE WAL checkpoint) | § R2.4 |
| `sqlite/codex-dev.db` | automation/inbox/local feature state | (round-1) |
| `session_index.jsonl` | UUID-v7-keyed lightweight thread index | § R2.3 |
| `history.jsonl` | per-line user-input log | § R2.3 |
| `~/.codex/sessions/*.jsonl` | active session rollout | (round-1) |
| `archived_sessions/*.jsonl` | full archived rollout with `turn_context` snapshots | § R2.3 |
| `config.toml` | user/feature/trust config | § R2.2 |
| `auth.json` | OAuth tokens (0600) | § R2.1 |
| `.codex-global-state.json` | electron-persisted atom state (onboarding, agent-mode, prompt-history) | § R2.1 |
| `memories/` (git-versioned) | structured memory + rollout summaries + chronicle resources | § R2.1 |
| `models_cache.json` | ETag-keyed model cache with embedded instructions | § R2.1 |
| `rules/default.rules` | bash command prefix_rule allowlist | § R2.1 |

### R2.6 Updated non-claims

- exact byte threshold value driving `logs_2.sqlite` retention `[NON-CLAIM]`
- whether `pets/` directory has any code path at all `[NON-CLAIM]`
- whether `models_cache.json` ETag is service-driven or local-only `[NON-CLAIM]`
- exact retention behavior of `archived_sessions/` (file count grows over time on this machine; no explicit pruning observed) `[NON-CLAIM]`
