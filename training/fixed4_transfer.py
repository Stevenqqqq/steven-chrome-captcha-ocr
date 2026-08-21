from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import shutil
import sys
import time
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

import trial_pipeline


DEFAULT_MANIFEST = ROOT / "tests" / "results" / "dataset_manifest.json"
DEFAULT_SAMPLES = ROOT / "training" / "samples"
CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
IMAGE_SIZE = (160, 128)  # width, height
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


class Fixed4TransferError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_fixed4_entries(entries: list[dict]) -> None:
    for entry in entries:
        label = entry.get("label")
        if not isinstance(label, str) or len(label) != 4 or any(character not in CHARSET for character in label):
            raise Fixed4TransferError(f"固定四字模型不接受標籤: {label!r}")


def deterministic_split(entries: list[dict], seed: int, validation_count: int) -> tuple[list[dict], list[dict]]:
    if validation_count <= 0 or validation_count >= len(entries):
        raise Fixed4TransferError("internal validation 數量必須大於 0 且小於 train 數量")

    def split_key(entry: dict) -> str:
        material = f"{seed}:{entry['image_sha256']}".encode("ascii")
        return hashlib.sha256(material).hexdigest()

    ordered = sorted(entries, key=lambda entry: (split_key(entry), entry["image_file"]))
    validation = ordered[:validation_count]
    training = ordered[validation_count:]
    return training, validation


def prepare_dataset(
    manifest_path: Path,
    samples_dir: Path,
    output_dir: Path,
    seed: int,
    validation_count: int,
) -> dict:
    manifest = trial_pipeline.load_manifest(manifest_path)
    entries = manifest["entries"]
    validate_fixed4_entries(entries)
    source_train = [entry for entry in entries if entry["split"] == "train"]
    external = [entry for entry in entries if entry["split"] in {"validation", "test"}]
    internal_train, internal_validation = deterministic_split(source_train, seed, validation_count)

    if output_dir.exists() and any(output_dir.iterdir()):
        raise Fixed4TransferError(f"輸出目錄不是空的: {output_dir}")
    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    exported: list[dict] = []
    for internal_split, selected in (("train", internal_train), ("validation", internal_validation)):
        for entry in selected:
            source = trial_pipeline.verified_sample_path(samples_dir, entry)
            destination = images_dir / entry["image_file"]
            shutil.copy2(source, destination)
            exported.append({
                "image_file": entry["image_file"],
                "image_sha256": entry["image_sha256"],
                "label": entry["label"],
                "internal_split": internal_split,
            })

    exported_hashes = {entry["image_sha256"] for entry in exported}
    external_hashes = {entry["image_sha256"] for entry in external}
    if exported_hashes & external_hashes:
        raise Fixed4TransferError("訓練資料與外部保留集出現 SHA-256 交集")
    train_hashes = {entry["image_sha256"] for entry in exported if entry["internal_split"] == "train"}
    validation_hashes = {
        entry["image_sha256"] for entry in exported if entry["internal_split"] == "validation"
    }
    if train_hashes & validation_hashes:
        raise Fixed4TransferError("internal train/validation 出現 SHA-256 交集")

    dataset = {
        "schema_version": 1,
        "task": "fixed_four_uppercase_positions",
        "manifest_sha256": sha256_file(manifest_path),
        "manifest_seed": manifest.get("seed"),
        "split_seed": seed,
        "charset": CHARSET,
        "image_size": list(IMAGE_SIZE),
        "source_counts": dict(manifest["split_counts"]),
        "internal_counts": {"train": len(internal_train), "validation": len(internal_validation)},
        "external_counts": {
            "validation": manifest["split_counts"]["validation"],
            "test": manifest["split_counts"]["test"],
        },
        "isolation": {
            "external_images_exported": False,
            "train_validation_hash_intersection": 0,
            "training_external_hash_intersection": 0,
            "may_replace_production_model": False,
        },
        "entries": exported,
    }
    dataset_path = output_dir / "dataset.json"
    dataset_path.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"output": str(output_dir), **{key: value for key, value in dataset.items() if key != "entries"}}


def label_to_indices(label: str) -> list[int]:
    if len(label) != 4 or any(character not in CHARSET for character in label):
        raise Fixed4TransferError(f"無效固定四字標籤: {label!r}")
    return [CHARSET.index(character) for character in label]


