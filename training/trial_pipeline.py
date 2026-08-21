from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import statistics
import sys
import time
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import ocr_server


DEFAULT_MANIFEST = ROOT / "tests" / "results" / "dataset_manifest.json"
DEFAULT_SAMPLES = ROOT / "training" / "samples"
DEFAULT_MODEL_ROOT = ROOT / "models"
TRAINER_REPOSITORY = "https://github.com/sml2h3/dddd_trainer"
TRAINER_COMMIT_REVIEWED = "5fd0d0b5bb83bf44a5692c9d253b7d928e05e673"
LABEL_PATTERN = re.compile(r"^[A-Z0-9]{3,6}$")


class TrialPipelineError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TrialPipelineError(f"無法讀取 dataset manifest: {error}") from error

    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise TrialPipelineError("dataset manifest 缺少 entries")
    if manifest.get("invalid_records"):
        raise TrialPipelineError("dataset manifest 含 invalid_records")
    if manifest.get("label_conflicts"):
        raise TrialPipelineError("dataset manifest 含 label_conflicts")
    if manifest.get("unique_verified_images") != len(entries):
        raise TrialPipelineError("unique_verified_images 與 entries 數量不一致")

    seen_hashes: set[str] = set()
    counts = Counter()
    for entry in entries:
        image_file = entry.get("image_file")
        image_hash = entry.get("image_sha256")
        label = entry.get("label")
        split = entry.get("split")
        if not isinstance(image_file, str) or Path(image_file).name != image_file:
            raise TrialPipelineError(f"不安全的 image_file: {image_file!r}")
        if not isinstance(image_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", image_hash):
            raise TrialPipelineError(f"無效的 image_sha256: {image_file}")
        if image_hash in seen_hashes:
            raise TrialPipelineError(f"manifest 出現重複圖片雜湊: {image_hash}")
        if not isinstance(label, str) or not LABEL_PATTERN.fullmatch(label):
            raise TrialPipelineError(f"無效標籤: {image_file}")
        if split not in {"train", "validation", "test"}:
            raise TrialPipelineError(f"無效 split: {image_file}")
        seen_hashes.add(image_hash)
        counts[split] += 1

    expected_counts = manifest.get("split_counts") or {}
    if any(counts[name] != expected_counts.get(name) for name in ("train", "validation", "test")):
        raise TrialPipelineError("split_counts 與 entries 不一致")
    return manifest


def verified_sample_path(samples_dir: Path, entry: dict) -> Path:
    image_path = samples_dir / entry["image_file"]
    if not image_path.is_file():
        raise TrialPipelineError(f"找不到圖片: {entry['image_file']}")
    actual_hash = sha256_file(image_path)
    if actual_hash != entry["image_sha256"]:
        raise TrialPipelineError(f"圖片雜湊不符: {entry['image_file']}")
    return image_path


def prepare_trainer_dataset(manifest_path: Path, samples_dir: Path, output_dir: Path) -> dict:
    manifest = load_manifest(manifest_path)
    if not manifest.get("ready_for_trial_training"):
        raise TrialPipelineError("資料集尚未達試訓門檻")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise TrialPipelineError(f"輸出目錄不是空的: {output_dir}")

    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    train_entries = [entry for entry in manifest["entries"] if entry["split"] == "train"]
    label_lines = []
    exported_entries = []
    for entry in train_entries:
        source = verified_sample_path(samples_dir, entry)
        destination = images_dir / entry["image_file"]
        shutil.copy2(source, destination)
        label_lines.append(f"{entry['image_file']}\t{entry['label']}")
        exported_entries.append({
            "image_file": entry["image_file"],
            "image_sha256": entry["image_sha256"],
            "label": entry["label"],
        })

    (output_dir / "labels.txt").write_text("\n".join(label_lines) + "\n", encoding="utf-8")
    settings = {
        "trainer_repository": TRAINER_REPOSITORY,
        "trainer_commit_reviewed": TRAINER_COMMIT_REVIEWED,
        "project_name": "steven_toolweb_trial",
        "system": {"GPU": True, "GPU_ID": 0, "Val": 0.10},
        "model": {"ImageWidth": -1, "ImageHeight": 64, "ImageChannel": 3, "Word": False},
        "train": {
            "BATCH_SIZE": 16,
            "TEST_BATCH_SIZE": 16,
            "CNN": {"NAME": "ddddocr"},
            "DROPOUT": 0.3,
            "OPTIMIZER": "SGD",
            "LR": 0.01,
            "TEST_STEP": 20,
            "SAVE_CHECKPOINTS_STEP": 100,
            "TARGET": {"Accuracy": 0.90, "Epoch": 20, "Cost": 0.05},
        },
        "safety": {
            "exported_split": "train",
            "validation_and_test_exported": False,
            "may_replace_production_model": False,
        },
    }
    provenance = {
        "schema_version": 1,
        "manifest_sha256": sha256_file(manifest_path),
        "manifest_seed": manifest.get("seed"),
        "source_unique_verified_images": manifest.get("unique_verified_images"),
        "exported_split": "train",
        "exported_count": len(exported_entries),
        "held_out_counts": {
            "validation": manifest["split_counts"]["validation"],
            "test": manifest["split_counts"]["test"],
        },
        "entries": exported_entries,
    }
    (output_dir / "trainer_settings.json").write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"output": str(output_dir), **provenance, "trainer_settings": settings}


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) - 1) * fraction)))
    return ordered[index]


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_character != right_character),
            ))
        previous = current
    return previous[-1]


