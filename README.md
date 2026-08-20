# FreeCap 免費字幕

字幕，留在你的電腦裡。

FreeCap 是一個免費、開源、local-first 的影片字幕工作台。它可以在瀏覽器中使用 Whisper 辨識中英文語音、編輯字幕、輸出 SRT／VTT，並把字幕燒錄成 MP4。影片和模型推論留在你的裝置上，不需要 API key，也不會上傳影音檔。

## 使用網頁版

```bash
npm install
npm run dev
```

開啟 `http://localhost:3000`，拖入 MP4、MOV、WebM、MKV 或音訊檔。第一次使用某個模型時，瀏覽器會從 Hugging Face 下載並快取量化模型；之後可在相同瀏覽器重用。

瀏覽器版適合短片。超過約 500 MB 或 60 分鐘的影片，建議使用本機 MCP 助手；瀏覽器版仍會在支援的裝置上嘗試處理。

辨識結果會依標點與 Whisper 停頓切句，中文每行預設 16 字、英文每行 42 字，單段目標為 1–6 秒。編輯器支援時間輸入、切分、合併、搜尋取代、復原／重做與字幕樣式調整。

## MCP 安裝

需要 Node.js 22 或更新版本。Claude Code、Codex 與 Cursor 都可以啟動同一個本機 MCP 程序：

```bash
npx -y github:hellomileshsu/freecap#v1.1 mcp
```

Cursor 的 `mcp.json`：

```json
{
  "mcpServers": {
    "freecap": {
      "command": "npx",
      "args": ["-y", "github:hellomileshsu/freecap#v1.1", "mcp"]
    }
  }
}
```

也可以先查看所有設定片段：

```bash
npx -y github:hellomileshsu/freecap#v1.1 setup
```

可用工具：

- `start_transcription`：輸入絕對本機影片路徑，建立非同步辨識任務。
- `get_job`：查詢任務進度、字幕內容與輸出路徑。
- `update_cues`：更新字幕文字和起訖時間。
- `export_subtitles`：輸出 UTF-8 SRT、VTT 或 JSON。
- `start_render`：用本機 FFmpeg 將字幕燒錄成 MP4。
- `cancel_job`：取消辨識或轉檔並清理暫存檔。

所有寫入操作都會建立新檔案，不覆寫原始影片。預設輸出目錄是來源影片旁的 `FreeCap Output`。可以用 `FREECAP_ALLOWED_DIRS` 限制 MCP 可以讀取的資料夾，例如：

```bash
FREECAP_ALLOWED_DIRS="$PWD/Video" npx -y github:hellomileshsu/freecap#v1.1 mcp
```

## 本機橋接服務

若要讓自訂網頁或另一個本機 UI 查詢 MCP 任務，可以啟動 loopback bridge：

```bash
npm run mcp:bridge
```

服務只綁定 `127.0.0.1`，並在 stderr 印出一次性配對權杖。HTTP API 位於 `/health`、`/jobs`、`/jobs/:id`、`/jobs/:id/cues`、`/jobs/:id/export`、`/jobs/:id/render` 與 `/jobs/:id/cancel`。

## ChatGPT 相容性

ChatGPT 網頁版目前不能直接啟動本機 MCP；它需要遠端 MCP（並且完整寫入權限受方案與工作區設定限制）。因此 FreeCap 的零成本支援先以 Claude Code、Cursor、Codex 為主。未來可以透過 Secure MCP Tunnel 增加遠端路徑，但不會讓影片自動上傳到 FreeCap。

## 授權

FreeCap 以 GPL-3.0-or-later 發佈。Whisper ONNX 權重與 FFmpeg 的授權及第三方通知請見各自套件與模型頁面。
