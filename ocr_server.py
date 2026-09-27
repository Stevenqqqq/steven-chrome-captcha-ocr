from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter, OrderedDict, defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qs, urlsplit


def resolve_runtime_roots(
    *,
    module_file: str | Path = __file__,
    executable: str | Path | None = None,
    frozen: bool | None = None,
) -> tuple[Path, Path]:
    """Return (bundled resources root, user-visible application root)."""
    bundle_root = Path(module_file).resolve().parent
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if not is_frozen:
        return bundle_root, bundle_root
    executable_path = Path(executable or sys.executable).resolve()
    return bundle_root, executable_path.parent


BUNDLE_ROOT, APP_ROOT = resolve_runtime_roots()
ROOT = APP_ROOT
MODEL_ROOT = BUNDLE_ROOT / "models"
TRAINING_ROOT = APP_ROOT / "training"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_FEEDBACK_BYTES = 8 * 1024
API_VERSION = 6
ACTIVE_LEARNING_SOURCES = {"toolweb_practice"}
VERIFIED_DATA_METHODS = {"manual_confirmed", "site_accepted"}


class OcrError(RuntimeError):
    pass


def normalize_answer(value: object) -> str:
    text = re.sub(r"\s+", "", str(value or ""))
    return re.sub(r"[^0-9A-Za-z]", "", text).upper()


def answer_is_plausible(answer: str) -> bool:
    return 3 <= len(answer) <= 6


def parse_expected_length(value: object) -> int | None:
    if value is None or value == "":
        return None
    text = str(value)
    if not re.fullmatch(r"[3-6]", text):
        raise OcrError("expectedLength must be an integer from 3 to 6")
    return int(text)


def parse_correct_answer(value: object) -> str:
    text = str(value or "").strip().upper()
    if not re.fullmatch(r"[0-9A-Z]{3,6}", text):
        raise OcrError("正確答案必須是 3 至 6 位英文字母或數字")
    return text


def parse_active_learning_source(value: object) -> str:
    source = str(value or "").strip().lower()
    if source not in ACTIVE_LEARNING_SOURCES:
        raise OcrError("主動學習資料來源不允許")
    return source


def parse_site_acceptance_evidence(value: object) -> dict:
    if not isinstance(value, dict) or value.get("captchaChanged") is not True:
        raise OcrError("缺少驗證碼圖片已更換的網站證據")
    attempts_before = value.get("attemptsBefore")
    attempts_after = value.get("attemptsAfter")
    if (
        isinstance(attempts_before, bool)
        or isinstance(attempts_after, bool)
        or not isinstance(attempts_before, int)
        or not isinstance(attempts_after, int)
        or not 0 <= attempts_before <= 1_000_000
        or attempts_after != attempts_before + 1
    ):
        raise OcrError("網站嘗試次數證據無效")
    return {
        "captcha_changed": True,
        "attempts_before": attempts_before,
        "attempts_after": attempts_after,
    }


def origin_is_allowed(origin: str) -> bool:
    return not origin or origin.startswith("chrome-extension://")


def choose_ensemble(predictions: Iterable[dict], expected_length: int | None = None) -> dict:
    usable = [
        item
        for item in predictions
        if answer_is_plausible(normalize_answer(item.get("answer")))
    ]
    if not usable:
        raise OcrError("三組 OCR 都沒有產生可信的 3 至 6 位英數答案")

    length_match = None
    if expected_length is not None:
        length_matches = [
            item
            for item in usable
            if len(normalize_answer(item.get("answer"))) == expected_length
        ]
        length_match = bool(length_matches)
        if length_matches:
            usable = length_matches

    solver_support = defaultdict(set)
    total_support = Counter()
    preferred_support = Counter()
    raw_support = Counter()
    first_seen = {}

    for index, item in enumerate(usable):
        answer = normalize_answer(item.get("answer"))
        solver = str(item.get("solver") or "unknown")
        variant = str(item.get("variant") or "")
        solver_support[answer].add(solver)
        total_support[answer] += 1
        if item.get("preferred"):
            preferred_support[answer] += 1
        if variant == "raw":
            raw_support[answer] += 1
        first_seen.setdefault(answer, index)

    ranked = sorted(
        total_support,
        key=lambda answer: (
            -len(solver_support[answer]),
            -preferred_support[answer],
            -total_support[answer],
            -raw_support[answer],
            first_seen[answer],
        ),
    )
    answer = ranked[0]
    selection_strategy = "solver_then_preferred_then_total"
    if len(ranked) > 1:
        total_leader = sorted(
            ranked,
            key=lambda item: (
                -total_support[item],
                -len(solver_support[item]),
                -preferred_support[item],
                -raw_support[item],
                first_seen[item],
            ),
        )[0]
        # A preferred preprocessing variant normally wins ties, but one noisy
        # preferred prediction must not overrule a strong consensus from the
        # same solver's independent preprocessing variants.
        if total_support[total_leader] >= 4 and total_support[total_leader] - total_support[answer] >= 4:
            answer = total_leader
            ranked = [answer, *[item for item in ranked if item != answer]]
            selection_strategy = "strong_variant_consensus_override"
    candidates = [
        {
            "answer": item,
            "solver_votes": len(solver_support[item]),
            "total_votes": total_support[item],
            "preferred_votes": preferred_support[item],
            "raw_votes": raw_support[item],
        }
        for item in ranked[:5]
    ]
    return {
        "answer": answer,
        "solver_votes": len(solver_support[answer]),
        "total_votes": total_support[answer],
        "candidates": candidates,
        "expected_length": expected_length,
        "length_match": length_match,
        "selection_strategy": selection_strategy,
    }