def predictions_to_metrics(expected: list[str], predicted: list[str]) -> dict:
    if len(expected) != len(predicted):
        raise Fixed4TransferError("expected/predicted 數量不一致")
    exact = 0
    correct_characters = 0
    failures = []
    for expected_label, predicted_label in zip(expected, predicted):
        is_exact = expected_label == predicted_label
        exact += int(is_exact)
        correct_characters += sum(a == b for a, b in zip(expected_label, predicted_label))
        if not is_exact:
            failures.append({"expected": expected_label, "predicted": predicted_label})
    count = len(expected)
    character_count = sum(len(label) for label in expected)
    return {
        "count": count,
        "correct": exact,
        "accuracy": exact / count if count else 0.0,
        "correct_characters": correct_characters,
        "character_count": character_count,
        "character_accuracy": correct_characters / character_count if character_count else 0.0,
        "failures": failures,
    }


def _load_dataset_index(dataset_dir: Path) -> dict:
    path = dataset_dir / "dataset.json"
    try:
        dataset = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise Fixed4TransferError(f"無法讀取 dataset.json: {error}") from error
    entries = dataset.get("entries")
    if not isinstance(entries, list):
        raise Fixed4TransferError("dataset.json 缺少 entries")
    validate_fixed4_entries(entries)
    for entry in entries:
        image_path = dataset_dir / "images" / entry["image_file"]
        if not image_path.is_file() or sha256_file(image_path) != entry["image_sha256"]:
            raise Fixed4TransferError(f"資料圖片遺失或雜湊不符: {entry['image_file']}")
    return dataset