def evaluate_predictor(name: str, predictor, entries: list[dict], samples_dir: Path) -> dict:
    correct = 0
    no_answer = 0
    character_count = 0
    character_errors = 0
    latencies = []
    error_types = Counter()
    active_learning_priorities = Counter()
    active_learning_reasons = Counter()
    recommended_for_collection = 0
    recommended_sample_equivalent = 0.0
    failures = []
    for entry in entries:
        image_path = verified_sample_path(samples_dir, entry)
        started = time.perf_counter()
        try:
            result = predictor(image_path.read_bytes(), len(entry["label"]))
            answer = ocr_server.normalize_answer(result.get("answer", ""))
        except Exception as error:  # report evaluation failures instead of hiding them
            answer = ""
            result = {"warning": str(error)}
        latencies.append((time.perf_counter() - started) * 1000)
        character_count += len(entry["label"])
        character_errors += edit_distance(answer, entry["label"])
        active_learning = result.get("active_learning") if isinstance(result, dict) else None
        if isinstance(active_learning, dict):
            priority = str(active_learning.get("priority") or "unknown")
            active_learning_priorities[priority] += 1
            active_learning_reasons.update(str(reason) for reason in active_learning.get("reasons") or [])
            recommended_for_collection += int(bool(active_learning.get("save_if_site_accepted")))
            recommended_sample_equivalent += float(active_learning.get("recommended_sample_rate") or 0.0)
        if answer == entry["label"]:
            correct += 1
            error_type = "correct"
        elif not answer:
            no_answer += 1
            error_type = "no_answer"
        else:
            error_type = ocr_server.analyze_recognition_error(answer, entry["label"])["type"]
        error_types[error_type] += 1
        if error_type != "correct":
            failures.append({
                "image_file": entry["image_file"],
                "expected": entry["label"],
                "predicted": answer,
                "error_type": error_type,
            })

    count = len(entries)
    return {
        "name": name,
        "count": count,
        "correct": correct,
        "accuracy": correct / count if count else 0.0,
        "no_answer": no_answer,
        "character_count": character_count,
        "character_errors": character_errors,
        "character_accuracy": (
            max(0.0, 1.0 - character_errors / character_count)
            if character_count
            else 0.0
        ),
        "error_types": dict(sorted(error_types.items())),
        "active_learning": {
            "priority_counts": dict(sorted(active_learning_priorities.items())),
            "recommended_for_collection": recommended_for_collection,
            "recommended_sample_equivalent": round(recommended_sample_equivalent, 4),
            "reason_counts": dict(active_learning_reasons.most_common()),
        },
        "latency_ms": {
            "mean": statistics.fmean(latencies) if latencies else 0.0,
            "p50": statistics.median(latencies) if latencies else 0.0,
            "p95": percentile(latencies, 0.95),
        },
        "failures": failures,
    }