def assess_active_learning_priority(result: dict) -> dict:
    """Score how informative a site-accepted label would be for later training."""

    candidates = list(result.get("candidates") or [])
    predictions = list(result.get("predictions") or [])
    score = 0
    reasons = []

    if result.get("length_match") is False:
        score += 60
        reasons.append("expected_length_mismatch")
    if result.get("selection_strategy") == "strong_variant_consensus_override":
        score += 50
        reasons.append("strong_consensus_overrode_preferred")

    distinct_answers = {
        normalize_answer(item.get("answer"))
        for item in predictions
        if answer_is_plausible(normalize_answer(item.get("answer")))
    }
    if len(distinct_answers) > 1:
        score += 15
        reasons.append("variant_disagreement")

    candidate_margin = None
    if len(candidates) > 1:
        top_votes = int(candidates[0].get("total_votes") or 0)
        runner_up_votes = int(candidates[1].get("total_votes") or 0)
        candidate_margin = top_votes - runner_up_votes
        if candidate_margin <= 1:
            score += 30
            reasons.append("narrow_vote_margin")
        elif candidate_margin <= 2:
            score += 20
            reasons.append("small_vote_margin")

    preferred_by_solver = {
        str(item.get("solver") or "unknown"): normalize_answer(item.get("answer"))
        for item in predictions
        if item.get("preferred") and answer_is_plausible(normalize_answer(item.get("answer")))
    }
    if len(set(preferred_by_solver.values())) > 1:
        score += 35
        reasons.append("solver_preferred_disagreement")

    if int(result.get("solver_votes") or 0) <= 1:
        score += 10
        reasons.append("single_solver_support")

    score = min(100, score)
    if score >= 50:
        priority = "high"
    elif score >= 25:
        priority = "medium"
    else:
        priority = "low"
    sample_rate = {"high": 1.0, "medium": 0.35, "low": 0.10}[priority]
    return {
        "priority": priority,
        "score": score,
        "reasons": reasons,
        "distinct_answers": len(distinct_answers),
        "candidate_margin": candidate_margin,
        "save_if_site_accepted": priority == "high",
        "recommended_sample_rate": sample_rate,
        "sampling_note": "Always save a site-accepted model mismatch; apply this rate only when the independent answer matches the model answer.",
    }


def apply_active_learning_sampling(priority: dict, image_bytes: bytes) -> dict:
    """Make fractional sampling reproducible for the same exact image."""

    sampled = dict(priority)
    digest_prefix = hashlib.sha256(image_bytes).hexdigest()[:8]
    bucket = int(digest_prefix, 16) / 0xFFFFFFFF
    sample_rate = float(sampled.get("recommended_sample_rate") or 0.0)
    sampled["sampling_bucket"] = round(bucket, 8)
    sampled["sample_recommended"] = bucket < sample_rate
    return sampled


def analyze_recognition_error(predicted_answer: object, correct_answer: object) -> dict:
    predicted = normalize_answer(predicted_answer)
    correct = normalize_answer(correct_answer)
    length_delta = len(correct) - len(predicted)
    analysis = {
        "type": "unknown",
        "length_delta": length_delta,
        "mismatch_positions": [],
    }

    if length_delta == 1:
        for index in range(len(correct)):
            if correct[:index] + correct[index + 1:] == predicted:
                missing = correct[index]
                repeated = (
                    (index > 0 and correct[index - 1] == missing)
                    or (index + 1 < len(correct) and correct[index + 1] == missing)
                )
                analysis.update({
                    "type": "repeated_character_missing" if repeated else "missing_character",
                    "character": missing,
                    "position": index,
                })
                return analysis
        analysis["type"] = "missing_character"
        return analysis

    if length_delta > 1:
        analysis["type"] = "missing_characters"
        return analysis

    if length_delta == -1:
        for index in range(len(predicted)):
            if predicted[:index] + predicted[index + 1:] == correct:
                extra = predicted[index]
                repeated = (
                    (index > 0 and predicted[index - 1] == extra)
                    or (index + 1 < len(predicted) and predicted[index + 1] == extra)
                )
                analysis.update({
                    "type": "repeated_character_extra" if repeated else "extra_character",
                    "character": extra,
                    "position": index,
                })
                return analysis
        analysis["type"] = "extra_character"
        return analysis

    if length_delta < -1:
        analysis["type"] = "extra_characters"
        return analysis

    mismatches = [
        index
        for index, (predicted_character, correct_character) in enumerate(zip(predicted, correct))
        if predicted_character != correct_character
    ]
    analysis["mismatch_positions"] = mismatches
    if len(mismatches) == 1:
        analysis["type"] = "substitution"
    elif len(mismatches) == 2:
        first, second = mismatches
        if (
            second == first + 1
            and predicted[first] == correct[second]
            and predicted[second] == correct[first]
        ):
            analysis["type"] = "transposition"
        else:
            analysis["type"] = "multiple_substitutions"
    elif mismatches:
        analysis["type"] = "multiple_substitutions"
    else:
        analysis["type"] = "same_answer"
    return analysis