def train_model(
    dataset_dir: Path,
    output_dir: Path,
    seed: int,
    phase1_epochs: int,
    phase2_epochs: int,
    patience: int,
) -> dict:
    try:
        import numpy as np
        import torch
        from PIL import Image
        from torch import nn
        from torch.utils.data import DataLoader, Dataset
        from torchvision import transforms
        from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small
    except ImportError as error:
        raise Fixed4TransferError(f"訓練環境缺少套件: {error}") from error

    dataset_index = _load_dataset_index(dataset_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise Fixed4TransferError(f"訓練輸出目錄不是空的: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")

    train_entries = [entry for entry in dataset_index["entries"] if entry["internal_split"] == "train"]
    validation_entries = [
        entry for entry in dataset_index["entries"] if entry["internal_split"] == "validation"
    ]

    normalize = transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD)
    train_transform = transforms.Compose([
        transforms.Resize((IMAGE_SIZE[1], IMAGE_SIZE[0])),
        transforms.ColorJitter(brightness=0.08, contrast=0.08, saturation=0.08),
        transforms.RandomApply([transforms.GaussianBlur(kernel_size=3, sigma=(0.1, 0.4))], p=0.20),
        transforms.ToTensor(),
        normalize,
    ])
    validation_transform = transforms.Compose([
        transforms.Resize((IMAGE_SIZE[1], IMAGE_SIZE[0])),
        transforms.ToTensor(),
        normalize,
    ])

    class CaptchaDataset(Dataset):
        def __init__(self, entries: list[dict], transform):
            self.entries = entries
            self.transform = transform

        def __len__(self):
            return len(self.entries)

        def __getitem__(self, index):
            entry = self.entries[index]
            with Image.open(dataset_dir / "images" / entry["image_file"]) as opened:
                image = opened.convert("RGB")
            return self.transform(image), torch.tensor(label_to_indices(entry["label"]), dtype=torch.long)

    generator = torch.Generator().manual_seed(seed)
    train_loader = DataLoader(
        CaptchaDataset(train_entries, train_transform),
        batch_size=32,
        shuffle=True,
        num_workers=0,
        generator=generator,
    )
    validation_loader = DataLoader(
        CaptchaDataset(validation_entries, validation_transform),
        batch_size=64,
        shuffle=False,
        num_workers=0,
    )

    class Fixed4MobileNet(nn.Module):
        def __init__(self):
            super().__init__()
            base = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
            self.features = base.features
            self.avgpool = base.avgpool
            self.embedding = nn.Sequential(*list(base.classifier.children())[:-1])
            self.head = nn.Linear(base.classifier[-1].in_features, 4 * len(CHARSET))

        def forward(self, inputs):
            features = self.features(inputs)
            features = self.avgpool(features)
            features = torch.flatten(features, 1)
            features = self.embedding(features)
            return self.head(features).reshape(-1, 4, len(CHARSET))

    model = Fixed4MobileNet().to(device)
    position_counts = [Counter() for _ in range(4)]
    for entry in train_entries:
        for position, character in enumerate(entry["label"]):
            position_counts[position][CHARSET.index(character)] += 1
    criteria = []
    for counts in position_counts:
        weights = []
        for index in range(len(CHARSET)):
            count = counts[index]
            weight = math.sqrt(len(train_entries) / max(count, 1))
            weights.append(min(weight, 3.0))
        tensor = torch.tensor(weights, dtype=torch.float32, device=device)
        tensor /= tensor.mean()
        criteria.append(nn.CrossEntropyLoss(weight=tensor, label_smoothing=0.05))

    history: list[dict] = []
    best = {"accuracy": -1.0, "character_accuracy": -1.0, "epoch": 0, "phase": "", "path": ""}
    epochs_without_improvement = 0

    def evaluate() -> dict:
        model.eval()
        expected: list[str] = []
        predicted: list[str] = []
        with torch.no_grad():
            for inputs, labels in validation_loader:
                logits = model(inputs.to(device))
                indices = logits.argmax(dim=2).cpu().tolist()
                expected.extend("".join(CHARSET[item] for item in row) for row in labels.tolist())
                predicted.extend("".join(CHARSET[item] for item in row) for row in indices)
        return predictions_to_metrics(expected, predicted)

    def run_phase(name: str, epochs: int, optimizer) -> bool:
        nonlocal epochs_without_improvement, best
        for _ in range(epochs):
            model.train()
            total_loss = 0.0
            batches = 0
            for inputs, labels in train_loader:
                inputs = inputs.to(device)
                labels = labels.to(device)
                optimizer.zero_grad(set_to_none=True)
                logits = model(inputs)
                loss = sum(criteria[position](logits[:, position, :], labels[:, position]) for position in range(4)) / 4
                loss.backward()
                optimizer.step()
                total_loss += loss.item()
                batches += 1
            metrics = evaluate()
            epoch = len(history) + 1
            record = {
                "epoch": epoch,
                "phase": name,
                "loss": total_loss / max(batches, 1),
                "validation": {key: value for key, value in metrics.items() if key != "failures"},
            }
            history.append(record)
            improved = (metrics["accuracy"], metrics["character_accuracy"]) > (
                best["accuracy"], best["character_accuracy"]
            )
            if improved:
                checkpoint = output_dir / "best.pt"
                torch.save({
                    "state_dict": model.state_dict(),
                    "epoch": epoch,
                    "phase": name,
                    "validation": metrics,
                    "seed": seed,
                    "charset": CHARSET,
                    "image_size": IMAGE_SIZE,
                }, checkpoint)
                best = {
                    "accuracy": metrics["accuracy"],
                    "character_accuracy": metrics["character_accuracy"],
                    "epoch": epoch,
                    "phase": name,
                    "path": str(checkpoint),
                }
                epochs_without_improvement = 0
            else:
                epochs_without_improvement += 1
            (output_dir / "history.json").write_text(
                json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            if epochs_without_improvement >= patience:
                return True
        return False

    for parameter in model.features.parameters():
        parameter.requires_grad = False
    phase1_optimizer = torch.optim.AdamW(
        list(model.embedding.parameters()) + list(model.head.parameters()), lr=1e-3, weight_decay=1e-4
    )
    phase1_stopped = run_phase("frozen_backbone", phase1_epochs, phase1_optimizer)

    epochs_without_improvement = 0
    for parameter in model.features[-4:].parameters():
        parameter.requires_grad = True
    phase2_optimizer = torch.optim.AdamW([
        {"params": model.features[-4:].parameters(), "lr": 1e-4},
        {"params": model.embedding.parameters(), "lr": 3e-4},
        {"params": model.head.parameters(), "lr": 5e-4},
    ], weight_decay=1e-4)
    phase2_stopped = run_phase("partial_finetune", phase2_epochs, phase2_optimizer)

    checkpoint = torch.load(output_dir / "best.pt", map_location=device, weights_only=False)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    onnx_path = output_dir / "candidate.onnx"
    dummy = torch.zeros(1, 3, IMAGE_SIZE[1], IMAGE_SIZE[0], device=device)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
        do_constant_folding=True,
    )

    try:
        import onnx
        import onnxruntime as ort

        onnx.checker.check_model(onnx.load(str(onnx_path)))
        session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        smoke = session.run(None, {session.get_inputs()[0].name: np.zeros((2, 3, 128, 160), np.float32)})[0]
        if smoke.shape != (2, 4, len(CHARSET)) or smoke.dtype != np.float32 or not np.isfinite(smoke).all():
            raise Fixed4TransferError(f"ONNX Runtime smoke 輸出不符: {smoke.shape} {smoke.dtype}")
    except ImportError as error:
        raise Fixed4TransferError(f"ONNX 驗證環境缺少套件: {error}") from error

    report = {
        "schema_version": 1,
        "architecture": "torchvision_mobilenet_v3_small_fixed_4x26",
        "pretrained_weights": "MobileNet_V3_Small_Weights.DEFAULT",
        "seed": seed,
        "device": str(device),
        "torch_version": torch.__version__,
        "torch_file": torch.__file__,
        "cuda_available": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "dataset_sha256": sha256_file(dataset_dir / "dataset.json"),
        "internal_counts": dataset_index["internal_counts"],
        "phase1_early_stopped": phase1_stopped,
        "phase2_early_stopped": phase2_stopped,
        "history_count": len(history),
        "best": best,
        "checkpoint_sha256": sha256_file(output_dir / "best.pt"),
        "onnx_sha256": sha256_file(onnx_path),
        "onnx_checker": "passed",
        "ort_smoke_shape": list(smoke.shape),
        "output_contract": "float32 [batch,4,26] logits; charset A-Z",
        "may_replace_production_model": False,
    }
    (output_dir / "training_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def _preprocess_numpy(image_path: Path):
    try:
        import numpy as np
        from PIL import Image
    except ImportError as error:
        raise Fixed4TransferError(f"推論環境缺少套件: {error}") from error
    with Image.open(image_path) as opened:
        image = opened.convert("RGB").resize(IMAGE_SIZE, Image.Resampling.BILINEAR)
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - np.asarray(IMAGENET_MEAN, dtype=np.float32)) / np.asarray(IMAGENET_STD, dtype=np.float32)
    return np.transpose(array, (2, 0, 1))


