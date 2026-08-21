# ToolWeb 主動學習採集規範

這個流程只能用於 `https://toolweb.app/tools/captcha-practice` 練習頁，不得擴大到正式售票、登入或其他 CAPTCHA 網站。

## 可信標籤條件

1. 先將當前 CAPTCHA 圖片傳給本機 `/recognize?expectedLength=4`，保留回傳的 `report_id` 與 OCR `answer`。
2. 由 Luna 或主代理獨立辨識候選答案，再將該候選答案送到練習頁。
3. 只有網站明確判定正確時，才能呼叫 `/verified-sample`。
4. 網站判定錯誤時，不得猜測正解、不得保存標籤；更新題目後繼續。

`/verified-sample` 只接受以下 JSON：

```json
{
  "reportId": "32 位十六進位回報代碼",
  "correctAnswer": "ABCD",
  "source": "toolweb_practice",
  "siteAccepted": true,
  "evidence": {
    "captchaChanged": true,
    "attemptsBefore": 41,
    "attemptsAfter": 42
  }
}
```

服務器會將驗證方式固定為 `site_accepted`，不接受其他主動學習來源。`attemptsAfter` 必須比 `attemptsBefore` 多 1，而且 CAPTCHA 圖片必須已更換；否則拒絕寫入。

## 採樣優先級

- OCR 錯、代理答案被網站接受：不論分歧分數，每題保存。
- OCR 與代理答案相同且網站接受：依 `/recognize` 回傳的 `active_learning.priority` 採樣。
  - `high`：全部保存。
  - `medium`：固定抽樣約 35%。
  - `low`：固定抽樣約 10%。
- OCR 與代理都錯誤：沒有可信標籤，不保存。

`active_learning.reasons` 會標示長度不符、preprocessing variants 分歧、票差過小、solver preferred 分歧或強共識覆寫。抽樣決策只能在網站接受答案後執行，不能把模型自己的分歧當作正確標籤。

服務會用圖片 SHA-256 產生固定 `sampling_bucket`，並回傳 `sample_recommended`；相同圖片重跑會得到同一抽樣決策，不使用臨時亂數。採集器在模型與獨立答案相同時依 `sample_recommended` 保存；兩者不同且網站接受時忽略抽樣 bucket、直接保存。

初次只採集 100 題來驗證流程。不要並行或高速請求第三方網站；每題都必須等待網站結果後才能繼續。

## 資料切分

產生固定、以圖片 SHA-256 去重的資料清單：

```powershell
py -3.10 ocr_server.py --dataset-manifest --manifest-seed 20260809 --manifest-output tests\results\dataset_manifest.json
```

每張圖片只會出現在 `train`、`validation` 或 `test` 其中一組。同圖有不同正解時會從清單排除並列入 `label_conflicts`。

新一輪模型比較使用 exact-label grouped split，讓同一個完整答案只能屬於一個 split：

```powershell
py -3.10 ocr_server.py --dataset-manifest --manifest-seed 20260811 --manifest-split-strategy label_grouped --manifest-output tests\results\dataset_manifest_label_grouped.json
```

舊的 image-hash manifest 必須保留，不能覆蓋，才能重現歷史基準。

- 200 張不同驗證圖：可進行試験訓練，不可替換正式模型。
- 2,000 張不同且人工或網站確認的圖：才能考慮進入新舊模型獨立驗收。

訓練不得在每題完成後即時更新權重。必須批次訓練，並且只在獨立 `test` 結果改善時才能替換 ONNX。
