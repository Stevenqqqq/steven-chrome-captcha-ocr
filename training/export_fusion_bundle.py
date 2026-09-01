from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn


V4_CHECKPOINT = Path(r"D:\StevenOCR-Training\artifacts\glyph_reranker_v4_rep1000_train_20260831\best_v4.pt")
V6_CHECKPOINT = Path(r"D:\StevenOCR-Training\artifacts\glyph_direct_v6_1_fp32_20260831\run\best.pt")
V6_SCRIPT = Path(r"D:\StevenOCR-Training\artifacts\glyph_direct_v6_20260831\train_v6.py")
V7_CHECKPOINT = Path(r"D:\StevenOCR-Training\artifacts\glyph_crop_v7_20260831\run\best.pt")
V7_SCRIPT = Path(r"D:\StevenOCR-Training\artifacts\glyph_crop_v7_20260831\train_v7.py")


def import_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ExportableDirectModel(nn.Module):
    """Exact fixed-input replacement for AdaptiveAvgPool2d((1, 8))."""

    def __init__(self, source: nn.Module):
        super().__init__()
        self.features = source.features
        self.project = source.project
        self.classifier = source.classifier

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        features = self.project(self.features(inputs)).mean(dim=2, keepdim=True)
        starts = (0, 0, 1, 1, 2, 3, 3, 4)
        ends = (1, 2, 2, 3, 4, 4, 5, 5)
        pooled = torch.cat([
            features[:, :, :, start:end].mean(dim=3, keepdim=True)
            for start, end in zip(starts, ends)
        ], dim=3)
        return self.classifier(pooled).reshape(-1, 4, 36)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    workspace = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(workspace))
    import fusion_ocr

    v4 = torch.load(V4_CHECKPOINT, map_location="cpu", weights_only=False)
    state = v4["state_dict"]
    np.savez(
        output / "reranker.npz",
        mean=v4["mean"].numpy(), std=v4["std"].numpy(),
        w0=state["0.weight"].numpy(), b0=state["0.bias"].numpy(),
        w1=state["3.weight"].numpy(), b1=state["3.bias"].numpy(),
        w2=state["5.weight"].numpy(), b2=state["5.bias"].numpy(),
    )

    v6_code = import_module("fusion_export_v6", V6_SCRIPT)
    v6_checkpoint = torch.load(V6_CHECKPOINT, map_location="cpu", weights_only=False)
    v6_model = v6_code.SpatialFixed4MobileNet()
    v6_model.load_state_dict(v6_checkpoint["model"])
    v6_model.eval()
    exportable_v6 = ExportableDirectModel(v6_model).eval()
    v6_example = torch.zeros(1, 3, *v6_checkpoint["image_size"])
    if not torch.allclose(v6_model(v6_example), exportable_v6(v6_example), atol=1e-6, rtol=1e-6):
        raise RuntimeError("exportable v6 pooling is not equivalent")
    torch.onnx.export(
        exportable_v6, v6_example, output / "direct.onnx",
        input_names=["image"], output_names=["logits"], opset_version=17,
        dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}},
    )

    v7_code = import_module("fusion_export_v7", V7_SCRIPT)
    v7_checkpoint = torch.load(V7_CHECKPOINT, map_location="cpu", weights_only=False)
    v7_model = v7_code.GlyphCNN()
    v7_model.load_state_dict(v7_checkpoint["model"])
    v7_model.eval()
    torch.onnx.export(
        v7_model, torch.zeros(4, 3, *v7_checkpoint["image_size"]), output / "crop.onnx",
        input_names=["image"], output_names=["logits"], opset_version=17,
        dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}},
    )

    import onnxruntime as ort

    torch.manual_seed(20260831)
    direct_input = torch.rand(2, 3, *v6_checkpoint["image_size"])
    crop_input = torch.rand(8, 3, *v7_checkpoint["image_size"])
    direct_session = ort.InferenceSession(str(output / "direct.onnx"), providers=["CPUExecutionProvider"])
    crop_session = ort.InferenceSession(str(output / "crop.onnx"), providers=["CPUExecutionProvider"])
    direct_onnx = direct_session.run(None, {"image": direct_input.numpy()})[0]
    crop_onnx = crop_session.run(None, {"image": crop_input.numpy()})[0]
    direct_error = float(np.max(np.abs(v6_model(direct_input).detach().numpy() - direct_onnx)))
    crop_error = float(np.max(np.abs(v7_model(crop_input).detach().numpy() - crop_onnx)))
    if direct_error > 1e-4 or crop_error > 1e-4:
        raise RuntimeError(f"ONNX equivalence failed: direct={direct_error}, crop={crop_error}")

    config = {
        "schema_version": 1,
        "fusion_model": "v4+v6+v7",
        "alpha": 6.0,
        "beta": 6.0,
        "threshold": 0.5,
        "charset": v6_checkpoint["charset"],
        "feature_names": v4["feature_names"],
        "direct_image_size": v6_checkpoint["image_size"],
        "crop_image_size": v7_checkpoint["image_size"],
        "crop_margin": v7_checkpoint["crop_margin"],
        "source_sha256": {
            "v4": sha256(V4_CHECKPOINT),
            "v6": sha256(V6_CHECKPOINT),
            "v7": sha256(V7_CHECKPOINT),
        },
        "validation_reference": {
            "representative_exact": 0.98,
            "representative_char": 0.995,
            "hard_exact": 26 / 30,
            "hard_char": 116 / 120,
        },
        "export_equivalence_max_abs": {"direct": direct_error, "crop": crop_error},
    }
    if config["feature_names"] != fusion_ocr.feature_names():
        raise RuntimeError("feature names do not match runtime")
    (output / "config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "output": str(output),
        "files": {path.name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
                  for path in sorted(output.iterdir()) if path.is_file()},
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
