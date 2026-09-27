import sys
import json
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import ocr_server


class RuntimePathTests(unittest.TestCase):
    def test_source_mode_keeps_resources_and_training_beside_script(self):
        bundle_root, app_root = ocr_server.resolve_runtime_roots(
            module_file=Path("C:/project/ocr_server.py"),
            executable=Path("C:/Python/python.exe"),
            frozen=False,
        )

        self.assertEqual(bundle_root, Path("C:/project"))
        self.assertEqual(app_root, Path("C:/project"))

    def test_frozen_mode_writes_beside_executable_not_bundle_directory(self):
        bundle_root, app_root = ocr_server.resolve_runtime_roots(
            module_file=Path("C:/release/_internal/ocr_server.py"),
            executable=Path("C:/release/StevenCaptchaOCR.exe"),
            frozen=True,
        )

        self.assertEqual(bundle_root, Path("C:/release/_internal"))
        self.assertEqual(app_root, Path("C:/release"))
        self.assertEqual(bundle_root / "models", Path("C:/release/_internal/models"))
        self.assertEqual(app_root / "training", Path("C:/release/training"))


class OcrEngineLoadingTests(unittest.TestCase):
    class FakeDdddOcr:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def test_loads_official_solver_when_optional_custom_models_are_absent(self):
        with TemporaryDirectory() as directory:
            fake_module = SimpleNamespace(DdddOcr=self.FakeDdddOcr)
            with patch.dict(sys.modules, {"ddddocr": fake_module}):
                engine = ocr_server.OcrEngine(Path(directory)).load()

        self.assertEqual(engine.names, ["official"])

    def test_rejects_a_partially_installed_optional_custom_model(self):
        with TemporaryDirectory() as directory:
            model_root = Path(directory)
            folder = model_root / "universal"
            folder.mkdir()
            (folder / "custom.onnx").write_bytes(b"not-a-real-model")
            fake_module = SimpleNamespace(DdddOcr=self.FakeDdddOcr)

            with patch.dict(sys.modules, {"ddddocr": fake_module}):
                with self.assertRaisesRegex(ocr_server.OcrError, "OCR 模型不完整"):
                    ocr_server.OcrEngine(model_root).load()

    def test_rejects_a_partially_installed_fusion_model(self):
        with TemporaryDirectory() as directory:
            model_root = Path(directory)
            folder = model_root / "fusion_v7"
            folder.mkdir()
            (folder / "config.json").write_text("{}", encoding="utf-8")
            fake_module = SimpleNamespace(DdddOcr=self.FakeDdddOcr)

            with patch.dict(sys.modules, {"ddddocr": fake_module}):
                with self.assertRaisesRegex(ocr_server.OcrError, "融合 OCR 模型載入失敗"):
                    ocr_server.OcrEngine(model_root).load()


class OcrEngineFusionStrategyTests(unittest.TestCase):
    class FakeSolver:
        def classification(self, image_bytes, probability=False):
            if probability:
                return {
                    "text": "WXYZ",
                    "probabilities": [],
                    "charset": [""],
                }
            return "WXYZ"

    class FakeFusion:
        def recognize(self, image_bytes, baseline, probability_variants):
            return {
                "answer": "ABCD",
                "selection_strategy": "light_generic_v1",
                "fusion_model": "light_generic_v1",
            }

    def test_records_light_fusion_selection_strategy(self):
        engine = ocr_server.OcrEngine(Path("unused"))
        engine.solvers = [("official", self.FakeSolver())]
        engine.fusion = self.FakeFusion()

        with patch.object(
            ocr_server,
            "image_variants",
            return_value=[("raw", b"variant")],
        ):
            result = engine.recognize(b"image", expected_length=4)

        self.assertEqual(result["answer"], "ABCD")
        self.assertEqual(result["selection_strategy"], "light_generic_v1")


class NormalizeAnswerTests(unittest.TestCase):
    def test_normalizes_to_uppercase_ascii_letters_and_digits(self):
        self.assertEqual(ocr_server.normalize_answer(" a-2 b。 "), "A2B")

    def test_rejects_implausible_lengths(self):
        self.assertFalse(ocr_server.answer_is_plausible("AB"))
        self.assertTrue(ocr_server.answer_is_plausible("A2BC"))
        self.assertFalse(ocr_server.answer_is_plausible("ABCDEFG"))


