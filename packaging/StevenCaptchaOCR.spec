from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, copy_metadata


PROJECT_ROOT = Path(SPECPATH).resolve().parent

datas = []
binaries = []
hiddenimports = [
    "fusion_ocr",
    "numpy",
    "onnxruntime.capi.onnxruntime_pybind11_state",
    "PIL.Image",
    "PIL.ImageEnhance",
    "PIL.ImageFilter",
    "PIL.ImageOps",
]

datas += collect_data_files("ddddocr")
datas += collect_data_files("onnxruntime")
binaries += collect_dynamic_libs("onnxruntime")
datas += copy_metadata("ddddocr")
datas += copy_metadata("onnxruntime")

datas += [
    (str(PROJECT_ROOT / "models" / "fusion_v7"), "models/fusion_v7"),
]

a = Analysis(
    [str(PROJECT_ROOT / "ocr_server.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StevenCaptchaOCR",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="StevenCaptchaOCR",
)
