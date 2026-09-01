from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[1]
OLD_CACHE = Path(r"D:\StevenOCR-Training\artifacts\glyph_reranker_fresh_v2\feature_cache.json")
HARD_MANIFEST = Path(r"D:\StevenOCR-Training\artifacts\toolweb_hard_recovery_20260824\split_v3\validation_manifest.json")
REP_MANIFEST = Path(r"D:\StevenOCR-Training\artifacts\toolweb_representative_1000_20260831\validation_manifest.json")


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"JSON object expected: {path}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rows() -> list[dict]:
    values = []
    old = load(OLD_CACHE)
    if old.get("sealed_test_images_read") is not False:
        raise RuntimeError("old validation cache sealed guard invalid")
    for record in old["records"]:
        if record["split"] == "validation":
            values.append({
                "dataset": "easy", "image_file": record["image_file"],
                "image_path": str(WORKSPACE / "training" / "samples" / record["image_file"]),
                "image_sha256": record["image_sha256"], "label": record["expected"],
            })
    for dataset, manifest_path in (("hard", HARD_MANIFEST), ("representative", REP_MANIFEST)):
        for entry in load(manifest_path)["entries"]:
            values.append({
                "dataset": dataset, "image_file": entry["image_file"],
                "image_path": entry["image_path"], "image_sha256": entry["image_sha256"],
                "label": entry["label"],
            })
    counts = {name: sum(row["dataset"] == name for row in values)
              for name in ("easy", "hard", "representative")}
    if counts != {"easy": 100, "hard": 30, "representative": 100}:
        raise RuntimeError(f"validation counts changed: {counts}")
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(WORKSPACE))
    import ocr_server

    entries = rows()
    engine = ocr_server.OcrEngine().load()
    started = time.time()
    records = []
    for index, entry in enumerate(entries, start=1):
        path = Path(entry["image_path"])
        if sha256(path) != entry["image_sha256"]:
            raise RuntimeError(f"SHA mismatch: {path}")
        result = engine.recognize(path.read_bytes(), expected_length=4)
        records.append({
            "dataset": entry["dataset"], "image_file": entry["image_file"],
            "expected": entry["label"], "prediction": result["answer"],
            "strategy": result["selection_strategy"],
        })
        if index % 25 == 0:
            print(f"validated {index}/{len(entries)}", flush=True)
    metrics = {}
    for dataset in ("easy", "hard", "representative"):
        selected = [record for record in records if record["dataset"] == dataset]
        exact = sum(record["prediction"] == record["expected"] for record in selected)
        char_correct = sum(
            sum(left == right for left, right in zip(record["prediction"], record["expected"]))
            for record in selected
        )
        metrics[dataset] = {
            "count": len(selected), "exact_correct": exact,
            "exact_accuracy": exact / len(selected),
            "char_correct": char_correct, "char_total": len(selected) * 4,
            "char_accuracy": char_correct / (len(selected) * 4),
        }
    report = {
        "schema_version": 1,
        "scope": "non-sealed production fusion replay",
        "sealed_images_read": False,
        "elapsed_seconds": time.time() - started,
        "metrics": metrics,
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
