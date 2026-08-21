# Third-party notices

This repository's source code is licensed under the MIT License. Third-party components retain their own licenses.

## Runtime dependencies

- [ddddocr](https://github.com/sml2h3/ddddocr) — MIT License. The PyPI package includes its official ONNX models.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — MIT License.
- [Pillow](https://github.com/python-pillow/Pillow) — HPND License.

The exact runtime versions are pinned in `requirements.txt`.

## Optional custom models

Files named `models/*/custom.onnx` and their `charsets.json` are not part of the GitHub distribution. A user who adds an optional custom model is responsible for confirming its source, integrity, and redistribution terms.

## Evaluation data

Local training samples, feedback, test outputs, downloaded datasets, and experiment checkpoints are intentionally excluded from the repository. External evaluation results must not be treated as a license to redistribute the underlying images.
