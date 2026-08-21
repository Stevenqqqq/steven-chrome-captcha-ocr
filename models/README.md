# Optional custom models

The public repository works with the `official` solver bundled by the MIT-licensed `ddddocr` dependency. Custom models are optional and are not committed by default.

To add a local model, create one of these directories:

```text
models/
  universal/
    custom.onnx
    charsets.json
  tixcraft_tm/
    custom.onnx
    charsets.json
```

Both files for a solver must exist. If neither exists, that solver is skipped. If only one exists, startup fails instead of silently loading an incomplete model.

Only add models whose source, integrity, and redistribution license you have verified. Local model files are ignored by Git.
