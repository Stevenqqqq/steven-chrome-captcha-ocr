# Steven 的 Chrome 驗證碼 OCR 助手

> Beta：目前適合人工在場、按一次快捷鍵辨識並填入的輔助流程。它不是自動搶票或自動送出工具，也不保證每一種驗證碼都能正確辨識。

這是一個獨立的 Windows／Chrome 本機 OCR 專案，不會修改其他搶票或駕照系統。Chrome 擴充功能只在開啟工具列按鈕或使用快捷鍵時取得目前分頁的暫時權限；圖片只送到本機 `127.0.0.1:8765`。

## 目前驗證狀態

- ToolWeb 四字母固定測試：exact `50/55 = 90.91%`、character `97.73%`、no-answer `0%`。
- 外部 CC0 四字英數 final（非 ToolWeb release evidence）：exact `568/689 = 82.44%`、character `93.72%`。
- 同一外部 final 的純數字子集：exact `184/193 = 95.34%`、character `98.58%`。
- 專案自訂的 v1 發布門檻尚未通過，因此目前版本應標示為 beta，不能宣稱已達 production-ready 準確率。

外部數據只用來檢查一般英數能力；不同網站的字型、背景、扭曲與干擾線差異很大，不能把外部成績當成指定網站保證。

## 系統需求

- Windows 10／11 64-bit
- Python 3.10 64-bit
- Chrome 127 或更新版本
- 約 1 GB 可用空間供 Python 套件使用

## 第一次安裝

1. 雙擊 `安裝依賴.bat`。
2. 雙擊 `啟動OCR服務.bat`，將終端保持開啟或最小化；關閉終端就會停止 OCR 服務。
3. 雙擊 `開啟Chrome擴充功能頁.bat`。
4. 開啟右上角「開發人員模式」。
5. 點「載入未封裝項目」。
6. 選擇本專案內的 `extension` 資料夾。
7. 將「Steven 驗證碼 OCR 助手」固定在 Chrome 工具列。

安裝程式會在專案內建立 `.venv`，不會把依賴直接裝進全域 Python。若要重建環境，可先關閉 OCR 服務，再刪除 `.venv` 並重新執行安裝程式。

GitHub 發布版預設使用 `ddddocr` 套件內建的 `official` 模型，因此不需要另外下載 ONNX。若你自行擁有可合法散布的 custom ONNX，可依 [models/README.md](models/README.md) 放入本機；custom 模型不是必要條件，也不會跟著 repository 上傳。

## 使用

1. 先啟動 `啟動OCR服務.bat`。
2. 開啟含有可見驗證碼與輸入框的網站。
3. 按 `Ctrl+Shift+Y` 即可辨識並填入；成功後彈窗會自動關閉，可直接按 `Enter` 送出。進入下一題後再按一次會自動偵測新圖片。若 OCR 字元數與網頁要求不同，擴充功能會拒絕自動填入並保留該題供人工回報。

## 回報辨識錯題

每次辨識後，擴充功能會保留該題的短期回報代碼：

1. 如果答案正確，按「答案正確／下一題」繼續，不會保存圖片。
2. 如果答案錯誤，輸入畫面顯示的正確答案，按「保存錯題」。
3. 錯題圖片會保存到 `training/samples/`，模型投票紀錄會保存到 `training/feedback/`。

相同圖片與正解不會重複寫入，只會累加出現次數。同圖如被輸入不同正解，會拒絕保存，避免污染訓練資料。每筆錯題會標記漏字、多字、字元誤判或相鄰調換等類型。

產生錯題統計報告：

```powershell
py -3.10 ocr_server.py --feedback-report --report-output "$env:TEMP\steven_ocr_feedback_report.json"
```

## 主動學習資料

本機 API v6 支援將 ToolWeb 練習頁「已被網站判定正確」的答案存為 `site_accepted` 樣本，並在辨識回應加入 `active_learning` 分歧評分。網站未確認、答錯或來源不明的資料不會寫入。完整操作與採樣規則請見 `training/ACTIVE_LEARNING.md`。

產生去重後的訓練、驗證與測試清單：

```powershell
py -3.10 ocr_server.py --dataset-manifest --manifest-seed 20260809 --manifest-output "$env:TEMP\steven_ocr_dataset_manifest.json"
```

新一輪獨立評估應使用 label-grouped split，避免相同完整答案跨越 train 與 validation/test：

```powershell
py -3.10 ocr_server.py --dataset-manifest --manifest-seed 20260811 --manifest-split-strategy label_grouped --manifest-output "$env:TEMP\steven_ocr_dataset_manifest_label_grouped.json"
```

