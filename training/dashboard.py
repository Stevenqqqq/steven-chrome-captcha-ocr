from __future__ import annotations

import argparse
import base64
import html
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ocr_server


def collect_dashboard_data(
    training_root: Path = ocr_server.TRAINING_ROOT,
    *,
    seed: int = 20260811,
    split_strategy: str = "label_grouped",
    max_error_samples: int = 36,
) -> dict:
    training_root = Path(training_root)
    report = ocr_server.build_feedback_report(training_root)
    manifest = ocr_server.build_dataset_manifest(
        training_root,
        seed=seed,
        split_strategy=split_strategy,
    )

    char_counts = Counter()
    length_counts = Counter()
    confusions = Counter()
    error_samples = []

    for entry in manifest.get("entries") or []:
        label = str(entry.get("label") or "")
        length_counts[len(label)] += 1
        char_counts.update(label)

    feedback_dir = training_root / "feedback"
    samples_dir = training_root / "samples"
    if feedback_dir.is_dir():
        for path in sorted(feedback_dir.glob("*.json"), reverse=True):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                correct = ocr_server.normalize_answer(record.get("correct_answer"))
                predicted = ocr_server.normalize_answer(record.get("predicted_answer"))
                if not correct or not predicted or correct == predicted:
                    continue
                if len(correct) == len(predicted):
                    for exp_ch, pred_ch in zip(correct, predicted):
                        if exp_ch != pred_ch:
                            confusions[f"{exp_ch} → {pred_ch}"] += 1
                image_file = str(record.get("image_file") or "")
                image_path = (samples_dir / image_file).resolve()
                if len(error_samples) < max_error_samples and image_path.is_file():
                    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
                    error_samples.append({
                        "image_file": image_file,
                        "image_uri": f"data:image/png;base64,{encoded}",
                        "expected": correct,
                        "predicted": predicted,
                        "error_type": str((record.get("error_analysis") or {}).get("type") or "unknown"),
                        "occurrences": int(record.get("occurrences") or 1),
                    })
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue

    digits = {d: char_counts[d] for d in "0123456789"}
    letters = {ch: char_counts[ch] for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"}
    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "report": report,
        "manifest_summary": {
            "seed": manifest["seed"],
            "split_strategy": manifest["split_strategy"],
            "unique_verified_images": manifest["unique_verified_images"],
            "split_counts": manifest["split_counts"],
            "label_conflicts": len(manifest["label_conflicts"]),
            "ready_for_trial_training": manifest["ready_for_trial_training"],
            "ready_for_model_replacement": manifest["ready_for_model_replacement"],
        },
        "length_counts": dict(sorted(length_counts.items())),
        "digits": digits,
        "letters": letters,
        "top_confusions": confusions.most_common(12),
        "error_samples": error_samples,
    }


