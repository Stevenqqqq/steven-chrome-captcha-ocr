"""Deterministic synthetic alphanumeric OCR development benchmark.

Synthetic images are diagnostic only. They are never release evidence and must
not be mixed into the verified training/feedback dataset.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import platform
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, __version__ as PILLOW_VERSION


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import ocr_server


CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
CONFUSION_SYMBOLS = tuple("O0I1Z2S5G6B8")
FONT_CANDIDATES = (
    "arial.ttf",
    "arialbd.ttf",
    "calibri.ttf",
    "calibrib.ttf",
    "tahoma.ttf",
    "verdana.ttf",
    "segoeui.ttf",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def generate_balanced_labels(count: int, seed: int) -> list[str]:
    if count <= 0:
        raise ValueError("count must be positive")
    total_characters = count * 4
    quotient, remainder = divmod(total_characters, len(CHARSET))
    base_pool = [
        character
        for index, character in enumerate(CHARSET)
        for _ in range(quotient + int(index < remainder))
    ]
    for attempt in range(1_000):
        pool = list(base_pool)
        random.Random(seed + attempt * 104_729).shuffle(pool)
        labels = ["".join(pool[index:index + 4]) for index in range(0, len(pool), 4)]
        if len(set(labels)) == count:
            return labels
    raise RuntimeError("could not construct unique balanced labels")


def label_coverage(labels: list[str]) -> dict:
    counts = Counter("".join(labels))
    return {
        "count": len(labels),
        "unique_labels": len(set(labels)),
        "character_counts": {character: counts[character] for character in CHARSET},
        "digit_counts": {character: counts[character] for character in "0123456789"},
        "confusion_symbol_counts": {
            character: counts[character] for character in CONFUSION_SYMBOLS
        },
        "minimum_digit_occurrences": min(counts[value] for value in "0123456789"),
        "minimum_confusion_symbol_occurrences": min(
            counts[value] for value in CONFUSION_SYMBOLS
        ),
    }


def discover_fonts(font_dir: Path) -> list[dict]:
    font_dir = Path(font_dir)
    candidates = [font_dir / name for name in FONT_CANDIDATES]
    if not any(path.is_file() for path in candidates) and font_dir.is_dir():
        candidates = sorted(font_dir.glob("*.ttf"))[:50]
    fonts = []
    for path in candidates:
        if not path.is_file():
            continue
        try:
            ImageFont.truetype(str(path), 32)
        except OSError:
            continue
        fonts.append({
            "path": path,
            "file": path.name,
            "sha256": sha256_file(path),
        })
    if not fonts:
        raise RuntimeError(f"no usable TrueType fonts found under {font_dir}")
    return fonts


def _foreground_bbox(image: Image.Image, background: tuple[int, int, int]):
    difference = Image.new("L", image.size)
    source = image.convert("RGB")
    pixels = difference.load()
    for y in range(image.height):
        for x in range(image.width):
            pixel = source.getpixel((x, y))
            pixels[x, y] = max(abs(pixel[index] - background[index]) for index in range(3))
    return difference.point(lambda value: 255 if value >= 22 else 0).getbbox()


def render_captcha(label: str, font_path: Path | str, seed: int, index: int) -> tuple[bytes, dict]:
    if len(label) != 4 or any(character not in CHARSET for character in label):
        raise ValueError("label must contain exactly four A-Z0-9 characters")
    rng = random.Random(f"{seed}:{index}:{label}")
    background = (
        rng.randint(0, 8),
        rng.randint(100, 116),
        rng.randint(214, 230),
    )
    foreground = (rng.randint(242, 255),) * 3
    image = Image.new("RGB", (120, 100), background)
    draw = ImageDraw.Draw(image)
    font_size = rng.randint(42, 52)
    while font_size >= 30:
        font = ImageFont.truetype(str(font_path), font_size)
        bbox = draw.textbbox((0, 0), label, font=font, stroke_width=1)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        if width <= 104 and height <= 68:
            break
        font_size -= 2
    x = (120 - width) // 2 - bbox[0] + rng.randint(-3, 3)
    y = (100 - height) // 2 - bbox[1] + rng.randint(-5, 5)
    draw.text((x, y), label, font=font, fill=foreground, stroke_width=1, stroke_fill=foreground)
    blur_radius = rng.choice((0.0, 0.0, 0.2, 0.35))
    if blur_radius:
        image = image.filter(ImageFilter.GaussianBlur(blur_radius))
    rendered_bbox = _foreground_bbox(image, background)
    if rendered_bbox is None:
        raise RuntimeError("rendered image contains no foreground")
    left, top, right, bottom = rendered_bbox
    if left <= 1 or top <= 1 or right >= image.width - 1 or bottom >= image.height - 1:
        raise RuntimeError(f"rendered text touches image boundary: {rendered_bbox}")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue(), {
        "background_rgb": list(background),
        "foreground_rgb": list(foreground),
        "font_size": font_size,
        "offset": [x, y],
        "blur_radius": blur_radius,
        "foreground_bbox": list(rendered_bbox),
    }


def align_characters(expected: str, predicted: str) -> list[tuple[str, str]]:
    rows = len(expected) + 1
    columns = len(predicted) + 1
    costs = [[0] * columns for _ in range(rows)]
    steps = [[None] * columns for _ in range(rows)]
    for row in range(1, rows):
        costs[row][0], steps[row][0] = row, "delete"
    for column in range(1, columns):
        costs[0][column], steps[0][column] = column, "insert"
    for row in range(1, rows):
        for column in range(1, columns):
            options = [
                (costs[row - 1][column - 1] + (expected[row - 1] != predicted[column - 1]), "match"),
                (costs[row - 1][column] + 1, "delete"),
                (costs[row][column - 1] + 1, "insert"),
            ]
            costs[row][column], steps[row][column] = min(options, key=lambda item: item[0])
    pairs = []
    row, column = len(expected), len(predicted)
    while row or column:
        step = steps[row][column]
        if step == "match":
            pairs.append((expected[row - 1], predicted[column - 1]))
            row -= 1
            column -= 1
        elif step == "delete":
            pairs.append((expected[row - 1], ""))
            row -= 1
        else:
            pairs.append(("", predicted[column - 1]))
            column -= 1
    return list(reversed(pairs))


def summarize_predictions(records: list[dict]) -> dict:
    exact = 0
    no_answer = 0
    expected_support = Counter()
    expected_correct = Counter()
    confusions = Counter()
    character_errors = 0
    latencies = []
    for record in records:
        expected = record["expected"]
        predicted = record["predicted"]
        exact += int(expected == predicted)
        no_answer += int(not predicted)
        latencies.append(float(record.get("latency_ms") or 0.0))
        for left, right in align_characters(expected, predicted):
            if left:
                expected_support[left] += 1
                expected_correct[left] += int(left == right)
            if left != right:
                character_errors += 1
                confusions[(left or "<extra>", right or "<missing>")] += 1
    character_count = sum(expected_support.values())
    per_character = {
        character: {
            "support": expected_support[character],
            "correct": expected_correct[character],
            "accuracy": (
                expected_correct[character] / expected_support[character]
                if expected_support[character]
                else None
            ),
        }
        for character in CHARSET
    }
    count = len(records)
    return {
        "count": count,
        "correct": exact,
        "exact_accuracy": exact / count if count else 0.0,
        "no_answer": no_answer,
        "no_answer_rate": no_answer / count if count else 0.0,
        "character_count": character_count,
        "character_errors": character_errors,
        "character_accuracy": 1.0 - character_errors / character_count if character_count else 0.0,
        "per_character": per_character,
        "digit_character_accuracy": _class_accuracy(per_character, "0123456789"),
        "letter_character_accuracy": _class_accuracy(per_character, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        "confusion_symbols": {value: per_character[value] for value in CONFUSION_SYMBOLS},
        "top_confusions": [
            {"expected": left, "predicted": right, "count": occurrences}
            for (left, right), occurrences in confusions.most_common(30)
        ],
        "latency_ms": {
            "mean": statistics.fmean(latencies) if latencies else 0.0,
            "p50": statistics.median(latencies) if latencies else 0.0,
            "max": max(latencies) if latencies else 0.0,
        },
    }


def _class_accuracy(per_character: dict, characters: str) -> float:
    support = sum(per_character[value]["support"] for value in characters)
    correct = sum(per_character[value]["correct"] for value in characters)
    return correct / support if support else 0.0


def ensure_empty_output_dir(output_dir: Path) -> None:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)


def benchmark_flags() -> dict:
    return {
        "synthetic": True,
        "release_evidence": False,
        "may_enter_verified_training_data": False,
        "note": "Synthetic development benchmark only; not a real-site accuracy claim.",
    }


def _make_contact_sheet(entries: list[dict], images_dir: Path, output: Path) -> None:
    selected = entries[:36]
    sheet = Image.new("RGB", (6 * 132, 6 * 126), "white")
    draw = ImageDraw.Draw(sheet)
    for index, entry in enumerate(selected):
        row, column = divmod(index, 6)
        x, y = column * 132 + 6, row * 126 + 20
        image = Image.open(images_dir / entry["image_file"]).convert("RGB")
        sheet.paste(image, (x, y))
        draw.text((x, y - 16), entry["label"], fill="black")
    sheet.save(output, format="PNG")


def run_benchmark(output_dir: Path, count: int, seed: int, model_root: Path, font_dir: Path) -> dict:
    ensure_empty_output_dir(output_dir)
    images_dir = output_dir / "images"
    images_dir.mkdir()
    labels = generate_balanced_labels(count, seed)
    fonts = discover_fonts(font_dir)
    entries = []
    for index, label in enumerate(labels):
        font = fonts[index % len(fonts)]
        image_bytes, render = render_captcha(label, font["path"], seed, index)
        image_file = f"{index:04d}_{label}.png"
        (images_dir / image_file).write_bytes(image_bytes)
        entries.append({
            "index": index,
            "label": label,
            "image_file": image_file,
            "image_sha256": sha256_bytes(image_bytes),
            "font_file": font["file"],
            "font_sha256": font["sha256"],
            "render": render,
        })
    _make_contact_sheet(entries, images_dir, output_dir / "contact_sheet.png")

    engine = ocr_server.OcrEngine(model_root).load()
    prediction_records = []
    for entry in entries:
        started = time.perf_counter()
        try:
            result = engine.recognize(
                (images_dir / entry["image_file"]).read_bytes(),
                expected_length=4,
            )
            predicted = ocr_server.normalize_answer(result.get("answer"))
            solver_answers = {}
            for solver_name in engine.names:
                solver_predictions = [
                    item
                    for item in result.get("predictions") or []
                    if item.get("solver") == solver_name
                ]
                try:
                    solver_result = ocr_server.choose_ensemble(
                        solver_predictions,
                        expected_length=4,
                    )
                    solver_answers[solver_name] = ocr_server.normalize_answer(
                        solver_result.get("answer")
                    )
                except ocr_server.OcrError:
                    solver_answers[solver_name] = ""
            candidate_answers = sorted({
                ocr_server.normalize_answer(item.get("answer"))
                for item in result.get("predictions") or []
                if len(ocr_server.normalize_answer(item.get("answer"))) == 4
            })
            warning = None
        except Exception as error:
            predicted = ""
            solver_answers = {name: "" for name in engine.names}
            candidate_answers = []
            warning = str(error)
        prediction_records.append({
            "image_file": entry["image_file"],
            "expected": entry["label"],
            "predicted": predicted,
            "solver_answers": solver_answers,
            "candidate_answers": candidate_answers,
            "candidate_oracle_hit": entry["label"] in candidate_answers,
            "latency_ms": (time.perf_counter() - started) * 1000,
            "warning": warning,
        })

    model_files = {}
    for relative in (
        "universal/custom.onnx",
        "universal/charsets.json",
        "tixcraft_tm/custom.onnx",
        "tixcraft_tm/charsets.json",
    ):
        path = model_root / relative
        model_files[relative.replace("/", "_")] = sha256_file(path)
    manifest = {
        "schema_version": 1,
        **benchmark_flags(),
        "seed": seed,
        "charset": CHARSET,
        "coverage": label_coverage(labels),
        "fonts": [{key: value for key, value in font.items() if key != "path"} for font in fonts],
        "entries": entries,
    }
    overall_summary = summarize_predictions(prediction_records)
    per_solver = {}
    for solver_name in engine.names:
        per_solver[solver_name] = summarize_predictions([
            {
                "expected": record["expected"],
                "predicted": record["solver_answers"][solver_name],
                "latency_ms": record["latency_ms"],
            }
            for record in prediction_records
        ])
    oracle_correct = sum(record["candidate_oracle_hit"] for record in prediction_records)
    evaluation = {
        "schema_version": 1,
        **benchmark_flags(),
        "seed": seed,
        "runtime": {
            "python": platform.python_version(),
            "pillow": PILLOW_VERSION,
            "solver_names": engine.names,
        },
        "model_sha256": model_files,
        "summary": overall_summary,
        "per_solver": per_solver,
        "candidate_oracle": {
            "correct": oracle_correct,
            "accuracy": oracle_correct / len(prediction_records) if prediction_records else 0.0,
        },
        "records": prediction_records,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "evaluation.json").write_text(
        json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "README.md").write_text(
        "# Synthetic alphanumeric development benchmark\n\n"
        "This output is synthetic diagnostic evidence only. It is not release evidence, "
        "not a real-site accuracy claim, and must not be copied into training/samples.\n",
        encoding="utf-8",
    )
    return {"manifest": manifest, "evaluation": evaluation}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260820)
    parser.add_argument("--model-root", type=Path, default=ROOT / "models")
    parser.add_argument("--font-dir", type=Path, default=Path(r"C:\Windows\Fonts"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = run_benchmark(
            args.output_dir,
            count=args.count,
            seed=args.seed,
            model_root=args.model_root,
            font_dir=args.font_dir,
        )
    except (OSError, RuntimeError, ValueError, ocr_server.OcrError) as error:
        print(f"Alphanumeric benchmark error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report["evaluation"]["summary"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