class EnsembleTests(unittest.TestCase):
    def test_distinct_solver_agreement_beats_one_noisy_solver(self):
        predictions = [
            {"solver": "official", "variant": "raw", "answer": "WRNG"},
            {"solver": "official", "variant": "gray", "answer": "WRNG"},
            {"solver": "official", "variant": "contrast", "answer": "WRNG"},
            {"solver": "universal", "variant": "raw", "answer": "A7K2"},
            {"solver": "tixcraft_tm", "variant": "raw", "answer": "A7K2"},
        ]
        result = ocr_server.choose_ensemble(predictions)
        self.assertEqual(result["answer"], "A7K2")
        self.assertEqual(result["solver_votes"], 2)

    def test_raw_variant_breaks_an_equal_vote(self):
        predictions = [
            {"solver": "official", "variant": "gray", "answer": "AAAA"},
            {"solver": "universal", "variant": "raw", "answer": "BBBB"},
        ]
        self.assertEqual(ocr_server.choose_ensemble(predictions)["answer"], "BBBB")

    def test_preferred_variant_beats_repeated_fallbacks_from_the_same_solver(self):
        predictions = [
            {"solver": "official", "variant": "dark_primary", "answer": "A7K2", "preferred": True},
            {"solver": "official", "variant": "contrast", "answer": "WRNG"},
            {"solver": "official", "variant": "threshold", "answer": "WRNG"},
            {"solver": "official", "variant": "resize2", "answer": "WRNG"},
        ]

        self.assertEqual(ocr_server.choose_ensemble(predictions)["answer"], "A7K2")

    def test_strong_variant_consensus_can_override_one_noisy_preferred_prediction(self):
        predictions = [
            {"solver": "official", "variant": "dark_primary", "answer": "ZWWE", "preferred": True},
            {"solver": "official", "variant": "dark_normalized", "answer": "ZUWE"},
            {"solver": "official", "variant": "dark_contrast", "answer": "ZUWE"},
            {"solver": "official", "variant": "dark_autocontrast", "answer": "ZUWE"},
            {"solver": "official", "variant": "dark_resize2", "answer": "ZUWE"},
            {"solver": "official", "variant": "dark_raw", "answer": "ZUWE"},
        ]

        result = ocr_server.choose_ensemble(predictions, expected_length=4)

        self.assertEqual(result["answer"], "ZUWE")
        self.assertEqual(result["selection_strategy"], "strong_variant_consensus_override")
        self.assertEqual(result["candidates"][0]["answer"], "ZUWE")

    def test_small_variant_plurality_does_not_override_preferred_prediction(self):
        predictions = [
            {"solver": "official", "variant": "dark_primary", "answer": "A7K2", "preferred": True},
            {"solver": "official", "variant": "dark_contrast", "answer": "WRNG"},
            {"solver": "official", "variant": "dark_threshold", "answer": "WRNG"},
            {"solver": "official", "variant": "dark_resize2", "answer": "WRNG"},
            {"solver": "official", "variant": "dark_raw", "answer": "WRNG"},
        ]

        result = ocr_server.choose_ensemble(predictions, expected_length=4)

        self.assertEqual(result["answer"], "A7K2")
        self.assertEqual(result["selection_strategy"], "solver_then_preferred_then_total")

    def test_expected_length_rejects_a_preferred_three_character_omission(self):
        predictions = [
            {"solver": "official", "variant": "dark_primary", "answer": "A72", "preferred": True},
            {"solver": "official", "variant": "dark_normalized", "answer": "A7K2"},
        ]

        result = ocr_server.choose_ensemble(predictions, expected_length=4)

        self.assertEqual(result["answer"], "A7K2")
        self.assertTrue(result["length_match"])

    def test_expected_length_marks_a_three_character_answer_as_unsafe(self):
        predictions = [
            {"solver": "official", "variant": "dark_primary", "answer": "WNE", "preferred": True},
        ]

        result = ocr_server.choose_ensemble(predictions, expected_length=4)

        self.assertEqual(result["answer"], "WNE")
        self.assertFalse(result["length_match"])
        self.assertEqual(result["expected_length"], 4)

    def test_no_plausible_predictions_raises(self):
        with self.assertRaises(ocr_server.OcrError):
            ocr_server.choose_ensemble([])