def render_dashboard_html(data: dict) -> str:
    ms = data["manifest_summary"]
    report = data["report"]
    splits = ms["split_counts"]
    digit_ready = sum(1 for v in data["digits"].values() if v >= 20)
    max_letter = max([1, *data["letters"].values()])
    max_digit = max([20, *data["digits"].values()])

    def bar_rows(items: dict[str, int], max_val: int, target: int | None = None) -> str:
        rows = []
        for sym, count in items.items():
            pct = min(100.0, (count / max_val) * 100.0)
            cls = "bar-fill ok" if (target is None or count >= target) else "bar-fill warn"
            rows.append(
                f'<div class="bar-cell">'
                f'<span class="bar-sym">{html.escape(sym)}</span>'
                f'<div class="bar-track"><div class="{cls}" style="width:{pct:.1f}%"></div></div>'
                f'<span class="bar-num">{count}</span>'
                f"</div>"
            )
        return "".join(rows)

    confusion_rows = "".join(
        f'<tr><td class="mono">{html.escape(pair)}</td><td class="num">{cnt}</td></tr>'
        for pair, cnt in data["top_confusions"]
    ) or '<tr><td colspan="2" class="muted">目前無字元混淆紀錄</td></tr>'

    sample_cards = "".join(
        f'<article class="sample-card">'
        f'<div class="sample-thumb"><img src="{html.escape(s["image_uri"])}" alt="{html.escape(s["expected"])}" loading="lazy"></div>'
        f'<div class="sample-meta">'
        f'<div><span class="badge-exp">{html.escape(s["expected"])}</span>'
        f' <span class="muted">←</span> '
        f'<span class="badge-pred">{html.escape(s["predicted"])}</span></div>'
        f'<div class="sample-sub">{html.escape(s["error_type"])} · ×{s["occurrences"]}</div>'
        f"</div></article>"
        for s in data["error_samples"]
    ) or '<p class="muted">尚無可顯示的錯題縮圖</p>'

    error_type_rows = "".join(
        f'<tr><td>{html.escape(k)}</td><td class="num">{v}</td></tr>'
        for k, v in (report.get("unique_image_error_types") or {}).items()
    ) or '<tr><td colspan="2" class="muted">無資料</td></tr>'

    return f"""<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Steven OCR 資料集與錯題審查儀表板</title>
<style>
  :root {{
    color-scheme: dark;
    --bg: #0c0f14;
    --card: #12161d;
    --well: #0e1218;
    --secondary: #1b222d;
    --border: #273140;
    --fg: #eef2f7;
    --muted: #8f9cad;
    --primary: #3b82f6;
    --success: #22c55e;
    --warning: #f59e0b;
    --danger: #ef4444;
    --info: #38bdf8;
    --font-sans: "Segoe UI", "Microsoft JhengHei UI", system-ui, sans-serif;
    --font-mono: Consolas, "Cascadia Mono", ui-monospace, monospace;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font-family: var(--font-sans); }}
  .wrap {{ max-width: 1120px; margin: 0 auto; }}
  header {{ display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }}
  h1 {{ margin: 0; font-size: 20px; font-weight: 700; }}
  .meta {{ font-size: 12px; color: var(--muted); font-family: var(--font-mono); }}
  .kpis {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 18px; }}
  .kpi {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }}
  .kpi-label {{ font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }}
  .kpi-val {{ font-size: 26px; font-weight: 700; font-family: var(--font-mono); }}
  .kpi-sub {{ font-size: 11.5px; color: var(--muted); margin-top: 5px; }}
  .ok {{ color: var(--success); }}
  .warn {{ color: var(--warning); }}
  .grid-2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }}
  @media (max-width: 820px) {{ .grid-2 {{ grid-template-columns: 1fr; }} }}
  .panel {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }}
  h2 {{ margin: 0 0 12px; font-size: 13.5px; font-weight: 700; color: var(--fg); display: flex; justify-content: space-between; align-items: center; }}
  .pill {{ font-family: var(--font-mono); font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background: var(--secondary); border: 1px solid var(--border); color: var(--info); font-weight: 600; }}
  .bar-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 14px; }}
  .bar-cell {{ display: grid; grid-template-columns: 20px 1fr 34px; align-items: center; gap: 8px; font-size: 11.5px; }}
  .bar-sym {{ font-family: var(--font-mono); font-weight: 700; color: var(--fg); text-align: center; }}
  .bar-track {{ height: 8px; border-radius: 999px; background: var(--well); border: 1px solid var(--border); overflow: hidden; }}
  .bar-fill {{ height: 100%; border-radius: 999px; }}
  .bar-fill.ok {{ background: var(--success); }}
  .bar-fill.warn {{ background: var(--warning); }}
  .bar-num {{ font-family: var(--font-mono); font-size: 11px; color: var(--muted); text-align: right; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  td, th {{ padding: 7px 6px; border-bottom: 1px solid var(--border); text-align: left; }}
  .num {{ text-align: right; font-family: var(--font-mono); font-weight: 600; }}
  .mono {{ font-family: var(--font-mono); font-weight: 700; }}
  .muted {{ color: var(--muted); }}
  .gallery {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(195px, 1fr)); gap: 10px; }}
  .sample-card {{ background: var(--well); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }}
  .sample-thumb {{ height: 84px; border-radius: 6px; background: #0a0d12; border: 1px solid var(--border); padding: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 8px; }}
  .sample-thumb img {{ width: 100%; height: 100%; object-fit: contain; display: block; }}
  .sample-meta {{ font-size: 11.5px; }}
  .badge-exp {{ font-family: var(--font-mono); font-weight: 700; color: var(--success); }}
  .badge-pred {{ font-family: var(--font-mono); font-weight: 700; color: var(--warning); }}
  .sample-sub {{ font-size: 10.5px; color: var(--muted); margin-top: 4px; }}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Steven OCR · 資料集與錯題審查儀表板</h1>
      <div class="meta">strategy={html.escape(ms["split_strategy"])} · seed={ms["seed"]} · {html.escape(data["generated_at_utc"][:19])}Z</div>
    </header>

    <section class="kpis">
      <div class="kpi">
        <div class="kpi-label">不重複已驗證樣本</div>
        <div class="kpi-val">{ms["unique_verified_images"]}</div>
        <div class="kpi-sub">train {splits.get("train", 0)} / val {splits.get("validation", 0)} / test {splits.get("test", 0)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">標籤衝突 / 無效紀錄</div>
        <div class="kpi-val {'ok' if ms['label_conflicts'] == 0 else 'warn'}">{ms["label_conflicts"]} / {len(report.get("invalid_records") or [])}</div>
        <div class="kpi-sub">總出現次數 {report.get("total_occurrences", 0)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">數字覆蓋達標（目標每字 ≥ 20）</div>
        <div class="kpi-val {'ok' if digit_ready == 10 else 'warn'}">{digit_ready} / 10</div>
        <div class="kpi-sub">英數正式版 gate 必備條件</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">模型替換資料門檻（2,000 張）</div>
        <div class="kpi-val">{min(100, round(ms["unique_verified_images"] / 20))}%</div>
        <div class="kpi-sub">試訓門檻（200）：{"已達成" if ms["ready_for_trial_training"] else "未達成"}</div>
      </div>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>數字字元分佈（0–9）<span class="pill">目標 ≥ 20 / 字</span></h2>
        <div class="bar-grid">{bar_rows(data["digits"], max_digit, target=20)}</div>
      </div>
      <div class="panel">
        <h2>最常見字元混淆 Top 12<span class="pill">expected → predicted</span></h2>
        <table><tbody>{confusion_rows}</tbody></table>
      </div>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>字母字元分佈（A–Z）<span class="pill">共 {sum(data["letters"].values())} 字元</span></h2>
        <div class="bar-grid">{bar_rows(data["letters"], max_letter)}</div>
      </div>
      <div class="panel">
        <h2>錯誤類型分佈<span class="pill">依唯一圖片統計</span></h2>
        <table><tbody>{error_type_rows}</tbody></table>
      </div>
    </section>

    <section class="panel">
      <h2>錯題縮圖快速審查牆<span class="pill">最多顯示 {len(data["error_samples"])} 張</span></h2>
      <div class="gallery">{sample_cards}</div>
    </section>
  </div>
</body>
</html>
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate local HTML dataset & confusion inspection dashboard.")
    parser.add_argument("--training-root", type=Path, default=ocr_server.TRAINING_ROOT)
    parser.add_argument("--seed", type=int, default=20260811)
    parser.add_argument("--split-strategy", choices=("image_hash", "label_grouped"), default="label_grouped")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data = collect_dashboard_data(
        args.training_root,
        seed=args.seed,
        split_strategy=args.split_strategy,
    )
    html_text = render_dashboard_html(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html_text, encoding="utf-8")
    print(f"Dashboard written to {args.output} ({data['manifest_summary']['unique_verified_images']} unique images)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
