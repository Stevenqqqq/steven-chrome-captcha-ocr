from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "tests" / "results" / "dataset_manifest_label_grouped_552.json"
DEFAULT_BASELINE = ROOT / "tests" / "results" / "current_baseline_label_grouped_552.json"
DEFAULT_POLICY = ROOT / "tests" / "results" / "release_targets.json"


class ReleaseGateError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseGateError(f"無法讀取 {path.name}: {error}") from error
    if not isinstance(value, dict):
        raise ReleaseGateError(f"{path.name} 必須是 JSON object")
    return value


def metric_check(name: str, actual: float, target: float, operator: str) -> dict:
    passed = actual >= target if operator == "minimum" else actual <= target
    return {
        "name": name,
        "actual": actual,
        "target": target,
        "operator": operator,
        "passed": passed,
    }


def evaluate_release_readiness(manifest: dict, baseline: dict, policy: dict) -> dict:
    test_entries = [entry for entry in manifest.get("entries") or [] if entry.get("split") == "test"]
    test_labels = [str(entry.get("label") or "") for entry in test_entries]
    current = (baseline.get("current") or {}).get("test") or {}
    count = int(current.get("count") or 0)
    if count != len(test_entries):
        raise ReleaseGateError("baseline test count 與 manifest test entries 不一致")
    no_answer_rate = int(current.get("no_answer") or 0) / count if count else 1.0
    character_counts = Counter(character for label in test_labels for character in label)
    digit_counts = {digit: character_counts[digit] for digit in "0123456789"}

    results = {}
    for profile_name, profile in (policy.get("profiles") or {}).items():
        pattern = re.compile(str(profile["label_pattern"]))
        labels_match = bool(test_labels) and all(pattern.fullmatch(label) for label in test_labels)
        required_character_classes = set(profile.get("required_character_classes") or [])
        present_character_classes = set()
        if any(character.isalpha() for character in character_counts):
            present_character_classes.add("letters")
        if any(character.isdigit() for character in character_counts):
            present_character_classes.add("digits")
        character_classes_passed = required_character_classes.issubset(present_character_classes)
        checks = [
            metric_check("test_samples", count, int(profile["minimum_test_samples"]), "minimum"),
            metric_check(
                "exact_accuracy",
                float(current.get("accuracy") or 0.0),
                float(profile["minimum_exact_accuracy"]),
                "minimum",
            ),
            metric_check(
                "character_accuracy",
                float(current.get("character_accuracy") or 0.0),
                float(profile["minimum_character_accuracy"]),
                "minimum",
            ),
            metric_check(
                "no_answer_rate",
                no_answer_rate,
                float(profile["maximum_no_answer_rate"]),
                "maximum",
            ),
        ]
        checks.append({
            "name": "label_pattern",
            "actual": "all_match" if labels_match else "mismatch_or_empty",
            "target": profile["label_pattern"],
            "operator": "match",
            "passed": labels_match,
        })
        checks.append({
            "name": "required_character_classes",
            "actual": sorted(present_character_classes),
            "target": sorted(required_character_classes),
            "operator": "contains_all",
            "passed": character_classes_passed,
        })

        minimum_digit_occurrences = int(profile.get("minimum_occurrences_per_digit") or 0)
        if minimum_digit_occurrences:
            digit_passed = all(count >= minimum_digit_occurrences for count in digit_counts.values())
            checks.append({
                "name": "digit_coverage",
                "actual": digit_counts,
                "target": {digit: minimum_digit_occurrences for digit in "0123456789"},
                "operator": "minimum_each",
                "passed": digit_passed,
            })

        confusion_symbols = list(profile.get("confusion_symbols") or [])
        if confusion_symbols:
            confusion_actual = {symbol: character_counts[symbol] for symbol in confusion_symbols}
            confusion_minimum = int(profile.get("minimum_confusion_symbol_occurrences") or 0)
            confusion_passed = all(value >= confusion_minimum for value in confusion_actual.values())
            checks.append({
                "name": "confusion_symbol_coverage",
                "actual": confusion_actual,
                "target": {symbol: confusion_minimum for symbol in confusion_symbols},
                "operator": "minimum_each",
                "passed": confusion_passed,
            })

        results[profile_name] = {
            "passed": all(check["passed"] for check in checks),
            "checks": checks,
        }

    return {
        "schema_version": 1,
        "test_character_counts": dict(sorted(character_counts.items())),
        "digit_counts": digit_counts,
        "profiles": results,
        "github_release_ready": all(result["passed"] for result in results.values()),
    }


def build_report(manifest_path: Path, baseline_path: Path, policy_path: Path) -> dict:
    manifest = load_json(manifest_path)
    baseline = load_json(baseline_path)
    policy = load_json(policy_path)
    manifest_hash = sha256_file(manifest_path)
    if baseline.get("manifest_sha256") != manifest_hash:
        raise ReleaseGateError("baseline manifest_sha256 與指定 manifest 不一致")
    return {
        "manifest_sha256": manifest_hash,
        "baseline_sha256": sha256_file(baseline_path),
        "policy_sha256": sha256_file(policy_path),
        **evaluate_release_readiness(manifest, baseline, policy),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate OCR GitHub release accuracy and coverage gates.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = build_report(args.manifest, args.baseline, args.policy)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except ReleaseGateError as error:
        print(f"Release gate error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
