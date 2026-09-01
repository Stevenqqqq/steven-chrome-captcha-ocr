from __future__ import annotations

import json
import hashlib
import math
from collections import defaultdict
from io import BytesIO
from pathlib import Path
from typing import Iterable


ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
VARIANT_ORDER = (
    "dark_primary",
    "dark_normalized",
    "dark_contrast",
    "dark_autocontrast",
    "dark_threshold",
    "dark_resize2",
    "gray_pad2",
    "dark_raw",
)
LIGHT_VARIANTS = (
    "raw",
    "gray",
    "contrast",
    "threshold",
    "resize2",
)
LIGHT_FEATURE_VERSION = "light_generic_v1"
NEG_INF = float("-inf")


class FusionModelError(RuntimeError):
    pass


def _logadd(left: float, right: float) -> float:
    """Stable two-value log-add used in the CTC inner loop."""

    if left == NEG_INF:
        return right
    if right == NEG_INF:
        return left
    maximum = max(left, right)
    return maximum + math.log1p(math.exp(-abs(left - right)))


def ctc_prefix_beam(
    probabilities: list,
    charset: list[str],
    *,
    target_length: int = 4,
    beam_width: int = 80,
    topn: int = 5,
) -> list[dict]:
    # ddddocr's large charset contains distinct upper- and lower-case entries.
    # The trained candidate extractor deliberately used the exact lower-case
    # indices, so case-folding the whole charset changes the beam candidates.
    indices = {character.lower(): charset.index(character.lower()) for character in ALPHABET}
    beams: dict[str, tuple[float, float]] = {"": (0.0, NEG_INF)}
    epsilon = 1e-12

    for timestep in probabilities:
        row = timestep[0]
        next_beams: dict[str, list[float]] = defaultdict(lambda: [NEG_INF, NEG_INF])
        blank_log = math.log(max(float(row[0]), epsilon))
        character_logs = tuple(
            (character, math.log(max(float(row[index]), epsilon)))
            for character, index in indices.items()
        )
        for prefix, (prob_blank, prob_nonblank) in beams.items():
            total = _logadd(prob_blank, prob_nonblank)
            next_beams[prefix][0] = _logadd(next_beams[prefix][0], total + blank_log)
            last_character = prefix[-1:] or None
            for character, character_log in character_logs:
                if last_character == character:
                    next_beams[prefix][1] = _logadd(
                        next_beams[prefix][1], prob_nonblank + character_log
                    )
                    if len(prefix) < target_length:
                        extended = prefix + character
                        next_beams[extended][1] = _logadd(
                            next_beams[extended][1], prob_blank + character_log
                        )
                elif len(prefix) < target_length:
                    extended = prefix + character
                    next_beams[extended][1] = _logadd(
                        next_beams[extended][1], total + character_log
                    )
        ranked = sorted(
            next_beams.items(),
            key=lambda item: _logadd(item[1][0], item[1][1]),
            reverse=True,
        )[:beam_width]
        beams = {prefix: (scores[0], scores[1]) for prefix, scores in ranked}

    candidates = [
        (prefix.upper(), _logadd(prob_blank, prob_nonblank))
        for prefix, (prob_blank, prob_nonblank) in beams.items()
        if len(prefix) == target_length
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    if not candidates:
        return []
    best_score = candidates[0][1]
    return [
        {
            "answer": answer,
            "log_probability": score,
            "relative_probability": math.exp(max(-80.0, score - best_score)),
        }
        for answer, score in candidates[:topn]
    ]


def _edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_character != right_character),
            ))
        previous = current
    return previous[-1]


def _normalize_alphanumeric(value) -> str:
    return "".join(
        character.upper()
        for character in str(value or "")
        if character in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    )


