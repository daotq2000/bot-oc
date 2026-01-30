# Issue backlog (tồn đọng) – bot-oc

> Mục tiêu: ghi lại các vấn đề tồn đọng quan sát được trong codebase + phương án xử lý. Danh sách này ưu tiên các rủi ro vận hành (prod), rủi ro tài chính (trading), rủi ro bảo mật, rồi đến chất lượng code/test.

## P0 – Cần xử lý sớm (rủi ro cao)

### 1) Repo đang chứa artefact runtime/large files (logs, coverage report, .har)
- **Dấu hiệu**
  - Thư mục `logs/` có nhiều file `combined*.log`, `error*.log`, `orders*.log`, `exceptions.log`, `rejections.log`.
  - Thư mục `coverage/` có HTML report + `lcov.info`.
  - Có file `futures.testnet.mexc.com.har`.
- **Rủi ro**
  - Phình repo, lộ thông tin nhạy cảm (request/response headers, payload), tăng noise khi review.
- **Phương án**
  - Thêm ignore cho `logs/`, `coverage/`, `*.har` trong `.gitignore`.
  - Xóa artefact khỏi git history nếu đã commit (dùng `git rm --cached` và commit dọn dẹp; nếu cần triệt để dùng BFG/git filter-repo).

### 2) `config/config.json` tồn tại trong repo (nguy cơ chứa secrets)
- **Dấu hiệu**
  - Có file `config/config.json` ở root.
- **Rủi ro**
  - Thường các file config JSON dễ chứa keys/endpoint nội bộ; nếu có secrets thì là incident.
- **Phương án**
  - Kiểm tra nội dung file để đảm bảo không có API keys/tokens.
  - Chuyển sang `.env` hoặc `config/config.example.json` + ignore file thực tế.
  - Thiết lập validate config khi start.

### 3) Graceful shutdown: `telegramBot` có thể null nhưng vẫn gọi `.stop()`
- **Dấu hiệu**
  - `src/app.js`: trong handler `SIGINT` có `await telegramBot.stop();` (không guard null).
  - Handler `SIGTERM` có đoạn lồng `if (telegramBot) { if (telegramBot) { await telegramBot.stop(); } }` (thừa nhưng an toàn hơn).
- **Rủi ro**
  - App crash khi shutdown nếu bot chưa init/failed start → khó kiểm soát stop sequence.
- **Phương án**
  - Chuẩn hóa shutdown routine: luôn guard `telegramBot?.stop?.()`.
  - Tách `shutdown()` dùng chung cho SIGINT/SIGTERM để tránh lệch logic.

## P1 – Quan trọng (nên xử lý trong vài sprint)

### 4) `AppConfig` seeding quá nhiều trong `src/app.js` (entrypoint phình + khó test)
- **Dấu hiệu**
  - `start()` seed hàng loạt key bằng `await AppConfig.set(...)`.
  - Có key bị lặp: `BINANCE_REST_PRICE_COOLDOWN_MS` set 2 lần; `ADV_TPSL_MTF_ENABLED` set lặp.
  - Nhiều mô tả copy/paste sai (ví dụ một số key Price Alert có description “Default leverage…”).
- **Rủi ro**
  - Drift cấu hình, khó audit, khó migrate.
- **Phương án**
  - Chuyển danh sách default config sang file data cấu hình (JSON/JS) + loop insert.
  - Thêm check trùng key trước khi seed, log warn nếu trùng.
  - Tách thành job/migration “seed app_configs”.

### 5) `.gitignore` hiện chưa ignore `logs/`, `coverage/`, `*.har`
- **Dấu hiệu**
  - `.gitignore` có `*.log` nhưng không ignore cả thư mục `logs/`.
  - Không có `coverage/`, `*.har`.
- **Rủi ro**
  - Artefact HTML/asset trong `coverage/` vẫn bị track.
- **Phương án**
  - Bổ sung ignore patterns.

### 6) Logger: `orderLogger` cấu hình level có vẻ sai mục tiêu
- **Dấu hiệu**
  - `src/utils/logger.js`: transport `orders.log` set `level: 'warn'` nhưng comment nói “info and warning (warn includes info)” (không đúng trong winston: `warn` không bao gồm `info`).
- **Rủi ro**
  - Mất log `info` về order (khó điều tra sự cố).
- **Phương án**
  - Đặt `level: 'info'` cho `orders.log` nếu muốn ghi cả info+warn.

## P2 – Cải thiện chất lượng/độ bền (nice to have)

### 7) Nhiều timer/interval chạy nền – cần chuẩn hóa lifecycle cleanup
- **Dấu hiệu**
  - Nhiều nơi dùng `setInterval`/`setTimeout` trong workers/services (WebSocketManager, PriceAlertWorker, StrategiesWorker, TelegramService, RealtimeOCDetector, …).
- **Rủi ro**
  - Leaks/timers không stop đúng khi reload, khó test.
- **Phương án**
  - Chuẩn hóa interface `start()/stop()` và đảm bảo `stop()` clear toàn bộ timers.
  - Add smoke test cho start/stop.

### 8) Repo có rất nhiều file “report/summary” ở root (noise)
- **Dấu hiệu**
  - Nhiều file `*_SUMMARY.md`, `*_REPORT.md`, `.txt` nằm ở root.
- **Rủi ro**
  - Khó tìm tài liệu chính thống, tăng chi phí onboarding.
- **Phương án**
  - Gom về `docs/` theo taxonomy (monitoring, fixes, architecture, operations).
  - Giữ 1-2 entry docs: `docs/START_HERE.md`, `docs/QUICKSTART.md`.

## Đề xuất thứ tự thực hiện
1) P0.1 + P1.5: dọn `.gitignore`, remove artefacts khỏi git.
2) P0.2: kiểm tra `config/config.json` và chuyển sang cơ chế config an toàn.
3) P0.3: fix shutdown `telegramBot` null-safe và refactor shutdown.
4) P1.4: tách seeding app config + dedupe keys.
5) P1.6: sửa `orderLogger` level.

## Ghi chú
- Repo đã có `tests/` và cấu hình `jest`, nhưng chưa đánh giá coverage/quality ở đây.
- Nếu bạn muốn, mình có thể tiếp tục audit sâu hơn (DB migrations, concurrency, idempotency trong workers, rate limit/backoff, error taxonomy) và bổ sung thêm issue vào file này.

