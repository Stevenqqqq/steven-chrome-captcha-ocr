from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "training"))

import ocr_server
import trial_pipeline


DEFAULT_MANIFEST = ROOT / "tests" / "results" / "dataset_manifest.json"
DEFAULT_SAMPLES = ROOT / "training" / "samples"
DEFAULT_MODELS = ROOT / "models"


def analyze_result(expected: str, result: dict) -> dict:
    predictions = list(result.get("predictions") or [])
    by_solver: dict[str, list[dict]] = defaultdict(list)
    for prediction in predictions:
        by_solver[str(prediction.get("solver") or "unknown")].append(prediction)

    solver_any_correct = {}
    solver_preferred = {}
    for solver, items in sorted(by_solver.items()):
        solver_any_correct[solver] = any(item.get("answer") == expected for item in items)
        preferred = next((item for item in items if item.get("preferred")), None)
        if preferred is None:
            preferred = next((item for item in items if item.get("variant") == "raw"), None)
        if preferred is None and items:
            preferred = items[0]
        solver_preferred[solver] = preferred.get("answer") if preferred else None

    candidates = list(result.get("candidates") or [])
    candidate_rank = next(
        (index + 1 for index, candidate in enumerate(candidates) if candidate.get("answer") == expected), None
    )
    answer = result.get("answer")
    return {
        "expected": expected,
        "ensemble_answer": answer,
        "ensemble_correct": answer == expected,
        "any_variant_correct": any(item.get("answer") == expected for item in predictions),
        "candidate_contains_expected": candidate_rank is not None,
        "candidate_rank": candidate_rank,
        "solver_any_correct": solver_any_correct,
        "solver_preferred": solver_preferred,
        "solver_preferred_correct": {
            solver: preferred == expected for solver, preferred in solver_preferred.items()
        },
        "candidates": candidates,
        "predictions": [
            {
                "solver": item.get("solver"),
                "variant": item.get("variant"),
                "answer": item.get("answer"),
                "preferred": bool(item.get("preferred")),
            }
            for item in predictions
        ],
        "distinct_answers": sorted({str(item.get("answer")) for item in predictions if item.get("answer")}),
    }


def select_total_override(row: dict, minimum_total_votes: int, minimum_margin: int) -> str | None:
    candidates = list(row.get("candidates") or [])
    if not candidates:
        return row.get("ensemble_answer")
    primary = candidates[0]
    leader = sorted(
        candidates,
        key=lambda candidate: (
            -int(candidate.get("total_votes") or 0),
            -int(candidate.get("solver_votes") or 0),
            -int(candidate.get("preferred_votes") or 0),
            -int(candidate.get("raw_votes") or 0),
        ),
    )[0]
    primary_total = int(primary.get("total_votes") or 0)
    leader_total = int(leader.get("total_votes") or 0)
    if leader_total >= minimum_total_votes and leader_total - primary_total >= minimum_margin:
        return leader.get("answer")
    return primary.get("answer")


def evaluate_selector_policy(rows: list[dict], minimum_total_votes: int, minimum_margin: int) -> dict:
    correct = 0
    changed = 0
    recoveries = 0
    regressions = 0
    for row in rows:
        chosen = select_total_override(row, minimum_total_votes, minimum_margin)
        original = row.get("ensemble_answer")
        expected = row.get("expected")
        correct += int(chosen == expected)
        changed += int(chosen != original)
        recoveries += int(original != expected and chosen == expected)
        regressions += int(original == expected and chosen != expected)
    return {
        "minimum_total_votes": minimum_total_votes,
        "minimum_margin": minimum_margin,
        "correct": correct,
        "count": len(rows),
        "accuracy": correct / len(rows) if rows else 0.0,
        "changed": changed,
        "recoveries": recoveries,
        "regressions": regressions,
    }


def run_oracle(manifest_path: Path, samples_dir: Path, model_root: Path, splits: tuple[str, ...]) -> dict:
    manifest = trial_pipeline.load_manifest(manifest_path)
    invalid_splits = set(splits) - {"train", "validation", "test"}
    if not splits or invalid_splits:
        raise trial_pipeline.TrialPipelineError(f"無效 splits: {sorted(invalid_splits)}")
    engine = ocr_server.OcrEngine(model_root=model_root)
    engine.load()
    report = {
        "schema_version": 1,
        "manifest_sha256": trial_pipeline.sha256_file(manifest_path),
        "solver_names": engine.names,
        "splits": {},
    }
    for split in splits:
        entries = [entry for entry in manifest["entries"] if entry["split"] == split]
        rows = []
        latencies = []
        for entry in entries:
            image_path = trial_pipeline.verified_sample_path(samples_dir, entry)
            started = time.perf_counter()
            result = engine.recognize(image_path.read_bytes(), expected_length=len(entry["label"]))
            latencies.append((time.perf_counter() - started) * 1000)
            row = {"image_file": entry["image_file"], **analyze_result(entry["label"], result)}
            rows.append(row)

        solver_any_counts = Counter()
        solver_preferred_counts = Counter()
        for row in rows:
            solver_any_counts.update(solver for solver, correct in row["solver_any_correct"].items() if correct)
            solver_preferred_counts.update(
                solver for solver, correct in row["solver_preferred_correct"].items() if correct
            )
        ensemble_correct = sum(row["ensemble_correct"] for row in rows)
        any_variant_correct = sum(row["any_variant_correct"] for row in rows)
        candidate_contains = sum(row["candidate_contains_expected"] for row in rows)
        ensemble_failures = [row for row in rows if not row["ensemble_correct"]]
        recoverable = [row for row in ensemble_failures if row["any_variant_correct"]]
        policies = {}
        for minimum_total_votes in range(2, 7):
            for minimum_margin in range(1, 6):
                name = f"total_override_t{minimum_total_votes}_m{minimum_margin}"
                policies[name] = evaluate_selector_policy(rows, minimum_total_votes, minimum_margin)
        report["splits"][split] = {
            "count": len(rows),
            "ensemble_correct": ensemble_correct,
            "ensemble_accuracy": ensemble_correct / len(rows),
            "any_variant_oracle_correct": any_variant_correct,
            "any_variant_oracle_accuracy": any_variant_correct / len(rows),
            "candidate_oracle_correct": candidate_contains,
            "candidate_oracle_accuracy": candidate_contains / len(rows),
            "recoverable_ensemble_failures": len(recoverable),
            "solver_any_variant_correct": dict(sorted(solver_any_counts.items())),
            "solver_preferred_correct": dict(sorted(solver_preferred_counts.items())),
            "selector_policies": policies,
            "latency_ms": {"mean": sum(latencies) / len(latencies), "max": max(latencies)},
            "ensemble_failures": ensemble_failures,
        }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Measure the oracle ceiling of existing OCR solver outputs.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    parser.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--splits", nargs="+", default=["train", "validation", "test"])
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = run_oracle(args.manifest, args.samples, args.models, tuple(args.splits))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (trial_pipeline.TrialPipelineError, ocr_server.OcrError) as error:
        print(f"Solver oracle error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