class ActiveLearningPriorityTests(unittest.TestCase):
    def test_unanimous_result_is_low_priority(self):
        result = {
            "answer": "ABCD",
            "solver_votes": 3,
            "length_match": True,
            "selection_strategy": "solver_then_preferred_then_total",
            "candidates": [{"answer": "ABCD", "total_votes": 9}],
            "predictions": [
                {"solver": "official", "answer": "ABCD", "preferred": True},
                {"solver": "universal", "answer": "ABCD", "preferred": True},
                {"solver": "tixcraft_tm", "answer": "ABCD", "preferred": True},
            ],
        }

        priority = ocr_server.assess_active_learning_priority(result)

        self.assertEqual(priority["priority"], "low")
        self.assertFalse(priority["save_if_site_accepted"])
        self.assertEqual(priority["recommended_sample_rate"], 0.10)

    def test_consensus_override_is_high_priority(self):
        result = {
            "answer": "ZUWE",
            "solver_votes": 1,
            "length_match": True,
            "selection_strategy": "strong_variant_consensus_override",
            "candidates": [
                {"answer": "ZUWE", "total_votes": 5},
                {"answer": "ZWWE", "total_votes": 1},
            ],
            "predictions": [
                {"solver": "official", "answer": "ZWWE", "preferred": True},
                {"solver": "official", "answer": "ZUWE"},
            ],
        }

        priority = ocr_server.assess_active_learning_priority(result)

        self.assertEqual(priority["priority"], "high")
        self.assertTrue(priority["save_if_site_accepted"])
        self.assertEqual(priority["recommended_sample_rate"], 1.0)
        self.assertIn("strong_consensus_overrode_preferred", priority["reasons"])

    def test_length_mismatch_is_high_priority(self):
        priority = ocr_server.assess_active_learning_priority({
            "answer": "WNE",
            "solver_votes": 1,
            "length_match": False,
            "candidates": [{"answer": "WNE", "total_votes": 6}],
            "predictions": [{"solver": "official", "answer": "WNE", "preferred": True}],
        })

        self.assertEqual(priority["priority"], "high")
        self.assertIn("expected_length_mismatch", priority["reasons"])

    def test_fractional_sampling_is_stable_for_the_same_image(self):
        priority = {"priority": "medium", "recommended_sample_rate": 0.35}

        first = ocr_server.apply_active_learning_sampling(priority, b"same-image")
        second = ocr_server.apply_active_learning_sampling(priority, b"same-image")

        self.assertEqual(first, second)
        self.assertGreaterEqual(first["sampling_bucket"], 0.0)
        self.assertLessEqual(first["sampling_bucket"], 1.0)
        self.assertEqual(
            first["sample_recommended"],
            first["sampling_bucket"] < priority["recommended_sample_rate"],
        )


class OriginTests(unittest.TestCase):
    def test_allows_extension_and_local_test_clients(self):
        self.assertTrue(ocr_server.origin_is_allowed("chrome-extension://abcdef"))
        self.assertTrue(ocr_server.origin_is_allowed(""))

    def test_rejects_regular_web_pages(self):
        self.assertFalse(ocr_server.origin_is_allowed("https://example.com"))


