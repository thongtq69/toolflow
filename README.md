# toolflow

Bot tự động hoá Google Labs Flow để gen frame ảnh + ref-chain liên tục cho video. Giao diện UI realtime: timeline frame, gallery 4 variants, log SSE, edit prompt, custom frame, parallel multi-tab.

## Yêu cầu

- macOS / Linux / Windows + WSL
- Node.js ≥ 18
- Tài khoản Google đã enable Flow (https://labs.google/fx/tools/flow)

## Cài đặt

```bash
git clone https://github.com/thongtq69/toolflow.git
cd toolflow
npm install      # tự cài Playwright Chromium
npm start
```

Mở trình duyệt: **http://localhost:3737**

Lần đầu chạy sẽ hiện **Setup Wizard** (3 bước):

1. **Cấu hình cơ bản** — số worker (1–4), cooldown, headless
2. **Đăng nhập Google** — bấm "Mở browser" → đăng nhập tay → "Tôi đã login xong"
3. **Project Flow + frames.json** — paste URL project Flow của anh + paste/edit frames.json

Sau setup, UI vào trạng thái idle. Bấm **▶ Start** chạy frame F01.

## UI features

- **Frame timeline trái**: status badge (PENDING / RUNNING / WAITING_PICK / PICKED / FAILED) + ref chain
- **View mode**: click frame xem variants từ attempts cũ (không gen lại). Dropdown chọn attempt.
- **Re-pick**: đổi variant đã pick mà không cần re-gen.
- **Edit Action**: textarea sửa prompt từng frame, save override. Badge `✏ EDITED`.
- **+ New Frame**: thêm frame ad-hoc với prompt + ref tự chọn.
- **Archive attempts**: mỗi gen mới → file cũ tự move vào `output/F0X/attempts/<timestamp>/`. Không mất ảnh khi retry.
- **Live log SSE**: mọi step của bot hiện realtime, color-coded info/warn/error.
- **⚡ Batch parallel**: nếu workers > 1, chọn list frame_ids → workers chạy song song, mỗi frame pause `waiting_pick` riêng.
- **⚙ Settings**: thay đổi config bất cứ lúc nào (project URL, workers, cooldown).

## Cấu trúc thư mục

```
toolflow/
├── server.js              — Express backend wrap Playwright
├── public/index.html      — UI single-page (vanilla JS + Tailwind CDN)
├── frames.example.json    — Template storyboard 10 frame Resort
├── config.json            — Auto-tạo lúc setup (gitignored)
├── frames.json            — Storyboard (paste qua wizard, gitignored)
├── profile/               — Chromium profile (cookies login, gitignored)
└── output/                — Ảnh gen + state.json (gitignored)
    └── F01/
        ├── v1.png  v2.png  v3.png  v4.png
        ├── meta.json
        └── attempts/
            └── 2026-05-08T10-00-00/
                ├── v1.png ...
                └── meta.json
```

## API endpoints chính

```
GET  /api/state                — frames + state + jobs
GET  /api/frame/:id            — current + attempts list
GET  /api/config               — runtime config
PUT  /api/config               — sửa config
GET  /api/setup/status         — wizard state
POST /api/setup/launch-browser — mở browser login
POST /api/setup/save-frames    — upload frames.json
POST /api/start                — chạy serial HITL từ frame X
POST /api/batch-start          — parallel batch nhiều frame
POST /api/pick {frame_id, variant_idx}
POST /api/repick {frame_id, attempt_id, variant_idx}
POST /api/skip / /api/retry / /api/stop / /api/reset
POST /api/override-prompt {frame_id, action}
POST /api/add-frame {frame_id, topic, action, default_reference}
DELETE /api/custom-frame/:id
GET  /api/logs                 — SSE log stream
GET  /health                   — health check
```

## ENV overrides (nếu không muốn dùng UI config)

```bash
PROFILE_DIR=./profile
OUTPUT_DIR=./output
FRAMES_PATH=./frames.json
FLOW_PROJECT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
WORKERS=2
HEADLESS=false
PORT=3737
COOLDOWN_MIN=20
COOLDOWN_MAX=50
TYPE_DELAY_MS=80
```

## Lưu ý anti-detection

Google Labs Flow có bot detection. Khi thấy badge `FAILED — We noticed some unusual activity`:

- Tăng `COOLDOWN_MIN/MAX` (60–120s)
- Đặt `WORKERS=1` (parallel tăng risk flag)
- Cooldown 30 phút giữa các session
- Pivot sang Vertex AI Imagen 4 + Veo 3.1 nếu cần production scale

## License

MIT
