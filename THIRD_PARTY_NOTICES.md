# Third-party notices

This repository's source code is licensed under the MIT License. Third-party components retain their own licenses.

## Runtime dependencies

- [ddddocr](https://github.com/sml2h3/ddddocr) — MIT License. The PyPI package includes its official ONNX models.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — MIT License.
- [Pillow](https://github.com/python-pillow/Pillow) — HPND License.

The direct runtime versions are pinned in `requirements.txt`. Their Windows wheels also bring in transitive runtime components, including:

- NumPy — BSD-3-Clause License.
- OpenCV Python — Apache License 2.0.
- coloredlogs and humanfriendly — MIT License.
- FlatBuffers — Apache License 2.0.
- packaging — Apache-2.0 OR BSD-2-Clause.
- Protocol Buffers — BSD-3-Clause License.
- SymPy — BSD License.
- charset-normalizer — MIT License.

## Build tooling

- [PyInstaller](https://pyinstaller.org/) — GPL-2.0-or-later with the PyInstaller bootloader exception.
- PyInstaller Hooks Contrib — Apache License 2.0.

Build-only tools are pinned in `requirements-build.txt`. Each dependency retains its own copyright and license terms; its upstream project and installed package metadata contain the complete license text.

## Optional custom models

Files named `models/*/custom.onnx` and their `charsets.json` are not part of the GitHub distribution. A user who adds an optional custom model is responsible for confirming its source, integrity, and redistribution terms.

## Evaluation data

Local training samples, feedback, test outputs, downloaded datasets, and experiment checkpoints are intentionally excluded from the repository. External evaluation results must not be treated as a license to redistribute the underlying images.