class ExpectedLengthTests(unittest.TestCase):
    def test_accepts_only_bounded_integer_length_hints(self):
        self.assertIsNone(ocr_server.parse_expected_length(None))
        self.assertEqual(ocr_server.parse_expected_length("4"), 4)

        for value in ("2", "7", "4.0", "four", "3&admin=true"):
            with self.subTest(value=value):
                with self.assertRaises(ocr_server.OcrError):
                    ocr_server.parse_expected_length(value)

    def test_active_learning_accepts_only_the_practice_source(self):
        self.assertEqual(
            ocr_server.parse_active_learning_source("toolweb_practice"),
            "toolweb_practice",
        )
        for value in ("", "tixcraft", "https://toolweb.app", "../toolweb_practice"):
            with self.subTest(value=value):
                with self.assertRaises(ocr_server.OcrError):
                    ocr_server.parse_active_learning_source(value)

    def test_site_acceptance_requires_a_changed_captcha_and_one_new_attempt(self):
        evidence = ocr_server.parse_site_acceptance_evidence({
            "captchaChanged": True,
            "attemptsBefore": 41,
            "attemptsAfter": 42,
        })
        self.assertEqual(evidence["attempts_after"], 42)

        for value in (
            None,
            {"captchaChanged": False, "attemptsBefore": 1, "attemptsAfter": 2},
            {"captchaChanged": True, "attemptsBefore": 1, "attemptsAfter": 3},
        ):
            with self.subTest(value=value):
                with self.assertRaises(ocr_server.OcrError):
                    ocr_server.parse_site_acceptance_evidence(value)


class ErrorAnalysisTests(unittest.TestCase):
    def test_classifies_repeated_missing_and_substituted_characters(self):
        repeated = ocr_server.analyze_recognition_error("ZTE", "ZTTE")
        missing = ocr_server.analyze_recognition_error("QJA", "QIJA")
        substitution = ocr_server.analyze_recognition_error("FUWE", "FAWE")

        self.assertEqual(repeated["type"], "repeated_character_missing")
        self.assertEqual(missing["type"], "missing_character")
        self.assertEqual(substitution["type"], "substitution")


