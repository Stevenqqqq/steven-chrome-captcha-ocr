from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = ROOT / "extension"
VENDOR_ORT_DIR = EXTENSION_ROOT / "vendor" / "ort"
EXTENSION_MODELS_DIR = EXTENSION_ROOT / "models"
DEFAULT_ORT_VERSION = "1.23.2"

ORT_FILES = (
    "ort.min.mjs",
    "ort.min.js",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install_ort_web(version: str = DEFAULT_ORT_VERSION, dest_dir: Path = VENDOR_ORT_DIR) -> dict:
    dest_dir.mkdir(parents=True, exist_ok=True)
    copied: dict[str, dict] = {}
    with TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        proc = subprocess.run(
            ["npm.cmd", "pack", f"onnxruntime-web@{version}"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"npm pack onnxruntime-web@{version} 失敗: {proc.stderr.strip()}")
        tarballs = list(tmp_path.glob("onnxruntime-web-*.tgz"))
        if not tarballs:
            raise RuntimeError("找不到 onnxruntime-web 壓縮檔")
        with tarfile.open(tarballs[0], "r:gz") as archive:
            members = {Path(m.name).name: m for m in archive.getmembers() if "/dist/" in m.name}
            for filename in ORT_FILES:
                member = members.get(filename)
                if not member:
                    continue
                target = dest_dir / filename
                source = archive.extractfile(member)
                if source is None:
                    continue
                target.write_bytes(source.read())
                copied[filename] = {
                    "bytes": target.stat().st_size,
                    "sha256": sha256_file(target),
                }
    if "ort.min.mjs" not in copied and "ort.min.js" not in copied:
        raise RuntimeError("onnxruntime-web 缺少核心腳本")
    return {"version": version, "files": copied}


def sync_local_models(
    source_models_root: Path = ROOT / "models",
    dest_dir: Path = EXTENSION_MODELS_DIR,
) -> dict:
    dest_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        "schema_version": 2,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "local_only": True,
        "public_redistributable": False,
        "bundles": {},
    }

    # Export MIT-licensed ddddocr official model (common_old.onnx, ~13.6 MB) + compact ASCII index map.
    try:
        import ddddocr

        dddd_dir = Path(ddddocr.__file__).resolve().parent
        official_onnx = dddd_dir / "common_old.onnx"
        if official_onnx.is_file():
            ocr = ddddocr.DdddOcr(show_ad=False)
            full_charset = ocr.ocr_engine.get_charset()
            ascii_entries = [
                {"index": idx, "char": ch}
                for idx, ch in enumerate(full_charset)
                if ch.isascii() and ch.isalnum()
            ]
            official_dst = dest_dir / "official"
            official_dst.mkdir(parents=True, exist_ok=True)
            onnx_target = official_dst / "common_old.onnx"
            shutil.copy2(official_onnx, onnx_target)
            charset_target = official_dst / "charset.json"
            charset_payload = {
                "schema_version": 1,
                "blank_index": 0,
                "num_classes": len(full_charset),
                "target_height": 64,
                "ascii_entries": ascii_entries,
            }
            charset_target.write_text(
                json.dumps(charset_payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            manifest["bundles"]["official"] = {
                "kind": "ddddocr_ctc",
                "license": "MIT (ddddocr)",
                "path": "models/official",
                "files": {
                    "common_old.onnx": {
                        "bytes": onnx_target.stat().st_size,
                        "sha256": sha256_file(onnx_target),
                    },
                    "charset.json": {
                        "bytes": charset_target.stat().st_size,
                        "sha256": sha256_file(charset_target),
                    },
                },
            }
    except Exception:
        pass

    fusion_src = source_models_root / "fusion_v7"
    if (fusion_src / "direct.onnx").is_file() and (fusion_src / "crop.onnx").is_file() and (fusion_src / "config.json").is_file():
        fusion_dst = dest_dir / "fusion_v7"
        fusion_dst.mkdir(parents=True, exist_ok=True)
        files = {}
        for name in ("config.json", "direct.onnx", "crop.onnx"):
            target = fusion_dst / name
            shutil.copy2(fusion_src / name, target)
            files[name] = {
                "bytes": target.stat().st_size,
                "sha256": sha256_file(target),
            }
        manifest["bundles"]["fusion_v7"] = {
            "kind": "fixed4_dual_cnn",
            "path": "models/fusion_v7",
            "files": files,
        }

    universal_src = source_models_root / "universal"
    if (universal_src / "custom.onnx").is_file() and (universal_src / "charsets.json").is_file():
        universal_dst = dest_dir / "universal"
        universal_dst.mkdir(parents=True, exist_ok=True)
        files = {}
        for name in ("custom.onnx", "charsets.json"):
            target = universal_dst / name
            shutil.copy2(universal_src / name, target)
            files[name] = {
                "bytes": target.stat().st_size,
                "sha256": sha256_file(target),
            }
        manifest["bundles"]["universal"] = {
            "kind": "variable_ctc",
            "path": "models/universal",
            "files": files,
        }

    (dest_dir / "bundle_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare local onnxruntime-web and model assets for Chrome MV3 offline OCR.")
    parser.add_argument("--ort-version", default=DEFAULT_ORT_VERSION)
    parser.add_argument("--skip-ort", action="store_true")
    parser.add_argument("--skip-models", action="store_true")
    args = parser.parse_args()

    summary: dict = {}
    if not args.skip_ort:
        summary["ort"] = install_ort_web(args.ort_version)
    if not args.skip_models:
        summary["models"] = sync_local_models()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
