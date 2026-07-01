---
task: nginx-request-logging
category: system-administration
difficulty: medium
tags: [web-server]
expert_min: 20
junior_min: 120
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/nginx-request-logging:20251031
---

# nginx-request-logging

**Goal** — Install and configure Nginx: listen on 8080, serve `/var/www/html`, custom access-log format (`$time_local`, `$request_method`, `$status`, quoted `$http_user_agent`) to `benchmark-access.log`, error log, rate limit (10 r/s per IP, burst 10, 10 MB zone via `limit_req_zone` in `nginx.conf` + `limit_req` in the server block), custom 404 page, disable the default site, create index.html + 404.html, test config, and start the server so `localhost:8080` responds.

**Solution shape** — Short (~60-line) bash of sysadmin steps: `apt-get install -y nginx`; `mkdir -p /var/www/html`; echo the index/404 pages; conditionally `sed`-inject a `log_format detailed` and a `limit_req_zone` into `http {}` of `/etc/nginx/nginx.conf`; heredoc a `benchmark-site.conf` server block (listen 8080, root, access/error logs, `limit_req ... burst=10`, `error_page 404 /404.html`); `rm` the default site; `nginx -t`; `service/systemctl nginx restart`; `curl localhost:8080`. No application code — pure server config.

**Verifier** — pytest + requests: nginx installed; 8080 returns 200 with exact index text; nonexistent path returns 404 with exact 404 text; `nginx -t` passes; `benchmark-site.conf` has `listen 8080`/`root /var/www/html`; `nginx.conf` has a `log_format` with all four fields and a `limit_req_zone ... rate=10r/s`; access log file created; log lines contain timestamp, method, status, and a trailing quoted user-agent.

**Difficulty drivers** — Breadth of nginx config knowledge (log_format directives, limit_req_zone/limit_req split between http and server context, error_page/internal, disabling default site) and getting a syntactically valid config that starts cleanly. Low reasoning depth but many exact directives + the running-service requirement. Real system-state manipulation.

**quanta attack points** — `container_exec` is ideal — install, edit config, `nginx -t`, restart, and `curl` are all exit-code/output checkable one-shots; no TUI. Main risk: a config that fails `nginx -t` (context errors for limit_req_zone), wrong log format quoting, or the service not actually staying up on 8080. The iterate-until-pass loop is strong: `nginx -t` + HTTP probes give crisp feedback to fix directives and confirm the live server.
