# Playable Wrapper

Bản web (HTML/JS, chạy localhost) của `Tools/Playable/wrap_playable.py` (nhánh `PlayableAds/CF`, repo game-hub).
Nhận file export single-file `unityads` từ Luna Playground, xuất:

- `<name>_applovin.html` — thêm shim AppLovin (MRAID 2.0) + `<script src="mraid.js">`
- `<name>_mintegral.zip` — `index.html` ở gốc zip, shim Mintegral (`gameStart/gameClose` ↔ `gameReady/gameEnd/install`)

Đồng thời gỡ 2 thứ review tool hay flag: `console.warn(new Error)` devtools-probe và block remote-debug override console.

Không cần `npm install`, chỉ cần Node ≥ 18.

## Chạy

```bash
npm start                 # http://localhost:5173
node server.js --port 8080
```

Trên web: kéo thả file `.html` → kiểm tra (link store đã bake, orientation lock, debug block) → điền link iOS/Android nếu cần → **Wrap playable** → Download / Preview.

**Preview** chạy output trong khung thiết bị (chọn máy, xoay ngang/dọc) với SDK giả:
- AppLovin: mock `mraid` (thay cho `mraid.js`), CTA hiện ra dưới dạng `mraid.open(url)`.
- Mintegral: mock `gameReady/gameEnd/install`, có nút gọi `gameStart()` / `gameClose()` như SDK thật — game giữ pause cho tới khi gọi `gameStart()`.
- Panel Events log các event `luna:*`, CTA và lỗi JS. Harness chỉ có trong preview, **không** nằm trong file tải về.

## CLI (cùng tham số với bản Python)

```bash
node cli.js <input.html> -o <outdir> \
  [--ios https://apps.apple.com/app/id...] \
  [--android https://play.google.com/store/apps/details?id=...] \
  [--networks applovin,mintegral] [--keep-debug-error] [--keep-remote-debug] [--start-ms N]
```

## Cấu trúc

```
public/wrap-core.js   logic wrap (port 1:1 từ Python) — dùng chung web + CLI
public/zip.js         ZIP writer tối giản (deflate qua CompressionStream / zlib)
public/app.js         UI + preview harness
server.js             static server không dependency
cli.js                CLI Node
test/parity.test.js   so output từng byte với test/wrap_playable.py (bản gốc)
```

## Test parity

```bash
npm test                                   # fixture tổng hợp
node test/parity.test.js path/to/export.html ...   # thêm export Luna thật
```

So sánh `_applovin.html` và `index.html` trong `_mintegral.zip` của bản JS với bản Python gốc (cần `python3`).
Khi bản Python trên nhánh `PlayableAds/CF` đổi, copy lại vào `test/wrap_playable.py` rồi chạy test.