def _png_bytes(image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _rgb_png_bytes(image) -> bytes:
    """Encode a variant with three color channels for RGB custom models."""

    return _png_bytes(image.convert("RGB"))


def _edge_median_luminance(gray_image) -> int:
    """Estimate the background from the image edge without using labels."""

    width, height = gray_image.size
    edge_pixels = []
    for x in range(width):
        edge_pixels.append(gray_image.getpixel((x, 0)))
        edge_pixels.append(gray_image.getpixel((x, height - 1)))
    for y in range(1, height - 1):
        edge_pixels.append(gray_image.getpixel((0, y)))
        edge_pixels.append(gray_image.getpixel((width - 1, y)))
    edge_pixels.sort()
    return edge_pixels[len(edge_pixels) // 2]


def normalize_image_to_png(image_bytes: bytes) -> bytes:
    try:
        from PIL import Image

        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        if image.width < 10 or image.height < 10:
            raise OcrError("圖片尺寸太小，無法保存")
        if image.width * image.height > 2_000_000:
            raise OcrError("圖片尺寸過大")
        return _png_bytes(image)
    except OcrError:
        raise
    except Exception as error:
        raise OcrError("無法保存驗證碼圖片") from error


class FeedbackStore:
    def __init__(self, root: Path = TRAINING_ROOT, max_pending: int = 100, ttl_seconds: int = 3600):
        self.root = Path(root)
        self.max_pending = max_pending
        self.ttl_seconds = ttl_seconds
        self.pending = OrderedDict()
        self.lock = threading.Lock()

    @staticmethod
    def _safe_result(result: dict) -> dict:
        candidates = []
        for item in list(result.get("candidates") or [])[:5]:
            answer = normalize_answer(item.get("answer"))
            if not answer_is_plausible(answer):
                continue
            candidates.append({
                "answer": answer,
                "solver_votes": int(item.get("solver_votes") or 0),
                "total_votes": int(item.get("total_votes") or 0),
            })

        predictions = []
        for item in list(result.get("predictions") or [])[:50]:
            answer = normalize_answer(item.get("answer"))
            if not answer_is_plausible(answer):
                continue
            predictions.append({
                "solver": str(item.get("solver") or "unknown")[:40],
                "variant": str(item.get("variant") or "")[:40],
                "answer": answer,
                "preferred": bool(item.get("preferred")),
            })

        return {
            "answer": normalize_answer(result.get("answer")),
            "candidates": candidates,
            "predictions": predictions,
            "active_learning": dict(result.get("active_learning") or {}),
        }

    def _purge_expired(self, now: float):
        expired = [
            report_id
            for report_id, item in self.pending.items()
            if now - item["remembered_at"] > self.ttl_seconds
        ]
        for report_id in expired:
            self.pending.pop(report_id, None)

    def remember(self, image_bytes: bytes, expected_length: int | None, result: dict) -> str:
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise OcrError("圖片大小必須介於 1 byte 至 5 MB")
        png_bytes = normalize_image_to_png(image_bytes)
        report_id = secrets.token_hex(16)
        now = time.monotonic()
        item = {
            "image": png_bytes,
            "expected_length": expected_length,
            "result": self._safe_result(result),
            "remembered_at": now,
        }
        with self.lock:
            self._purge_expired(now)
            self.pending[report_id] = item
            while len(self.pending) > self.max_pending:
                self.pending.popitem(last=False)
        return report_id

    def _find_existing_image(self, image_sha256: str) -> tuple[Path, dict] | None:
        feedback_dir = self.root / "feedback"
        samples_dir = self.root / "samples"
        if not feedback_dir.is_dir():
            return None

        for metadata_path in sorted(feedback_dir.glob("*.json")):
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                stored_hash = str(metadata.get("image_sha256") or "")
                if not re.fullmatch(r"[0-9a-f]{64}", stored_hash):
                    image_file = str(metadata.get("image_file") or "")
                    image_path = (samples_dir / image_file).resolve()
                    image_path.relative_to(samples_dir.resolve())
                    if not image_path.is_file():
                        continue
                    stored_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
                if secrets.compare_digest(stored_hash, image_sha256):
                    return metadata_path, metadata
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
        return None

    @staticmethod
    def _write_metadata_atomic(metadata_path: Path, metadata: dict):
        metadata_tmp = metadata_path.with_name(f".{metadata_path.name}.tmp")
        try:
            metadata_tmp.write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(metadata_tmp, metadata_path)
        except Exception:
            metadata_tmp.unlink(missing_ok=True)
            raise

    def confirm(
        self,
        report_id: object,
        correct_answer: object,
        *,
        source: str = "manual_feedback",
        verification: str = "manual_confirmed",
        allow_correct_prediction: bool = False,
        verification_evidence: dict | None = None,
    ) -> dict:
        report_id_text = str(report_id or "")
        if not re.fullmatch(r"[0-9a-f]{32}", report_id_text):
            raise OcrError("回報代碼無效或已失效")
        correct = parse_correct_answer(correct_answer)

        with self.lock:
            now = time.monotonic()
            self._purge_expired(now)
            item = self.pending.get(report_id_text)
            if item is None:
                raise OcrError("回報代碼無效或已失效，請重新辨識")
            predicted = item["result"]["answer"]
            if correct == predicted and not allow_correct_prediction:
                raise OcrError("正確答案必須與 OCR 答案不同")

            image_sha256 = hashlib.sha256(item["image"]).hexdigest()
            error_analysis = (
                {"type": "correct", "length_delta": 0, "mismatch_positions": []}
                if predicted == correct
                else analyze_recognition_error(predicted, correct)
            )
            duplicate = self._find_existing_image(image_sha256)
            if duplicate is not None:
                metadata_path, metadata = duplicate
                existing_correct = parse_correct_answer(metadata.get("correct_answer"))
                if existing_correct != correct:
                    raise OcrError("同一張圖片已保存不同正解，請先人工確認")
                metadata["schema_version"] = 3
                metadata["image_sha256"] = image_sha256
                metadata["error_analysis"] = metadata.get("error_analysis") or error_analysis
                metadata["occurrences"] = max(1, int(metadata.get("occurrences") or 1)) + 1
                metadata["last_reported_at"] = datetime.now(timezone.utc).isoformat()
                if verification_evidence is not None:
                    metadata["last_verification_evidence"] = verification_evidence
                observed_predictions = dict(metadata.get("observed_predictions") or {})
                observed_predictions[predicted] = int(observed_predictions.get(predicted) or 0) + 1
                metadata["observed_predictions"] = observed_predictions
                metadata["sources"] = sorted(set(metadata.get("sources") or [metadata.get("source") or "manual_feedback"]) | {source})
                metadata["verifications"] = sorted(set(metadata.get("verifications") or [metadata.get("verification") or "manual_confirmed"]) | {verification})
                try:
                    self._write_metadata_atomic(metadata_path, metadata)
                except Exception as error:
                    raise OcrError("無法更新重複錯題資料") from error
                self.pending.pop(report_id_text, None)
                return {
                    "image_file": str(metadata.get("image_file") or ""),
                    "metadata_file": metadata_path.name,
                    "duplicate": True,
                    "occurrences": metadata["occurrences"],
                    "error_type": metadata["error_analysis"]["type"],
                }

            timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            stem = f"{correct}__{timestamp}_{report_id_text[:12]}"
            samples_dir = self.root / "samples"
            feedback_dir = self.root / "feedback"
            image_path = samples_dir / f"{stem}.png"
            metadata_path = feedback_dir / f"{stem}.json"
            image_tmp = samples_dir / f".{stem}.png.tmp"
            metadata_tmp = feedback_dir / f".{stem}.json.tmp"

            metadata = {
                "schema_version": 3,
                "reported_at": datetime.now(timezone.utc).isoformat(),
                "record_kind": "verified_correct" if predicted == correct else "verified_error",
                "source": source,
                "sources": [source],
                "verification": verification,
                "verifications": [verification],
                "verification_evidence": verification_evidence,
                "correct_answer": correct,
                "predicted_answer": predicted,
                "observed_predictions": {predicted: 1},
                "expected_length": item["expected_length"],
                "image_sha256": image_sha256,
                "occurrences": 1,
                "error_analysis": error_analysis,
                "candidates": item["result"]["candidates"],
                "predictions": item["result"]["predictions"],
                "active_learning": item["result"].get("active_learning") or {},
                "image_file": image_path.name,
            }

            samples_dir.mkdir(parents=True, exist_ok=True)
            feedback_dir.mkdir(parents=True, exist_ok=True)
            try:
                image_tmp.write_bytes(item["image"])
                metadata_tmp.write_text(
                    json.dumps(metadata, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                os.replace(image_tmp, image_path)
                os.replace(metadata_tmp, metadata_path)
            except Exception as error:
                image_tmp.unlink(missing_ok=True)
                metadata_tmp.unlink(missing_ok=True)
                image_path.unlink(missing_ok=True)
                raise OcrError("無法保存錯題資料") from error

            self.pending.pop(report_id_text, None)

        return {
            "image_file": image_path.name,
            "metadata_file": metadata_path.name,
            "duplicate": False,
            "occurrences": 1,
            "error_type": error_analysis["type"],
        }


def build_feedback_report(root: Path = TRAINING_ROOT) -> dict:
    root = Path(root)
    feedback_dir = root / "feedback"
    samples_dir = root / "samples"
    groups = {}
    invalid_records = []
    record_count = 0

    for metadata_path in sorted(feedback_dir.glob("*.json")) if feedback_dir.is_dir() else []:
        record_count += 1
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            correct = parse_correct_answer(metadata.get("correct_answer"))
            predicted = normalize_answer(metadata.get("predicted_answer"))
            if not answer_is_plausible(predicted):
                raise ValueError("invalid predicted answer")
            image_file = str(metadata.get("image_file") or "")
            image_path = (samples_dir / image_file).resolve()
            image_path.relative_to(samples_dir.resolve())
            if not image_path.is_file():
                raise ValueError("image missing")
            image_sha256 = str(metadata.get("image_sha256") or "")
            if not re.fullmatch(r"[0-9a-f]{64}", image_sha256):
                image_sha256 = hashlib.sha256(image_path.read_bytes()).hexdigest()
            occurrences = max(1, int(metadata.get("occurrences") or 1))
            analysis = metadata.get("error_analysis")
            if not isinstance(analysis, dict) or not analysis.get("type"):
                analysis = (
                    {"type": "correct", "length_delta": 0, "mismatch_positions": []}
                    if predicted == correct
                    else analyze_recognition_error(predicted, correct)
                )
            sources = metadata.get("sources") or [metadata.get("source") or "manual_feedback"]
            verifications = metadata.get("verifications") or [metadata.get("verification") or "manual_confirmed"]

            group = groups.setdefault(image_sha256, {
                "image_sha256": image_sha256,
                "correct_answers": set(),
                "predicted_answers": set(),
                "error_types": Counter(),
                "record_count": 0,
                "occurrences": 0,
                "sources": set(),
                "verifications": set(),
            })
            group["correct_answers"].add(correct)
            group["predicted_answers"].add(predicted)
            group["error_types"][str(analysis["type"])] += occurrences
            group["record_count"] += 1
            group["occurrences"] += occurrences
            group["sources"].update(str(source) for source in sources)
            group["verifications"].update(str(value) for value in verifications)
        except (OSError, ValueError, TypeError, json.JSONDecodeError, OcrError) as error:
            invalid_records.append({"file": metadata_path.name, "error": str(error)[:160]})

    unique_error_types = Counter()
    occurrence_error_types = Counter()
    label_conflicts = []
    total_occurrences = 0
    source_counts = Counter()
    verification_counts = Counter()
    for group in groups.values():
        total_occurrences += group["occurrences"]
        occurrence_error_types.update(group["error_types"])
        dominant_error = group["error_types"].most_common(1)[0][0]
        unique_error_types[dominant_error] += 1
        for source in group["sources"]:
            source_counts[source] += 1
        for verification in group["verifications"]:
            verification_counts[verification] += 1
        if len(group["correct_answers"]) > 1:
            label_conflicts.append({
                "image_sha256": group["image_sha256"],
                "correct_answers": sorted(group["correct_answers"]),
            })

    valid_records = sum(group["record_count"] for group in groups.values())
    return {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "records": record_count,
        "valid_records": valid_records,
        "invalid_records": invalid_records,
        "unique_images": len(groups),
        "duplicate_records": max(0, valid_records - len(groups)),
        "total_occurrences": total_occurrences,
        "unique_image_error_types": dict(unique_error_types.most_common()),
        "occurrence_error_types": dict(occurrence_error_types.most_common()),
        "unique_images_by_source": dict(source_counts.most_common()),
        "unique_images_by_verification": dict(verification_counts.most_common()),
        "label_conflicts": label_conflicts,
    }


def _desired_split_counts(count: int) -> dict[str, int]:
    if count >= 10:
        validation_count = max(1, round(count * 0.10))
        test_count = max(1, round(count * 0.10))
    else:
        validation_count = 1 if count >= 2 else 0
        test_count = 1 if count >= 3 else 0
    return {
        "train": count - validation_count - test_count,
        "validation": validation_count,
        "test": test_count,
    }


def _label_grouped_assignments(eligible: list[dict], seed: int) -> dict[str, str]:
    """Assign every exact label to one split while staying near 80/10/10."""

    by_label = defaultdict(list)
    for group in eligible:
        by_label[next(iter(group["labels"]))].append(group)

    desired = _desired_split_counts(len(eligible))
    current = Counter()
    assignments = {}
    split_order = {"train": 0, "validation": 1, "test": 2}
    label_groups = sorted(
        by_label.items(),
        key=lambda item: (
            -len(item[1]),
            hashlib.sha256(f"{seed}:{item[0]}".encode("ascii")).hexdigest(),
        ),
    )
    for label, groups in label_groups:
        available = [name for name, target in desired.items() if target > 0]
        split = min(
            available,
            key=lambda name: (
                current[name] / desired[name],
                split_order[name],
            ),
        )
        assignments[label] = split
        current[split] += len(groups)
    return assignments


def build_dataset_manifest(
    root: Path = TRAINING_ROOT,
    seed: int = 20260809,
    split_strategy: str = "image_hash",
) -> dict:
    if split_strategy not in {"image_hash", "label_grouped"}:
        raise OcrError("split_strategy must be image_hash or label_grouped")
    root = Path(root)
    feedback_dir = root / "feedback"
    samples_dir = root / "samples"
    groups = {}
    invalid_records = []

    for metadata_path in sorted(feedback_dir.glob("*.json")) if feedback_dir.is_dir() else []:
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            correct = parse_correct_answer(metadata.get("correct_answer"))
            image_file = str(metadata.get("image_file") or "")
            image_path = (samples_dir / image_file).resolve()
            image_path.relative_to(samples_dir.resolve())
            if not image_path.is_file():
                raise ValueError("image missing")
            image_sha256 = str(metadata.get("image_sha256") or "")
            if not re.fullmatch(r"[0-9a-f]{64}", image_sha256):
                image_sha256 = hashlib.sha256(image_path.read_bytes()).hexdigest()
            sources = {
                str(value)
                for value in (metadata.get("sources") or [metadata.get("source") or "manual_feedback"])
            }
            verifications = {
                str(value)
                for value in (
                    metadata.get("verifications")
                    or [metadata.get("verification") or "manual_confirmed"]
                )
            }
            if not verifications or not verifications.issubset(VERIFIED_DATA_METHODS):
                raise ValueError("unverified label")
            occurrences = max(1, int(metadata.get("occurrences") or 1))

            group = groups.setdefault(image_sha256, {
                "image_sha256": image_sha256,
                "labels": set(),
                "image_files": set(),
                "sources": set(),
                "verifications": set(),
                "occurrences": 0,
            })
            group["labels"].add(correct)
            group["image_files"].add(image_file)
            group["sources"].update(sources)
            group["verifications"].update(verifications)
            group["occurrences"] += occurrences
        except (OSError, ValueError, TypeError, json.JSONDecodeError, OcrError) as error:
            invalid_records.append({"file": metadata_path.name, "error": str(error)[:160]})

    conflicts = []
    eligible = []
    for group in groups.values():
        if len(group["labels"]) != 1:
            conflicts.append({
                "image_sha256": group["image_sha256"],
                "labels": sorted(group["labels"]),
            })
            continue
        eligible.append(group)

    eligible.sort(
        key=lambda group: hashlib.sha256(
            f"{seed}:{group['image_sha256']}".encode("ascii")
        ).hexdigest()
    )
    count = len(eligible)
    desired = _desired_split_counts(count)
    label_assignments = (
        _label_grouped_assignments(eligible, seed)
        if split_strategy == "label_grouped"
        else None
    )

    entries = []
    split_counts = Counter()
    for index, group in enumerate(eligible):
        if label_assignments is not None:
            split = label_assignments[next(iter(group["labels"]))]
        elif index < desired["train"]:
            split = "train"
        elif index < desired["train"] + desired["validation"]:
            split = "validation"
        else:
            split = "test"
        split_counts[split] += 1
        entries.append({
            "image_file": sorted(group["image_files"])[0],
            "image_sha256": group["image_sha256"],
            "label": next(iter(group["labels"])),
            "sources": sorted(group["sources"]),
            "verifications": sorted(group["verifications"]),
            "occurrences": group["occurrences"],
            "split": split,
        })

    return {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "split_strategy": split_strategy,
        "unique_verified_images": count,
        "split_counts": dict(split_counts),
        "invalid_records": invalid_records,
        "label_conflicts": conflicts,
        "ready_for_trial_training": count >= 200,
        "ready_for_model_replacement": count >= 2000,
        "entries": entries,
    }


def image_variants(image_bytes: bytes):
    try:
        from PIL import Image, ImageEnhance, ImageFilter, ImageOps

        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        if image.width < 10 or image.height < 10:
            raise OcrError("圖片尺寸太小，無法辨識")
        if image.width * image.height > 2_000_000:
            raise OcrError("圖片尺寸過大")

        gray = ImageOps.grayscale(image)
        midpoint = (gray.width * gray.height + 1) // 2
        running_pixels = 0
        median_luminance = 255
        for luminance, count in enumerate(gray.histogram()):
            running_pixels += count
            if running_pixels >= midpoint:
                median_luminance = luminance
                break

        if median_luminance < 170:
            normalized = ImageOps.invert(gray)
            contrast = ImageEnhance.Contrast(normalized).enhance(2.0)
            autocontrast = ImageOps.autocontrast(normalized)
            primary = autocontrast.filter(ImageFilter.MaxFilter(3))
            threshold = normalized.point(lambda value: 255 if value > 100 else 0)
            gray_pad2 = ImageOps.expand(
                gray,
                border=2,
                fill=_edge_median_luminance(gray),
            )

            yield "dark_primary", _rgb_png_bytes(primary)
            yield "dark_normalized", _rgb_png_bytes(normalized)
            yield "dark_contrast", _rgb_png_bytes(contrast)
            yield "dark_autocontrast", _rgb_png_bytes(autocontrast)
            yield "dark_threshold", _rgb_png_bytes(threshold)
            if max(image.width, image.height) <= 800:
                enlarged = normalized.resize(
                    (image.width * 2, image.height * 2),
                    Image.Resampling.LANCZOS,
                )
                yield "dark_resize2", _rgb_png_bytes(enlarged)
            yield "gray_pad2", _rgb_png_bytes(gray_pad2)
            yield "dark_raw", _png_bytes(image)
        else:
            contrast = ImageEnhance.Contrast(gray).enhance(3.0)
            threshold = gray.point(lambda value: 255 if value > 150 else 0)

            yield "raw", _png_bytes(image)
            yield "gray", _rgb_png_bytes(gray)
            yield "contrast", _rgb_png_bytes(contrast)
            yield "threshold", _rgb_png_bytes(threshold)
            if max(image.width, image.height) <= 800:
                enlarged = image.resize((image.width * 2, image.height * 2))
                yield "resize2", _png_bytes(enlarged)
    except OcrError:
        raise
    except Exception as error:
        raise OcrError(f"無法讀取驗證碼圖片: {error}") from error


class OcrEngine:
    def __init__(self, model_root: Path = MODEL_ROOT):
        self.model_root = Path(model_root)
        self.solvers = []
        self.fusion = None
        self.lock = threading.Lock()

    def load(self):
        if self.solvers:
            return self
        try:
            import ddddocr
        except ModuleNotFoundError as error:
            raise OcrError("缺少 ddddocr，請先執行安裝依賴.bat") from error

        solvers = [("official", ddddocr.DdddOcr(show_ad=False))]
        for name in ("universal", "tixcraft_tm"):
            folder = self.model_root / name
            onnx_path = folder / "custom.onnx"
            charsets_path = folder / "charsets.json"
            if not onnx_path.exists() and not charsets_path.exists():
                continue
            if not onnx_path.exists() or not charsets_path.exists():
                raise OcrError(f"OCR 模型不完整: {folder}")
            solvers.append(
                (
                    name,
                    ddddocr.DdddOcr(
                        show_ad=False,
                        import_onnx_path=str(onnx_path),
                        charsets_path=str(charsets_path),
                    ),
                )
            )
        self.solvers = solvers
        fusion_folder = self.model_root / "fusion_v7"
        if fusion_folder.exists():
            try:
                from fusion_ocr import Fixed4FusionOcr

                self.fusion = Fixed4FusionOcr(fusion_folder)
            except Exception as error:
                raise OcrError(f"融合 OCR 模型載入失敗: {error}") from error
        return self

    @property
    def names(self):
        return [name for name, _ in self.solvers]

    @property
    def loaded_model_names(self):
        names = self.names
        if self.fusion is not None:
            names.append("fusion_v7")
        return names

    def recognize(self, image_bytes: bytes, expected_length: int | None = None) -> dict:
        variants = list(image_variants(image_bytes))
        predictions = []
        failures = []
        probability_variants = []
        with self.lock:
            self.load()
            for solver_name, solver in self.solvers:
                for variant_name, variant_bytes in variants:
                    try:
                        if solver_name == "official" and self.fusion is not None and expected_length == 4:
                            probability = solver.classification(variant_bytes, probability=True)
                            probability_variants.append((variant_name, probability))
                            answer = normalize_answer(probability.get("text"))
                        else:
                            answer = normalize_answer(solver.classification(variant_bytes))
                    except Exception as error:
                        failures.append(f"{solver_name}/{variant_name}: {error}")
                        continue
                    if answer_is_plausible(answer):
                        prediction = {
                            "solver": solver_name,
                            "variant": variant_name,
                            "answer": answer,
                        }
                        if variant_name == "dark_primary":
                            prediction["preferred"] = True
                        predictions.append(prediction)

        result = choose_ensemble(predictions, expected_length=expected_length)
        if self.fusion is not None and expected_length == 4:
            try:
                fused = self.fusion.recognize(
                    image_bytes, normalize_answer(result.get("answer")), probability_variants
                )
                if fused is not None:
                    result.update(fused)
                    result["selection_strategy"] = str(
                        fused.get("selection_strategy")
                        or fused.get("fusion_model")
                        or "fusion_v4_v6_v7"
                    )
            except Exception as error:
                failures.append(f"fusion_v4_v6_v7: {error}")
        result["predictions"] = predictions
        result["active_learning"] = apply_active_learning_sampling(
            assess_active_learning_priority(result),
            image_bytes,
        )
        result["solver_count"] = len(self.solvers)
        if failures:
            result["warnings"] = failures[:3]
        return result


ENGINE = OcrEngine()
FEEDBACK_STORE = FeedbackStore()


class OcrRequestHandler(BaseHTTPRequestHandler):
    server_version = "StevenCaptchaOCR/1.8"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _origin(self):
        return self.headers.get("Origin", "")

    def _send_json(self, status: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        origin = self._origin()
        if origin_is_allowed(origin) and origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _check_origin(self):
        if origin_is_allowed(self._origin()):
            return True
        self._send_json(403, {"ok": False, "error": "只允許 Chrome 擴充功能呼叫 OCR 服務"})
        return False

    def do_OPTIONS(self):
        if not self._check_origin():
            return
        self.send_response(204)
        origin = self._origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not self._check_origin():
            return
        if self.path != "/health":
            self._send_json(404, {"ok": False, "error": "找不到 API"})
            return
        try:
            ENGINE.load()
            self._send_json(200, {"ok": True, "solvers": ENGINE.names, "version": API_VERSION})
        except OcrError as error:
            self._send_json(503, {"ok": False, "error": str(error)})

    def do_POST(self):
        if not self._check_origin():
            return
        request_url = urlsplit(self.path)
        if request_url.path == "/feedback":
            self._handle_feedback()
            return
        if request_url.path == "/verified-sample":
            self._handle_verified_sample()
            return
        if request_url.path != "/recognize":
            self._send_json(404, {"ok": False, "error": "找不到 API"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_IMAGE_BYTES:
            self._send_json(413, {"ok": False, "error": "圖片大小必須介於 1 byte 至 5 MB"})
            return
        image_bytes = self.rfile.read(content_length)
        try:
            length_values = parse_qs(request_url.query, keep_blank_values=True).get("expectedLength", [])
            if len(length_values) > 1:
                raise OcrError("expectedLength must be provided at most once")
            expected_length = parse_expected_length(length_values[0] if length_values else None)
            result = ENGINE.recognize(image_bytes, expected_length=expected_length)
            result["report_id"] = FEEDBACK_STORE.remember(
                image_bytes,
                expected_length=expected_length,
                result=result,
            )
            result["ok"] = True
            self._send_json(200, result)
        except OcrError as error:
            self._send_json(422, {"ok": False, "error": str(error)})
        except Exception as error:
            self._send_json(500, {"ok": False, "error": f"OCR 服務錯誤: {error}"})

    def _handle_feedback(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_FEEDBACK_BYTES:
            self._send_json(413, {"ok": False, "error": "錯題回報資料過大或為空"})
            return
        if self.headers.get_content_type() != "application/json":
            self._send_json(415, {"ok": False, "error": "錯題回報必須使用 JSON"})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise OcrError("錯題回報格式錯誤")
            saved = FEEDBACK_STORE.confirm(
                payload.get("reportId"),
                payload.get("correctAnswer"),
            )
            self._send_json(201, {"ok": True, **saved})
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(422, {"ok": False, "error": "錯題回報格式錯誤"})
        except OcrError as error:
            self._send_json(422, {"ok": False, "error": str(error)})
        except Exception:
            self._send_json(500, {"ok": False, "error": "錯題回報服務錯誤"})

    def _handle_verified_sample(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_FEEDBACK_BYTES:
            self._send_json(413, {"ok": False, "error": "網站驗證資料過大或為空"})
            return
        if self.headers.get_content_type() != "application/json":
            self._send_json(415, {"ok": False, "error": "網站驗證資料必須使用 JSON"})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise OcrError("網站驗證資料格式錯誤")
            if payload.get("siteAccepted") is not True:
                raise OcrError("只能保存練習網站已確認正確的答案")
            source = parse_active_learning_source(payload.get("source"))
            evidence = parse_site_acceptance_evidence(payload.get("evidence"))
            saved = FEEDBACK_STORE.confirm(
                payload.get("reportId"),
                payload.get("correctAnswer"),
                source=source,
                verification="site_accepted",
                allow_correct_prediction=True,
                verification_evidence=evidence,
            )
            self._send_json(201, {"ok": True, **saved})
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(422, {"ok": False, "error": "網站驗證資料格式錯誤"})
        except OcrError as error:
            self._send_json(422, {"ok": False, "error": str(error)})
        except Exception:
            self._send_json(500, {"ok": False, "error": "主動學習資料保存失敗"})


class OcrHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def matching_service_is_running(host=DEFAULT_HOST, port=DEFAULT_PORT, timeout=1.0) -> bool:
    probe_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    try:
        with urllib.request.urlopen(
            f"http://{probe_host}:{port}/health",
            timeout=timeout,
        ) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read(MAX_FEEDBACK_BYTES).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, urllib.error.URLError):
        return False
    return payload.get("ok") is True and payload.get("version") == API_VERSION


def run_server(host=DEFAULT_HOST, port=DEFAULT_PORT):
    ENGINE.load()
    try:
        server = OcrHttpServer((host, port), OcrRequestHandler)
    except OSError:
        if matching_service_is_running(host, port):
            print(f"OCR 服務已在執行：http://{host}:{port}")
            return False
        raise
    print(f"Steven 驗證碼 OCR 服務已啟動：http://{host}:{port}")
    print("已載入模型：" + ", ".join(ENGINE.loaded_model_names))
    print("關閉此視窗或按 Ctrl+C 可停止服務。")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return True


def main():
    parser = argparse.ArgumentParser(description="Chrome extension CAPTCHA OCR service")
    parser.add_argument("--host", default=os.environ.get("OCR_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("OCR_PORT", DEFAULT_PORT)))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--check-running", action="store_true")
    mode.add_argument("--feedback-report", action="store_true")
    mode.add_argument("--dataset-manifest", action="store_true")
    mode.add_argument("--print-runtime-paths", action="store_true")
    parser.add_argument("--report-output", type=Path)
    parser.add_argument("--manifest-output", type=Path)
    parser.add_argument("--manifest-seed", type=int, default=20260809)
    parser.add_argument(
        "--manifest-split-strategy",
        choices=("image_hash", "label_grouped"),
        default="image_hash",
    )
    args = parser.parse_args()
    if args.print_runtime_paths:
        print(
            json.dumps(
                {
                    "frozen": bool(getattr(sys, "frozen", False)),
                    "bundle_root": str(BUNDLE_ROOT),
                    "app_root": str(APP_ROOT),
                    "model_root": str(MODEL_ROOT),
                    "training_root": str(TRAINING_ROOT),
                },
                ensure_ascii=True,
            )
        )
        return 0
    if args.feedback_report:
        report = build_feedback_report()
        rendered = json.dumps(report, ensure_ascii=False, indent=2)
        if args.report_output:
            args.report_output.parent.mkdir(parents=True, exist_ok=True)
            args.report_output.write_text(rendered, encoding="utf-8")
        print(rendered)
        return 0
    if args.dataset_manifest:
        manifest = build_dataset_manifest(
            seed=args.manifest_seed,
            split_strategy=args.manifest_split_strategy,
        )
        rendered = json.dumps(manifest, ensure_ascii=False, indent=2)
        if args.manifest_output:
            args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
            args.manifest_output.write_text(rendered, encoding="utf-8")
        print(rendered)
        return 0
    if args.check:
        ENGINE.load()
        print("OCR service check ok: " + ", ".join(ENGINE.loaded_model_names))
        return 0
    if args.check_running:
        return 0 if matching_service_is_running(args.host, args.port) else 1
    run_server(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