class FeedbackStoreTests(unittest.TestCase):
    def make_png(self):
        image = Image.new("RGB", (120, 40), "white")
        output = BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def test_saves_only_a_confirmed_wrong_answer_as_png_and_json(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            report_id = store.remember(
                self.make_png(),
                expected_length=4,
                result={
                    "answer": "3L06",
                    "candidates": [{"answer": "3L06", "solver_votes": 2, "total_votes": 4}],
                    "predictions": [
                        {"solver": "official", "variant": "raw", "answer": "3L06"},
                    ],
                },
            )

            self.assertEqual(list(Path(directory).rglob("*")), [])

            saved = store.confirm(report_id, "1066")
            image_path = Path(directory, "samples", saved["image_file"])
            metadata_path = Path(directory, "feedback", saved["metadata_file"])

            self.assertTrue(image_path.is_file())
            self.assertTrue(metadata_path.is_file())
            self.assertTrue(image_path.name.startswith("1066__"))
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["correct_answer"], "1066")
            self.assertEqual(metadata["predicted_answer"], "3L06")
            self.assertEqual(metadata["expected_length"], 4)

    def test_rejects_invalid_labels_same_answer_and_reused_report_ids(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            report_id = store.remember(self.make_png(), None, {"answer": "A7K2"})

            for invalid in ("", "AB", "A/B2", "ABCDEFG"):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ocr_server.OcrError):
                        store.confirm(report_id, invalid)

            with self.assertRaisesRegex(ocr_server.OcrError, "不同"):
                store.confirm(report_id, "a7k2")

            store.confirm(report_id, "B8M3")
            with self.assertRaisesRegex(ocr_server.OcrError, "失效"):
                store.confirm(report_id, "C9N4")

    def test_rejects_unknown_report_id_without_writing_files(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            with self.assertRaises(ocr_server.OcrError):
                store.confirm("0" * 32, "A7K2")
            self.assertEqual(list(Path(directory).rglob("*")), [])

    def test_merges_the_same_image_and_label_without_saving_a_second_copy(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            result = {"answer": "QJA", "candidates": [], "predictions": []}
            first_id = store.remember(self.make_png(), 4, result)
            second_id = store.remember(self.make_png(), 4, result)

            first = store.confirm(first_id, "QIJA")
            second = store.confirm(second_id, "QIJA")

            self.assertFalse(first["duplicate"])
            self.assertTrue(second["duplicate"])
            self.assertEqual(second["occurrences"], 2)
            self.assertEqual(len(list(Path(directory, "samples").glob("*.png"))), 1)
            metadata = json.loads(Path(directory, "feedback", first["metadata_file"]).read_text(encoding="utf-8"))
            self.assertEqual(metadata["occurrences"], 2)
            self.assertEqual(metadata["error_analysis"]["type"], "missing_character")

            report = ocr_server.build_feedback_report(Path(directory))
            self.assertEqual(report["records"], 1)
            self.assertEqual(report["unique_images"], 1)
            self.assertEqual(report["total_occurrences"], 2)
            self.assertEqual(report["occurrence_error_types"], {"missing_character": 2})

    def test_rejects_conflicting_labels_for_the_same_image(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            result = {"answer": "QJA", "candidates": [], "predictions": []}
            first_id = store.remember(self.make_png(), 4, result)
            second_id = store.remember(self.make_png(), 4, result)
            store.confirm(first_id, "QIJA")

            with self.assertRaisesRegex(ocr_server.OcrError, "不同正解"):
                store.confirm(second_id, "QJAB")

    def test_saves_a_site_accepted_correct_prediction_for_active_learning(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            report_id = store.remember(
                self.make_png(),
                4,
                {"answer": "A7K2", "candidates": [], "predictions": []},
            )

            saved = store.confirm(
                report_id,
                "A7K2",
                source="toolweb_practice",
                verification="site_accepted",
                allow_correct_prediction=True,
                verification_evidence={
                    "captcha_changed": True,
                    "attempts_before": 10,
                    "attempts_after": 11,
                },
            )

            metadata = json.loads(
                Path(directory, "feedback", saved["metadata_file"]).read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["record_kind"], "verified_correct")
            self.assertEqual(metadata["source"], "toolweb_practice")
            self.assertEqual(metadata["verification"], "site_accepted")
            self.assertEqual(metadata["verification_evidence"]["attempts_after"], 11)
            self.assertEqual(metadata["error_analysis"]["type"], "correct")

            manifest = ocr_server.build_dataset_manifest(Path(directory), seed=42)
            self.assertEqual(manifest["unique_verified_images"], 1)
            self.assertEqual(manifest["split_counts"], {"train": 1})
            self.assertEqual(manifest["entries"][0]["split"], "train")
            self.assertEqual(manifest["entries"][0]["sources"], ["toolweb_practice"])

    def test_label_grouped_manifest_keeps_equal_labels_in_one_split(self):
        with TemporaryDirectory() as directory:
            store = ocr_server.FeedbackStore(Path(directory))
            labels = ["SAME", "SAME", "ABCD", "EFGH", "IJKL", "MNOP", "QRST", "UVWX", "YZAA", "BCDE", "FGHI", "JKLM"]
            for index, label in enumerate(labels):
                image = Image.new("RGB", (120, 40), (index * 17 % 255, index * 31 % 255, index * 47 % 255))
                output = BytesIO()
                image.save(output, format="PNG")
                report_id = store.remember(
                    output.getvalue(),
                    4,
                    {"answer": label, "candidates": [], "predictions": []},
                )
                store.confirm(
                    report_id,
                    label,
                    source="toolweb_practice",
                    verification="site_accepted",
                    allow_correct_prediction=True,
                    verification_evidence={
                        "captcha_changed": True,
                        "attempts_before": index,
                        "attempts_after": index + 1,
                    },
                )

            first = ocr_server.build_dataset_manifest(
                Path(directory), seed=20260811, split_strategy="label_grouped"
            )
            second = ocr_server.build_dataset_manifest(
                Path(directory), seed=20260811, split_strategy="label_grouped"
            )

            same_splits = {entry["split"] for entry in first["entries"] if entry["label"] == "SAME"}
            self.assertEqual(same_splits, {next(iter(same_splits))})
            self.assertEqual(first["split_strategy"], "label_grouped")
            self.assertEqual(first["split_counts"], second["split_counts"])
            self.assertEqual(
                [(entry["image_sha256"], entry["split"]) for entry in first["entries"]],
                [(entry["image_sha256"], entry["split"]) for entry in second["entries"]],
            )
            label_to_splits = {}
            for entry in first["entries"]:
                label_to_splits.setdefault(entry["label"], set()).add(entry["split"])
            self.assertTrue(all(len(splits) == 1 for splits in label_to_splits.values()))


class ImageValidationTests(unittest.TestCase):
    def test_rejects_decompressed_images_above_pixel_limit(self):
        image = Image.new("RGB", (2001, 1000), "white")
        output = BytesIO()
        image.save(output, format="PNG")
        with self.assertRaisesRegex(ocr_server.OcrError, "圖片尺寸過大"):
            list(ocr_server.image_variants(output.getvalue()))


class PolarityNormalizationTests(unittest.TestCase):
    def test_all_variants_are_rgb_for_three_channel_custom_models(self):
        for background in ((80, 80, 80), (255, 255, 255)):
            image = Image.new("RGB", (120, 100), background)
            output = BytesIO()
            image.save(output, format="PNG")

            variants = list(ocr_server.image_variants(output.getvalue()))

            self.assertTrue(variants)
            for name, encoded in variants:
                with self.subTest(background=background, variant=name):
                    self.assertEqual(Image.open(BytesIO(encoded)).mode, "RGB")

    def test_dark_background_is_inverted_before_ocr(self):
        image = Image.new("RGB", (120, 100), (80, 80, 80))
        for x in range(35, 85):
            for y in range(30, 70):
                image.putpixel((x, y), (255, 255, 255))
        output = BytesIO()
        image.save(output, format="PNG")

        variants = list(ocr_server.image_variants(output.getvalue()))
        normalized = Image.open(BytesIO(variants[0][1])).convert("L")

        self.assertEqual(variants[0][0], "dark_primary")
        self.assertGreater(normalized.getpixel((0, 0)), normalized.getpixel((60, 50)))

    def test_dark_background_keeps_original_pixels_as_a_last_resort(self):
        image = Image.new("RGB", (120, 100), (20, 80, 220))
        output = BytesIO()
        image.save(output, format="PNG")

        variants = list(ocr_server.image_variants(output.getvalue()))
        name, encoded = variants[-1]
        original = Image.open(BytesIO(encoded)).convert("RGB")

        self.assertEqual(name, "dark_raw")
        self.assertEqual(original.getpixel((60, 50)), (20, 80, 220))

    def test_dark_background_adds_validation_selected_gray_padding(self):
        image = Image.new("RGB", (120, 100), (20, 80, 220))
        for x in range(35, 85):
            for y in range(30, 70):
                image.putpixel((x, y), (255, 255, 255))
        output = BytesIO()
        image.save(output, format="PNG")

        variants = dict(ocr_server.image_variants(output.getvalue()))
        padded = Image.open(BytesIO(variants["gray_pad2"])).convert("RGB")
        expected_background = ImageOps.grayscale(image).getpixel((0, 0))

        self.assertEqual(padded.size, (124, 104))
        self.assertEqual(padded.getpixel((0, 0)), (expected_background,) * 3)
        self.assertEqual(padded.getpixel((62, 52)), (255, 255, 255))

    def test_light_background_keeps_the_existing_raw_variant(self):
        image = Image.new("RGB", (120, 100), "white")
        image.putpixel((60, 50), (0, 0, 0))
        output = BytesIO()
        image.save(output, format="PNG")

        variants = list(ocr_server.image_variants(output.getvalue()))
        raw = Image.open(BytesIO(variants[0][1])).convert("RGB")

        self.assertEqual(raw.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(raw.getpixel((60, 50)), (0, 0, 0))

    def test_light_separator_border_does_not_hide_a_dark_background(self):
        image = Image.new("RGB", (120, 100), (80, 80, 80))
        for x in range(120):
            image.putpixel((x, 0), (255, 255, 255))
            image.putpixel((x, 99), (255, 255, 255))
        for y in range(100):
            image.putpixel((0, y), (255, 255, 255))
            image.putpixel((119, y), (255, 255, 255))
        output = BytesIO()
        image.save(output, format="PNG")

        variants = list(ocr_server.image_variants(output.getvalue()))

        self.assertEqual(variants[0][0], "dark_primary")


if __name__ == "__main__":
    unittest.main()
