"""Offline, reproducible OCR stress test.

The repository currently contains only a small number of human-labelled
feedback samples.  This runner deliberately does not invent labels: it loads
the labels from ``training/feedback/*.json`` and makes deterministic,
semantic-preserving image augmentations from those images.  Consequently the
reported accuracy measures robustness to the listed augmentations, not
accuracy on a representative CAPTCHA corpus.

Run from the repository root with the Python interpreter that has the OCR
dependencies installed, for example::

    py -3.10 tests/ocr_stress_500.py --count 500 --seed 20260803

Use ``--output`` to write a JSON report and ``--failures-dir`` to persist up to
``--max-failure-images`` generated failure images for inspection.  No network
or browser is used by this script.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import random
import statistics
import sys
import time
import tracemalloc
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ocr_server  # noqa: E402  (import after adding the repository root)


DEFAULT_COUNT = 500
DEFAULT_SEED = 20260803
DEFAULT_MEMORY_INTERVAL = 50
DEFAULT_MAX_FAILURE_IMAGES = 25


@dataclass(frozen=True)
class LabeledSample:
    image_path: Path
    label: str


def _display_path(path: Path, root: Path = ROOT) -> str:
    """Prefer repository-relative paths so reports do not leak local usernames."""

    try:
        relative = path.resolve().relative_to(root.resolve())
        return str(relative).replace(os.sep, "/")
    except ValueError:
        return str(path)


def _normalize_label(value: object) -> str:
    """Normalize a stored label using the production normalizer."""

    return ocr_server.normalize_answer(value)


def load_labeled_samples(root: Path = ROOT) -> tuple[list[LabeledSample], list[str]]:
    """Load only feedback records whose image and label can be validated.

    The second return value contains skip reasons, which are included in the
    report rather than silently dropping malformed records.
    """

    feedback_dir = root / "training" / "feedback"
    samples_dir = root / "training" / "samples"
    samples: list[LabeledSample] = []
    skipped: list[str] = []
    seen_images: dict[str, LabeledSample] = {}
    if not feedback_dir.exists():
        return samples, [f"feedback directory missing: {_display_path(feedback_dir, root)}"]

    for metadata_path in sorted(feedback_dir.glob("*.json")):
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception as error:
            skipped.append(f"{_display_path(metadata_path, root)}: invalid JSON ({error})")
            continue

        label = _normalize_label(payload.get("correct_answer"))
        if not ocr_server.answer_is_plausible(label):
            skipped.append(f"{_display_path(metadata_path, root)}: invalid label")
            continue

        image_name = str(payload.get("image_file") or "")
        image_path = samples_dir / image_name if image_name else samples_dir / f"{metadata_path.stem}.png"
        # Do not allow a metadata file to escape the repository sample folder.
        try:
            image_path = image_path.resolve()
            image_path.relative_to(samples_dir.resolve())
        except ValueError:
            skipped.append(f"{_display_path(metadata_path, root)}: image path escapes samples directory")
            continue
        if not image_path.is_file():
            skipped.append(f"{_display_path(metadata_path, root)}: image missing ({_display_path(image_path, root)})")
            continue
        image_sha256 = hashlib.sha256(image_path.read_bytes()).hexdigest()
        existing = seen_images.get(image_sha256)
        if existing is not None:
            relationship = "duplicate" if existing.label == label else "conflicting label"
            skipped.append(
                f"{_display_path(metadata_path, root)}: {relationship} of "
                f"{_display_path(existing.image_path, root)}"
            )
            continue
        sample = LabeledSample(image_path=image_path, label=label)
        seen_images[image_sha256] = sample
        samples.append(sample)

    return samples, skipped


def _png_bytes(image: Any) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _jpeg_roundtrip(image: Any, quality: int) -> Any:
    output = BytesIO()
    image.save(output, format="JPEG", quality=quality, optimize=False)
    output.seek(0)
    # Importing through PIL keeps this helper independent from numpy/cv2.
    from PIL import Image

    return Image.open(output).convert("RGB")


def augment_image(image: Any, rng: random.Random, transform_index: int) -> tuple[str, bytes]:
    """Return one deterministic, mild augmentation and its PNG bytes.

    Every transform keeps the source dimensions and is intentionally mild so
    that the source label remains the stated ground truth.  The transform
    name is recorded for per-transform diagnostics.
    """

    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    # Keeping the first item in every batch as an unmodified baseline makes a
    # run comparable across seeds and catches accidental input mutation.
    choice = "original" if transform_index == 0 else rng.choice(
        (
            "original",
            "brightness",
            "contrast",
            "sharpness",
            "blur",
            "rotate",
            "color",
            "autocontrast",
            "jpeg",
            "brightness_contrast",
        )
    )

    if choice == "original":
        transformed = image.copy()
    elif choice == "brightness":
        transformed = ImageEnhance.Brightness(image).enhance(rng.uniform(0.88, 1.12))
    elif choice == "contrast":
        transformed = ImageEnhance.Contrast(image).enhance(rng.uniform(0.80, 1.25))
    elif choice == "sharpness":
        transformed = ImageEnhance.Sharpness(image).enhance(rng.uniform(0.75, 1.30))
    elif choice == "blur":
        transformed = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.15, 0.65)))
    elif choice == "rotate":
        # A small in-place rotation avoids changing the expected dimensions.
        transformed = image.rotate(
            rng.uniform(-1.5, 1.5),
            resample=Image.Resampling.BICUBIC,
            expand=False,
            fillcolor=(255, 255, 255),
        )
    elif choice == "color":
        transformed = ImageEnhance.Color(image).enhance(rng.uniform(0.75, 1.25))
    elif choice == "autocontrast":
        transformed = ImageOps.autocontrast(image.convert("L")).convert("RGB")
    elif choice == "jpeg":
        transformed = _jpeg_roundtrip(image, rng.randint(78, 96))
    else:  # brightness_contrast
        adjusted = ImageEnhance.Brightness(image).enhance(rng.uniform(0.90, 1.10))
        transformed = ImageEnhance.Contrast(adjusted).enhance(rng.uniform(0.85, 1.20))

    return choice, _png_bytes(transformed.convert("RGB"))


def _nearest_rank(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return ordered[index]


def _solver_consensus(predictions: Iterable[dict[str, Any]]) -> dict[str, str]:
    """Choose the most common variant answer for each solver."""

    answers_by_solver: dict[str, list[str]] = defaultdict(list)
    for prediction in predictions:
        solver = str(prediction.get("solver") or "unknown")
        answer = _normalize_label(prediction.get("answer"))
        if ocr_server.answer_is_plausible(answer):
            answers_by_solver[solver].append(answer)

    consensus: dict[str, str] = {}
    for solver, answers in answers_by_solver.items():
        counts = Counter(answers)
        first_seen = {answer: answers.index(answer) for answer in counts}
        consensus[solver] = min(counts, key=lambda answer: (-counts[answer], first_seen[answer]))
    return consensus


def _process_rss_bytes() -> int | None:
    """Return current Windows working-set bytes when available.

    This optional probe uses only the local process and gracefully returns
    ``None`` on non-Windows systems or when the API is unavailable.
    """

    if not sys.platform.startswith("win"):
        return None

    try:
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        get_process_memory_info = ctypes.WinDLL("psapi").GetProcessMemoryInfo
        get_process_memory_info.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
        get_process_memory_info.restype = wintypes.BOOL
        if not get_process_memory_info(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return None
        return int(counters.WorkingSetSize)
    except Exception:
        return None


def _json_safe(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Counter):
        return dict(value)
    return value


def run_stress(
    count: int = DEFAULT_COUNT,
    seed: int = DEFAULT_SEED,
    root: Path = ROOT,
    output: Path | None = None,
    failures_dir: Path | None = None,
    max_failure_images: int = DEFAULT_MAX_FAILURE_IMAGES,
    memory_interval: int = DEFAULT_MEMORY_INTERVAL,
    use_label_length_hint: bool = False,
) -> dict[str, Any]:
    if count <= 0:
        raise ValueError("count must be positive")
    if max_failure_images < 0:
        raise ValueError("max_failure_images cannot be negative")

    samples, skipped = load_labeled_samples(root)
    if not samples:
        raise RuntimeError("No valid labelled samples were found; refusing to invent labels")

    # Import Pillow only when the actual run starts, so --help and malformed
    # argument checks remain cheap.
    from PIL import Image

    rng = random.Random(seed)
    source_images = []
    for sample in samples:
        with Image.open(sample.image_path) as source_image:
            source_images.append((sample, source_image.convert("RGB").copy()))
    engine = ocr_server.OcrEngine(root / "models")
    engine.load()

    durations: list[float] = []
    correct = 0
    no_answer = 0
    exceptions = 0
    predicted_answers: Counter[str] = Counter()
    confusion: Counter[tuple[str, str]] = Counter()
    warning_sources: Counter[str] = Counter()
    transform_stats: dict[str, Counter[str]] = defaultdict(Counter)
    solver_stats: dict[str, Counter[str]] = defaultdict(Counter)
    failed_samples: list[dict[str, Any]] = []
    saved_failure_count = 0

    if failures_dir is not None:
        failures_dir.mkdir(parents=True, exist_ok=True)

    memory_snapshots: list[dict[str, int | None]] = []
    tracemalloc.start()
    initial_trace = tracemalloc.get_traced_memory()
    initial_rss = _process_rss_bytes()
    memory_snapshots.append({"sample": 0, "python_current": initial_trace[0], "python_peak": initial_trace[1], "rss": initial_rss})

    started = time.perf_counter()
    for index in range(count):
        sample, image = source_images[index % len(source_images)]
        transform_name, image_bytes = augment_image(image, rng, index)
        sample_started = time.perf_counter()
        predicted = ""
        result: dict[str, Any] = {}
        error_text = ""
        try:
            expected_length = len(sample.label) if use_label_length_hint else None
            result = engine.recognize(image_bytes, expected_length=expected_length)
            predicted = _normalize_label(result.get("answer"))
            for warning in result.get("warnings") or []:
                source = str(warning).split(":", 1)[0] or "unknown"
                warning_sources[source] += 1
            if predicted:
                predicted_answers[predicted] += 1
                confusion[(sample.label, predicted)] += 1
            else:
                no_answer += 1

            if predicted == sample.label:
                correct += 1
                transform_stats[transform_name]["correct"] += 1
            else:
                transform_stats[transform_name]["wrong"] += 1

            consensus = _solver_consensus(result.get("predictions") or [])
            for solver in engine.names:
                solver_stats[solver]["attempts"] += 1
                solver_prediction = consensus.get(solver, "")
                if not solver_prediction:
                    solver_stats[solver]["no_answer"] += 1
                elif solver_prediction == sample.label:
                    solver_stats[solver]["correct"] += 1
                else:
                    solver_stats[solver]["wrong"] += 1
        except Exception as error:  # Keep the batch running and count failures.
            exceptions += 1
            error_text = f"{type(error).__name__}: {error}"
            transform_stats[transform_name]["exception"] += 1

        elapsed = time.perf_counter() - sample_started
        durations.append(elapsed)

        if predicted != sample.label or error_text:
            failure: dict[str, Any] = {
                "index": index + 1,
                "source_image": _display_path(sample.image_path, root),
                "label": sample.label,
                "predicted": predicted or None,
                "transform": transform_name,
                "error": error_text or None,
            }
            if failures_dir is not None and saved_failure_count < max_failure_images:
                failure_path = failures_dir / f"failure_{index + 1:04d}_{sample.label}_{transform_name}.png"
                failure_path.write_bytes(image_bytes)
                failure["generated_image"] = _display_path(failure_path, root)
                saved_failure_count += 1
            failed_samples.append(failure)

        if memory_interval > 0 and ((index + 1) % memory_interval == 0 or index + 1 == count):
            current, peak = tracemalloc.get_traced_memory()
            memory_snapshots.append(
                {
                    "sample": index + 1,
                    "python_current": current,
                    "python_peak": peak,
                    "rss": _process_rss_bytes(),
                }
            )

    total_elapsed = time.perf_counter() - started
    final_trace = tracemalloc.get_traced_memory()
    final_rss = _process_rss_bytes()
    tracemalloc.stop()

    transform_report: dict[str, dict[str, int | float | None]] = {}
    for transform, stats in sorted(transform_stats.items()):
        attempts = sum(stats.values())
        transform_report[transform] = {
            "attempts": attempts,
            "correct": stats.get("correct", 0),
            "wrong": stats.get("wrong", 0),
            "exceptions": stats.get("exception", 0),
            "accuracy": (stats.get("correct", 0) / attempts) if attempts else None,
        }

    solver_report: dict[str, dict[str, int | float | None]] = {}
    for solver, stats in sorted(solver_stats.items()):
        attempts = stats.get("attempts", 0)
        solver_report[solver] = {
            "attempts": attempts,
            "correct": stats.get("correct", 0),
            "wrong": stats.get("wrong", 0),
            "no_answer": stats.get("no_answer", 0),
            "accuracy": (stats.get("correct", 0) / attempts) if attempts else None,
        }

    rss_delta = (final_rss - initial_rss) if initial_rss is not None and final_rss is not None else None
    python_delta = final_trace[0] - initial_trace[0]
    memory_report = {
        "probe": "Windows GetProcessMemoryInfo working set + Python tracemalloc",
        "rss_start_bytes": initial_rss,
        "rss_end_bytes": final_rss,
        "rss_delta_bytes": rss_delta,
        "python_current_start_bytes": initial_trace[0],
        "python_current_end_bytes": final_trace[0],
        "python_current_delta_bytes": python_delta,
        "python_peak_bytes": final_trace[1],
        "snapshots": memory_snapshots,
        "rss_growth_flag": (rss_delta is not None and rss_delta > max(8 * 1024 * 1024, int((initial_rss or 0) * 0.10))),
        "python_growth_flag": python_delta > 8 * 1024 * 1024,
        "interpretation": "coarse process-local probe; not a leak proof",
    }

    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "count": count,
        "seed": seed,
        "expected_length_hint": "label_length" if use_label_length_hint else None,
        "source_samples": len(samples),
        "source_unique_labels": sorted({sample.label for sample in samples}),
        "source_paths": [_display_path(sample.image_path, root) for sample in samples],
        "synthetic_augmentation": True,
        "representativeness": (
            "low: labels come from the repository feedback set; "
            f"current run has {len(samples)} unique labelled source(s)"
        ),
        "skipped_metadata": skipped,
        "correct": correct,
        "wrong": count - correct - exceptions,
        "accuracy": correct / count,
        "no_answer": no_answer,
        "exceptions": exceptions,
        "internal_warning_count": sum(warning_sources.values()),
        "internal_warning_sources": dict(warning_sources.most_common()),
        "total_elapsed_seconds": total_elapsed,
        "mean_elapsed_seconds": statistics.mean(durations) if durations else None,
        "p50_elapsed_seconds": _nearest_rank(durations, 0.50),
        "p95_elapsed_seconds": _nearest_rank(durations, 0.95),
        "min_elapsed_seconds": min(durations) if durations else None,
        "max_elapsed_seconds": max(durations) if durations else None,
        "predicted_answers": dict(predicted_answers.most_common()),
        "top_confusions": [
            {"label": label, "predicted": prediction, "count": occurrences}
            for (label, prediction), occurrences in confusion.most_common(20)
        ],
        "per_transform": transform_report,
        "per_solver": solver_report,
        "memory": memory_report,
        "failure_count": len(failed_samples),
        "saved_failure_images": saved_failure_count,
        "failed_samples": failed_samples,
    }

    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_safe), encoding="utf-8")
    return report


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a deterministic offline OCR stress test")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT, help=f"number of augmented samples (default: {DEFAULT_COUNT})")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"random seed (default: {DEFAULT_SEED})")
    parser.add_argument("--output", type=Path, help="optional JSON report path")
    parser.add_argument("--failures-dir", type=Path, help="optional directory for failed generated images")
    parser.add_argument("--max-failure-images", type=int, default=DEFAULT_MAX_FAILURE_IMAGES, help="maximum images to persist (default: 25)")
    parser.add_argument("--memory-interval", type=int, default=DEFAULT_MEMORY_INTERVAL, help=f"memory probe interval (default: {DEFAULT_MEMORY_INTERVAL})")
    parser.add_argument(
        "--use-label-length-hint",
        action="store_true",
        help="pass each stored label length to OCR; disabled by default so accuracy measures unhinted recognition",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        report = run_stress(
            count=args.count,
            seed=args.seed,
            output=args.output,
            failures_dir=args.failures_dir,
            max_failure_images=args.max_failure_images,
            memory_interval=args.memory_interval,
            use_label_length_hint=args.use_label_length_hint,
        )
    except Exception as error:
        print(f"stress test failed to start: {type(error).__name__}: {error}", file=sys.stderr)
        return 2

    print(json.dumps({
        "count": report["count"],
        "correct": report["correct"],
        "wrong": report["wrong"],
        "accuracy": report["accuracy"],
        "no_answer": report["no_answer"],
        "exceptions": report["exceptions"],
        "internal_warning_count": report["internal_warning_count"],
        "total_elapsed_seconds": report["total_elapsed_seconds"],
        "mean_elapsed_seconds": report["mean_elapsed_seconds"],
        "p50_elapsed_seconds": report["p50_elapsed_seconds"],
        "p95_elapsed_seconds": report["p95_elapsed_seconds"],
        "source_samples": report["source_samples"],
        "source_unique_labels": report["source_unique_labels"],
        "saved_failure_images": report["saved_failure_images"],
        "rss_delta_bytes": report["memory"]["rss_delta_bytes"],
        "python_current_delta_bytes": report["memory"]["python_current_delta_bytes"],
        "output": str(args.output) if args.output else None,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