def feature_names() -> list[str]:
    names = [
        "aggregate_score", "top1_votes", "present_count",
        "official_text_matches", "baseline_match",
        "baseline_position_matches", "baseline_edit_distance",
        "unique_character_count", "adjacent_repeat_count",
    ]
    for variant in VARIANT_ORDER:
        names.extend((
            f"{variant}_present",
            f"{variant}_rank_inverse",
            f"{variant}_relative_probability",
            f"{variant}_top1",
        ))
    for position in range(4):
        names.extend(f"candidate_{position}_{character}" for character in ALPHABET)
    return names


def light_feature_names() -> list[str]:
    """Return the feature layout used by the light-background reranker.

    This is intentionally kept separate from the existing 145-value dark
    fusion layout.  The training runner's candidate_features function is the
    canonical specification; keep the order here byte-for-byte compatible
    with that specification so the exported NumPy bundle is safe to load.
    """

    names = [
        "present_count",
        "top1_count",
        "rank_score",
        "relative_sum",
        "relative_max",
        "raw_text_match",
        "baseline_position_matches",
        "baseline_edit_distance",
        "unique_character_count",
        "adjacent_repeat_count",
    ]
    for variant in LIGHT_VARIANTS:
        names.extend((
            f"{variant}_present",
            f"{variant}_rank_inverse",
            f"{variant}_relative_probability",
            f"{variant}_top1",
            f"{variant}_text_match",
            f"{variant}_log_relative",
        ))
    for position in range(4):
        names.extend(f"candidate_{position}_{character}" for character in ALPHABET)
    return names


def build_light_candidate_features(
    candidate: str,
    variant_candidates: dict[str, list[dict]],
    variant_texts: dict[str, str],
    baseline_answer: str,
) -> list[float]:
    """Build the exact 144-value feature vector used during light training."""

    present = 0
    top1 = 0
    rank_score = 0.0
    relative_sum = 0.0
    relative_max = 0.0
    variant_values: list[float] = []
    for variant in LIGHT_VARIANTS:
        items = list(variant_candidates.get(variant, []))
        match = next(
            (
                (index, item)
                for index, item in enumerate(items)
                if _normalize_alphanumeric(item.get("answer")) == candidate
            ),
            None,
        )
        text_match = int(_normalize_alphanumeric(variant_texts.get(variant)) == candidate)
        if match is None:
            variant_values.extend((0.0, 0.0, 0.0, 0.0, float(text_match), -80.0))
            continue
        rank, item = match
        relative = max(
            0.0,
            min(1.0, float(item.get("relative_probability") or 0.0)),
        )
        log_relative = max(-80.0, min(0.0, math.log(max(relative, 1e-12))))
        present += 1
        top1 += int(rank == 0)
        rank_score += 1.0 / (rank + 1)
        relative_sum += relative
        relative_max = max(relative_max, relative)
        variant_values.extend((
            1.0,
            1.0 / (rank + 1),
            relative,
            float(rank == 0),
            float(text_match),
            log_relative,
        ))

    baseline_position_matches = sum(
        left == right for left, right in zip(candidate, baseline_answer)
    )
    basics = [
        float(present),
        float(top1),
        rank_score,
        relative_sum,
        relative_max,
        float(candidate == _normalize_alphanumeric(variant_texts.get("raw"))),
        float(baseline_position_matches),
        float(_edit_distance(candidate, baseline_answer)),
        float(len(set(candidate))),
        float(sum(
            candidate[index] == candidate[index - 1]
            for index in range(1, len(candidate))
        )),
    ]
    one_hot: list[float] = []
    for character in candidate:
        one_hot.extend(float(character == allowed) for allowed in ALPHABET)
    result = basics + variant_values + one_hot
    if len(result) != len(light_feature_names()):
        raise FusionModelError(
            f"light reranker 特徵維度錯誤: {len(result)} != {len(light_feature_names())}"
        )
    return result