def evaluate_onnx(
    manifest_path: Path,
    samples_dir: Path,
    onnx_path: Path,
    output_path: Path,
) -> dict:
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError as error:
        raise Fixed4TransferError(f"推論環境缺少套件: {error}") from error
    manifest = trial_pipeline.load_manifest(manifest_path)
    validate_fixed4_entries(manifest["entries"])
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    report = {
        "schema_version": 1,
        "manifest_sha256": sha256_file(manifest_path),
        "candidate_onnx_sha256": sha256_file(onnx_path),
        "candidate": {},
        "may_replace_production_model": False,
    }
    for split in ("validation", "test"):
        entries = [entry for entry in manifest["entries"] if entry["split"] == split]
        expected: list[str] = []
        predicted: list[str] = []
        failures_with_files = []
        latencies = []
        for entry in entries:
            image_path = trial_pipeline.verified_sample_path(samples_dir, entry)
            inputs = _preprocess_numpy(image_path)[None, ...]
            started = time.perf_counter()
            logits = session.run(None, {input_name: inputs})[0]
            latencies.append((time.perf_counter() - started) * 1000)
            answer = "".join(CHARSET[index] for index in np.argmax(logits[0], axis=1).tolist())
            expected.append(entry["label"])
            predicted.append(answer)
            if answer != entry["label"]:
                failures_with_files.append({
                    "image_file": entry["image_file"],
                    "expected": entry["label"],
                    "predicted": answer,
                })
        metrics = predictions_to_metrics(expected, predicted)
        metrics["failures"] = failures_with_files
        metrics["latency_ms"] = {
            "mean": sum(latencies) / len(latencies),
            "max": max(latencies),
        }
        report["candidate"][split] = metrics
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fixed four-position transfer-learning OCR trial.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    prepare.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--seed", type=int, default=20260811)
    prepare.add_argument("--internal-validation-count", type=int, default=40)

    train = subparsers.add_parser("train")
    train.add_argument("--dataset", type=Path, required=True)
    train.add_argument("--output", type=Path, required=True)
    train.add_argument("--seed", type=int, default=20260811)
    train.add_argument("--phase1-epochs", type=int, default=12)
    train.add_argument("--phase2-epochs", type=int, default=40)
    train.add_argument("--patience", type=int, default=10)

    evaluate = subparsers.add_parser("evaluate")
    evaluate.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    evaluate.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    evaluate.add_argument("--onnx", type=Path, required=True)
    evaluate.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "prepare":
            result = prepare_dataset(
                args.manifest, args.samples, args.output, args.seed, args.internal_validation_count
            )
        elif args.command == "train":
            result = train_model(
                args.dataset, args.output, args.seed, args.phase1_epochs, args.phase2_epochs, args.patience
            )
        else:
            result = evaluate_onnx(args.manifest, args.samples, args.onnx, args.output)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (Fixed4TransferError, trial_pipeline.TrialPipelineError) as error:
        print(f"Fixed4 transfer error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