手動流程只有按下「保存錯題」才會寫入；主動學習流程則只在 ToolWeb 練習頁明確接受答案後，透過 `/verified-sample` 寫入。不保存完整網頁、網址、姓名或其他欄位。短期回報代碼保存在目前 Chrome 工作階段，OCR 服務重新啟動後，尚未確認的題目會失效。保存資料不會立即訓練或修改 ONNX 模型。

資料集達 200 張後，可使用 `training/trial_pipeline.py` 匯出 train split 與建立現行模型基準。完整命令與候選模型 gate 請見 `training/README.md`；validation/test 不會交給 trainer，候選也不會自動覆蓋正式模型。

## GitHub 發布準確率門檻

發布前使用 label-grouped manifest，避免相同完整答案跨越 train 與 validation/test。正式 gate：

- ToolWeb 四字母：test exact accuracy 至少 `95%`、character accuracy 至少 `98.5%`、no-answer 不超過 `1%`。
- 英數混合：test exact accuracy 至少 `92%`、character accuracy 至少 `98%`、no-answer 不超過 `2%`。
- 英數 test 至少 `200` 張；每個數字 `0–9` 與 `O/0、I/1、Z/2、S/5、G/6、B/8` 每個符號至少出現 `20` 次。

產生 release readiness 報告：

```powershell
py -3.10 training\release_gate.py --manifest <你的固定manifest.json> --baseline <你的baseline.json> --policy <你的policy.json> --output "$env:TEMP\steven_ocr_release_readiness.json"
```

若數字覆蓋不足，英數模式會標示未驗證；不會用純字母成績冒充英數準確率。

### Synthetic 英數開發基準

可先在一個空的外部目錄產生 200 張 deterministic 英數圖片，用來發現 `O/0、I/1、Z/2、S/5、G/6、B/8` 混淆：

```powershell
py -3.10 training\alphanumeric_benchmark.py --output-dir "$env:TEMP\steven_ocr_alphanumeric_dev"
```

這個工具只是 synthetic development benchmark；圖片不得複製到 `training/samples`，成績不會計入 release gate，也不能代替目標網站的真實英數 test set。

若快捷鍵與其他擴充功能衝突，可在 `chrome://extensions/shortcuts` 自訂按鍵。

可先用 `測試頁面.html` 驗證操作。Chrome 內建頁面、Chrome 線上應用程式商店及部分跨網域 iframe 不允許擴充功能注入，這些頁面不適用。

## OCR 邏輯

- `official`：ddddocr 內建模型。
- `universal`：通用自訂 ONNX 模型。
- `tixcraft_tm`：另一組自訂 ONNX 模型。
- 網頁提供安全的 PNG/JPEG/WebP Base64，或瀏覽器允許讀取同網域 `<img>` 像素時，優先辨識精確原圖；跨網域安全限制下才使用畫面裁切。
- 深色背景搭配亮色文字時會先正規化明暗極性，並加入以邊界背景亮度補邊 2 px 的灰階版本，再送入 OCR。
- 每組模型會嘗試原圖、灰階、強化對比、二值化及放大版本。
- 最終答案優先採用不同模型都同意的結果，不是直接使用第一個答案。
- 單一 preferred 預處理版本通常保有優先權；只有其他答案至少取得 4 票且領先至少 4 票時，才以強共識覆寫，避免一張 noisy preferred 圖壓過多個一致變體。

OCR 圖片只傳到本機 `http://127.0.0.1:8765`，服務不接受一般網站跨來源呼叫。

## 安全、隱私與使用界線

- 僅在你有權操作的網站與測試環境使用，並遵守網站條款與適用法律。
- 本專案不會自動按下最終送出，也不提供繞過網站存取控制的保證。
- `training/samples/`、`training/feedback/` 與 `tests/results/` 都是本機生成資料，預設不會提交到 Git。
- 請勿保存姓名、證件、電話、Email、完整頁面截圖、Cookie 或登入憑證。
- 安全性問題請依 [SECURITY.md](SECURITY.md) 使用 GitHub 私密漏洞回報。

## 開發與測試

雙擊 `執行測試.bat`，或手動執行：

```powershell
py -3.10 -B -m unittest discover -s tests -p "test*.py" -v
node --test tests\test_background.js tests\test_captcha_image.js tests\test_detect_helpers.js tests\test_feedback_helpers.js tests\test_popup_startup.js
node --check extension\popup.js
py -3.10 -B ocr_server.py --check
```

授權：本專案原始碼採 [MIT License](LICENSE)。第三方套件與模型請見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