def build_candidate_features(
    candidate: str,
    variant_candidates: dict[str, list[dict]],
    variant_texts: dict[str, str],
    baseline_answer: str,
) -> list[float]:
    aggregate_score = 0.0
    top1_votes = 0
    present_count = 0
    official_text_matches = 0
    variant_features = []
    for variant in VARIANT_ORDER:
        candidates = variant_candidates.get(variant, [])
        match = next(
            ((rank, item) for rank, item in enumerate(candidates) if item["answer"] == candidate),
            None,
        )
        official_text_matches += int(variant_texts.get(variant) == candidate)
        if match is None:
            variant_features.extend((0.0, 0.0, 0.0, 0.0))
            continue
        rank, item = match
        relative = float(item["relative_probability"])
        present_count += 1
        top1_votes += int(rank == 0)
        weight = relative / (rank + 1)
        if variant == "dark_primary":
            weight *= 1.25
        aggregate_score += weight
        variant_features.extend((1.0, 1.0 / (rank + 1), relative, float(rank == 0)))

    basics = [
        aggregate_score,
        float(top1_votes),
        float(present_count),
        float(official_text_matches),
        float(candidate == baseline_answer),
        float(sum(left == right for left, right in zip(candidate, baseline_answer))),
        float(_edit_distance(candidate, baseline_answer)),
        float(len(set(candidate))),
        float(sum(candidate[index] == candidate[index - 1] for index in range(1, len(candidate)))),
    ]
    one_hot = []
    for character in candidate:
        one_hot.extend(float(character == allowed) for allowed in ALPHABET)
    return basics + variant_features + one_hot


def _softmax(values, axis: int = -1):
    import numpy as np

    shifted = values - np.max(values, axis=axis, keepdims=True)
    exponent = np.exp(shifted)
    return exponent / np.sum(exponent, axis=axis, keepdims=True)


def light_reranker_forward(features, parameters, *, eps: float = 1e-5):
    """Run the exported light reranker with NumPy.

    ``parameters`` must contain NPZ ``param_0`` through ``param_7`` in the
    same order as the PyTorch state dict.  Keeping this as a small standalone
    function makes the on-disk export independently testable without loading
    ONNX models or an OCR engine.
    """

    import numpy as np

    value = np.asarray(features, dtype=np.float32)
    if value.ndim == 1:
        value = value[None, :]
    if value.ndim != 2 or value.shape[-1] != 144:
        raise FusionModelError(
            f"light reranker 輸入維度錯誤: {tuple(value.shape)}"
        )
    if len(parameters) != 8:
        raise FusionModelError("light reranker 參數數量錯誤")
    weight0, bias0, norm_weight, norm_bias, weight1, bias1, weight2, bias2 = (
        np.asarray(item, dtype=np.float32) for item in parameters
    )
    value = value @ weight0.T + bias0
    mean = value.mean(axis=-1, keepdims=True)
    centered = value - mean
    variance = (centered * centered).mean(axis=-1, keepdims=True)
    value = centered / np.sqrt(variance + np.float32(eps))
    value = value * norm_weight + norm_bias
    value = np.maximum(value, 0.0)
    value = value @ weight1.T + bias1
    value = np.maximum(value, 0.0)
    return (value @ weight2.T + bias2).reshape(-1)