def current_predictor(model_root: Path):
    engine = ocr_server.OcrEngine(model_root).load()

    def predict(image_bytes: bytes, expected_length: int) -> dict:
        return engine.recognize(image_bytes, expected_length=expected_length)

    return predict, engine.names


def candidate_predictor(onnx_path: Path, charsets_path: Path):
    try:
        import ddddocr
    except ModuleNotFoundError as error:
        raise TrialPipelineError("缺少 ddddocr") from error
    if not onnx_path.is_file() or not charsets_path.is_file():
        raise TrialPipelineError("候選 ONNX 或 charsets.json 不存在")
    solver = ddddocr.DdddOcr(
        show_ad=False,
        import_onnx_path=str(onnx_path),
        charsets_path=str(charsets_path),
    )

    def predict(image_bytes: bytes, expected_length: int) -> dict:
        predictions = []
        for variant_name, variant_bytes in ocr_server.image_variants(image_bytes):
            answer = ocr_server.normalize_answer(solver.classification(variant_bytes))
            if ocr_server.answer_is_plausible(answer):
                item = {"solver": "candidate", "variant": variant_name, "answer": answer}
                if variant_name == "dark_primary":
                    item["preferred"] = True
                predictions.append(item)
        return ocr_server.choose_ensemble(predictions, expected_length=expected_length)

    return predict


def trial_gate(current: dict, candidate: dict) -> dict:
    checks = {
        "validation_not_worse": candidate["validation"]["accuracy"] >= current["validation"]["accuracy"],
        "test_strictly_better": candidate["test"]["accuracy"] > current["test"]["accuracy"],
        "test_no_answer_not_worse": candidate["test"]["no_answer"] <= current["test"]["no_answer"],
    }
    return {
        "checks": checks,
        "promising_trial_candidate": all(checks.values()),
        "may_replace_production_model": False,
        "note": "200 張門檻只允許試訓；正式替換仍需至少 2,000 張與獨立驗收。",
    }


def evaluate_models(
    manifest_path: Path,
    samples_dir: Path,
    model_root: Path,
    candidate_onnx: Path | None = None,
    candidate_charsets: Path | None = None,
) -> dict:
    manifest = load_manifest(manifest_path)
    current, solver_names = current_predictor(model_root)
    report = {
        "schema_version": 1,
        "manifest_sha256": sha256_file(manifest_path),
        "manifest_seed": manifest.get("seed"),
        "unique_verified_images": manifest.get("unique_verified_images"),
        "evaluated_splits": ["validation", "test"],
        "current_solver_names": solver_names,
        "current": {},
        "candidate": None,
        "gate": None,
    }
    for split in ("validation", "test"):
        entries = [entry for entry in manifest["entries"] if entry["split"] == split]
        report["current"][split] = evaluate_predictor("current_ensemble", current, entries, samples_dir)

    if candidate_onnx is not None or candidate_charsets is not None:
        if candidate_onnx is None or candidate_charsets is None:
            raise TrialPipelineError("候選模型必須同時提供 ONNX 與 charsets.json")
        candidate = candidate_predictor(candidate_onnx, candidate_charsets)
        report["candidate"] = {}
        for split in ("validation", "test"):
            entries = [entry for entry in manifest["entries"] if entry["split"] == split]
            report["candidate"][split] = evaluate_predictor("candidate", candidate, entries, samples_dir)
        report["gate"] = trial_gate(report["current"], report["candidate"])
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare and evaluate a guarded OCR trial model.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    prepare.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    prepare.add_argument("--output", type=Path, required=True)

    evaluate = subparsers.add_parser("evaluate")
    evaluate.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    evaluate.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    evaluate.add_argument("--model-root", type=Path, default=DEFAULT_MODEL_ROOT)
    evaluate.add_argument("--candidate-onnx", type=Path)
    evaluate.add_argument("--candidate-charsets", type=Path)
    evaluate.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "prepare":
            result = prepare_trainer_dataset(args.manifest, args.samples, args.output)
        else:
            result = evaluate_models(
                args.manifest,
                args.samples,
                args.model_root,
                args.candidate_onnx,
                args.candidate_charsets,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except TrialPipelineError as error:
        print(f"Trial pipeline error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
