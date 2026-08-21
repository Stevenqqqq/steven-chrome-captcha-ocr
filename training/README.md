# OCR 訓練資料規格

目前正式版本仍使用三組既有 OCR 與投票。擴充功能內的「保存錯題」會自動建立以下資料：

- `samples/正確答案__時間_代碼.png`：只含驗證碼裁圖。
- `feedback/正確答案__時間_代碼.json`：包含 OCR 原答案、候選答案、圖片 SHA-256、出現次數與錯誤類型。

同一張圖片以 SHA-256 去重；正解相同時只累加 `occurrences`，正解不同時拒絕寫入。錯誤類型包含 `missing_character`、`repeated_character_missing`、`extra_character`、`substitution`、`transposition` 等。

可以產生不含圖片內容的統計報告：

```powershell
py -3.10 ocr_server.py --feedback-report --report-output tests\results\feedback_report.json
```

未來要訓練監理站專用模型時：

1. 使用擴充功能回報錯題，或將驗證碼原圖放進 `training/samples/`。
2. 檔名使用 `正確答案__流水號.png`，例如 `A7K2__000001.png`。
3. 不要收集身分證、姓名、電話、Email 或完整網頁截圖。
4. 建議至少累積 2,000 張已人工確認的圖片，再切分訓練、驗證及測試資料。
5. 同一張圖片不得同時出現在訓練集與測試集。

只有 OCR 填錯時才值得保留圖片；正確標籤比圖片數量重要。

## 200 張試訓流程

資料集達 200 張後，只能建立候選模型，不得直接覆蓋 `models/`。先把固定 manifest 的 `train` split 匯出成官方 `dddd_trainer` 可讀格式；`validation` 與 `test` 不會被匯出給 trainer：

```powershell
py -3.10 training\trial_pipeline.py prepare --output "$env:TEMP\steven_ocr_trial_dataset"
```

匯出內容包含 `images/`、`labels.txt`、`provenance.json` 與 `trainer_settings.json`。目前核對的官方 trainer 是 [sml2h3/dddd_trainer](https://github.com/sml2h3/dddd_trainer)，reviewed commit 為 `5fd0d0b5bb83bf44a5692c9d253b7d928e05e673`。訓練需要額外安裝 PyTorch、TorchVision 與 ONNX 工具；不要在未確認安裝範圍時自動安裝大型 GPU 套件。

先建立現行模型的保留集基準：

```powershell
py -3.10 training\trial_pipeline.py evaluate --output tests\results\current_baseline_200.json
```

候選 ONNX 產生後再比較：

```powershell
py -3.10 training\trial_pipeline.py evaluate `
  --candidate-onnx "C:\path\to\candidate.onnx" `
  --candidate-charsets "C:\path\to\charsets.json" `
  --output tests\results\candidate_comparison.json
```

候選必須在 validation 不退步、test 嚴格優於現行 ensemble，且 no-answer 不增加，才會標記為 `promising_trial_candidate`。即使通過，`may_replace_production_model` 仍固定為 `false`；正式替換仍需至少 2,000 張與獨立驗收。