class Fixed4FusionOcr:
    REQUIRED_FILES = (
        "config.json",
        "reranker.npz",
        "direct.onnx",
        "crop.onnx",
        "light_reranker.npz",
    )

    def __init__(self, folder: Path):
        import numpy as np
        import onnxruntime as ort

        self.folder = Path(folder)
        missing = [name for name in self.REQUIRED_FILES if not (self.folder / name).is_file()]
        if missing:
            raise FusionModelError(f"融合模型不完整: {', '.join(missing)}")
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf-8"))
        if self.config.get("feature_names") != feature_names():
            raise FusionModelError("融合模型特徵版本不相容")
        self.charset = str(self.config["charset"])
        self.alpha = float(self.config["alpha"])
        self.beta = float(self.config["beta"])
        self.threshold = float(self.config["threshold"])
        try:
            with np.load(self.folder / "reranker.npz", allow_pickle=False) as bundle:
                self.mean = bundle["mean"].astype(np.float32)
                self.std = bundle["std"].astype(np.float32)
                self.weights = [
                    bundle[f"w{index}"].astype(np.float32) for index in range(3)
                ]
                self.biases = [
                    bundle[f"b{index}"].astype(np.float32) for index in range(3)
                ]
        except Exception as error:
            raise FusionModelError(f"融合 reranker 不完整: {error}") from error

        light_config = self.config.get("light_reranker")
        if not isinstance(light_config, dict):
            raise FusionModelError("融合模型不完整: 缺少 light_reranker 設定")
        expected_light_names = light_feature_names()
        if light_config.get("feature_version") != LIGHT_FEATURE_VERSION:
            raise FusionModelError("light reranker 特徵版本不相容")
        if light_config.get("feature_names") != expected_light_names:
            raise FusionModelError("light reranker 特徵名稱不相容")
        if light_config.get("feature_dim") != len(expected_light_names):
            raise FusionModelError("light reranker 特徵維度不相容")
        if light_config.get("variants") != list(LIGHT_VARIANTS):
            raise FusionModelError("light reranker preprocessing 不相容")
        try:
            beam_width = int(light_config.get("beam_width", -1))
            topn = int(light_config.get("topn", -1))
            self.light_threshold = float(light_config.get("threshold", -1.0))
            self.light_margin = float(light_config.get("margin", -1.0))
            self.light_eps = float(light_config.get("layer_norm_eps", 1e-5))
        except (TypeError, ValueError) as error:
            raise FusionModelError("light reranker 設定格式不相容") from error
        if beam_width != 160:
            raise FusionModelError("light reranker beam_width 不相容")
        if topn != 5:
            raise FusionModelError("light reranker topn 不相容")
        if self.light_threshold != 0.35 or self.light_margin != 0.02:
            raise FusionModelError("light reranker gate 不相容")
        if not math.isfinite(self.light_eps) or self.light_eps <= 0:
            raise FusionModelError("light reranker LayerNorm epsilon 不相容")
        source_sha = str(light_config.get("source_sha256") or "").lower()
        if len(source_sha) != 64 or any(
            character not in "0123456789abcdef" for character in source_sha
        ):
            raise FusionModelError("light reranker source SHA 不相容")
        light_path = self.folder / "light_reranker.npz"
        actual_source_sha = hashlib.sha256(light_path.read_bytes()).hexdigest()
        if actual_source_sha != source_sha:
            raise FusionModelError("light reranker source SHA 不相符")
        light_shapes = (
            (128, 144),
            (128,),
            (128,),
            (128,),
            (64, 128),
            (64,),
            (1, 64),
            (1,),
        )
        try:
            with np.load(light_path, allow_pickle=False) as light_bundle:
                expected_keys = [f"param_{index}" for index in range(8)]
                if set(light_bundle.files) != set(expected_keys):
                    raise FusionModelError("light reranker 參數鍵不相容")
                self.light_parameters = []
                for index, shape in enumerate(light_shapes):
                    value = light_bundle[f"param_{index}"].astype(np.float32)
                    if value.shape != shape:
                        raise FusionModelError(
                            f"light reranker 參數形狀不相容: param_{index} {value.shape}"
                        )
                    if not np.isfinite(value).all():
                        raise FusionModelError(
                            f"light reranker 參數非有限: param_{index}"
                        )
                    self.light_parameters.append(value)
        except FusionModelError:
            raise
        except Exception as error:
            raise FusionModelError(f"light reranker 不完整: {error}") from error
        providers = ["CPUExecutionProvider"]
        self.direct = ort.InferenceSession(str(self.folder / "direct.onnx"), providers=providers)
        self.crop = ort.InferenceSession(str(self.folder / "crop.onnx"), providers=providers)

    def _reranker(self, features):
        import numpy as np

        value = (features - self.mean) / self.std
        value = np.maximum(value @ self.weights[0].T + self.biases[0], 0.0)
        value = np.maximum(value @ self.weights[1].T + self.biases[1], 0.0)
        return (value @ self.weights[2].T + self.biases[2]).reshape(-1)

    def _light_reranker(self, features):
        return light_reranker_forward(
            features,
            self.light_parameters,
            eps=self.light_eps,
        )

    @staticmethod
    def _image_tensor(image, size: tuple[int, int], normalize: bool):
        import numpy as np
        from PIL import Image

        height, width = size
        resized = image.resize((width, height), Image.Resampling.BILINEAR)
        value = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1) / 255.0
        if normalize:
            mean = np.asarray((0.485, 0.456, 0.406), dtype=np.float32)[:, None, None]
            std = np.asarray((0.229, 0.224, 0.225), dtype=np.float32)[:, None, None]
            value = (value - mean) / std
        return value

    def _direct_probabilities(self, image):
        import numpy as np

        tensor = self._image_tensor(image, tuple(self.config["direct_image_size"]), True)[None, ...]
        logits = self.direct.run(None, {self.direct.get_inputs()[0].name: tensor})[0]
        return _softmax(np.asarray(logits, dtype=np.float32), axis=2)[0]

    def _crop_probabilities(self, image):
        import numpy as np

        width, height = image.size
        segment = width / 4.0
        margin = segment * float(self.config["crop_margin"])
        tensors = []
        for position in range(4):
            left = max(0, int(round(position * segment - margin)))
            right = min(width, int(round((position + 1) * segment + margin)))
            crop = image.crop((left, 0, right, height))
            tensors.append(self._image_tensor(crop, tuple(self.config["crop_image_size"]), False))
        inputs = np.stack(tensors).astype(np.float32)
        logits = self.crop.run(None, {self.crop.get_inputs()[0].name: inputs})[0]
        return _softmax(np.asarray(logits, dtype=np.float32), axis=1)

    @staticmethod
    def _is_light_branch(probability_variants) -> bool:
        names = {name for name, _ in probability_variants}
        return bool(names.intersection(LIGHT_VARIANTS)) and not bool(
            names.intersection(VARIANT_ORDER)
        )

    @staticmethod
    def _is_pure_english(answer: str) -> bool:
        return len(answer) == 4 and all(character in ALPHABET for character in answer)

    def _recognize_light(
        self,
        baseline: str,
        probability_variants: list[tuple[str, dict]],
    ) -> dict:
        import numpy as np

        baseline = _normalize_alphanumeric(baseline)
        variant_candidates: dict[str, list[dict]] = {}
        variant_texts: dict[str, str] = {}
        for variant_name, probability in probability_variants:
            if variant_name not in LIGHT_VARIANTS:
                continue
            candidates = ctc_prefix_beam(
                probability["probabilities"],
                probability["charset"],
                target_length=4,
                beam_width=int(self.config["light_reranker"]["beam_width"]),
                topn=int(self.config["light_reranker"]["topn"]),
            )
            variant_candidates[variant_name] = [
                item
                for item in candidates
                if self._is_pure_english(_normalize_alphanumeric(item.get("answer")))
            ]
            variant_texts[variant_name] = _normalize_alphanumeric(probability.get("text"))

        pool = {
            _normalize_alphanumeric(item.get("answer"))
            for items in variant_candidates.values()
            for item in items
            if self._is_pure_english(_normalize_alphanumeric(item.get("answer")))
        }
        raw_text = variant_texts.get("raw", "")
        if self._is_pure_english(raw_text):
            pool.add(raw_text)
        candidates = sorted(pool)
        if not candidates:
            return {
                "answer": baseline,
                "fused_top_probability": 0.0,
                "fusion_candidate_count": 0,
                "fusion_model": LIGHT_FEATURE_VERSION,
                "selection_strategy": LIGHT_FEATURE_VERSION,
                "overridden": False,
            }

        features = np.asarray([
            build_light_candidate_features(
                candidate,
                variant_candidates,
                variant_texts,
                raw_text,
            )
            for candidate in candidates
        ], dtype=np.float32)
        logits = self._light_reranker(features)
        fused = _softmax(logits)
        order = np.argsort(-logits, kind="stable")
        top_index = int(order[0])
        second_probability = float(fused[int(order[1])]) if len(order) > 1 else 0.0
        top_probability = float(fused[top_index])
        top_margin = top_probability - second_probability
        proposed = candidates[top_index]
        baseline_safe = (
            self._is_pure_english(baseline)
            or baseline == ""
            or len(baseline) != 4
        )
        overridden = bool(
            baseline_safe
            and self._is_pure_english(proposed)
            and proposed != baseline
            and top_probability >= self.light_threshold
            and top_margin >= self.light_margin
        )
        return {
            "answer": proposed if overridden else baseline,
            "fused_top_probability": top_probability,
            "fusion_candidate_count": len(candidates),
            "fusion_model": LIGHT_FEATURE_VERSION,
            "selection_strategy": LIGHT_FEATURE_VERSION,
            "overridden": overridden,
            "fusion_candidate_top": proposed,
            "fusion_candidate_margin": top_margin,
        }

    def recognize(
        self,
        image_bytes: bytes,
        baseline: str,
        probability_variants: Iterable[tuple[str, dict]],
    ) -> dict | None:
        import numpy as np
        from PIL import Image

        probability_variants = list(probability_variants)
        if self._is_light_branch(probability_variants):
            return self._recognize_light(baseline, probability_variants)

        variant_candidates: dict[str, list[dict]] = {}
        variant_texts: dict[str, str] = {}
        for variant_name, probability in probability_variants:
            if variant_name not in VARIANT_ORDER:
                continue
            variant_candidates[variant_name] = ctc_prefix_beam(
                probability["probabilities"], probability["charset"], target_length=4,
                beam_width=80, topn=5,
            )
            variant_texts[variant_name] = str(probability.get("text") or "").upper()
        pool = {item["answer"] for items in variant_candidates.values() for item in items}
        if len(baseline) == 4 and baseline.isalpha() and baseline.isupper():
            pool.add(baseline)
        candidates = sorted(
            candidate for candidate in pool
            if len(candidate) == 4 and candidate.isalpha() and candidate.isupper()
        )
        if not candidates:
            return None
        features = np.asarray([
            build_candidate_features(candidate, variant_candidates, variant_texts, baseline)
            for candidate in candidates
        ], dtype=np.float32)
        v4_probability = _softmax(self._reranker(features))
        with Image.open(BytesIO(image_bytes)) as source:
            image = source.convert("RGB")
            direct_probability = self._direct_probabilities(image)
            crop_probability = self._crop_probabilities(image)
        direct_scores = []
        crop_scores = []
        for candidate in candidates:
            direct_scores.append(sum(
                math.log(max(float(direct_probability[position, self.charset.index(character)]), 1e-12))
                for position, character in enumerate(candidate)
            ) / 4.0)
            crop_scores.append(sum(
                math.log(max(float(crop_probability[position, self.charset.index(character)]), 1e-12))
                for position, character in enumerate(candidate)
            ) / 4.0)
        logits = (
            np.log(np.maximum(v4_probability, 1e-12))
            + self.alpha * np.asarray(direct_scores)
            + self.beta * np.asarray(crop_scores)
        )
        fused = _softmax(logits)
        top_index = int(np.argmax(fused))
        answer = candidates[top_index] if float(fused[top_index]) >= self.threshold else baseline
        return {
            "answer": answer,
            "fused_top_probability": float(fused[top_index]),
            "fusion_candidate_count": len(candidates),
            "fusion_model": "v4+v6+v7",
        }
