import string
import sys
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import fusion_ocr


class CandidateBeamTests(unittest.TestCase):
    def test_uses_exact_lowercase_charset_indices(self):
        charset = [""] + list(string.ascii_uppercase) + list(string.ascii_lowercase)
        row = [0.001] * len(charset)
        row[charset.index("A")] = 0.99
        row[charset.index("b")] = 0.80

        result = fusion_ocr.ctc_prefix_beam(
            [[row]], charset, target_length=1, beam_width=30, topn=1
        )

        self.assertEqual(result[0]["answer"], "B")


class FeatureCompatibilityTests(unittest.TestCase):
    def test_feature_layout_remains_145_values(self):
        self.assertEqual(len(fusion_ocr.feature_names()), 145)

    def test_light_feature_layout_is_the_144_value_training_layout(self):
        self.assertEqual(len(fusion_ocr.light_feature_names()), 144)
        self.assertEqual(
            fusion_ocr.light_feature_names()[0:10],
            [
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
            ],
        )
        self.assertEqual(fusion_ocr.light_feature_names()[-1], "candidate_3_Z")


class LightForwardTests(unittest.TestCase):
    def test_numpy_forward_matches_reference_layer_math(self):
        rng = np.random.default_rng(17)
        parameters = [
            rng.normal(size=(128, 144)).astype(np.float32),
            rng.normal(size=(128,)).astype(np.float32),
            rng.normal(size=(128,)).astype(np.float32),
            rng.normal(size=(128,)).astype(np.float32),
            rng.normal(size=(64, 128)).astype(np.float32),
            rng.normal(size=(64,)).astype(np.float32),
            rng.normal(size=(1, 64)).astype(np.float32),
            rng.normal(size=(1,)).astype(np.float32),
        ]
        features = rng.normal(size=(3, 144)).astype(np.float32)

        first = features @ parameters[0].T + parameters[1]
        mean = first.mean(axis=1, keepdims=True)
        centered = first - mean
        normalized = centered / np.sqrt(
            (centered * centered).mean(axis=1, keepdims=True) + 1e-5
        )
        normalized = normalized * parameters[2] + parameters[3]
        hidden = np.maximum(normalized, 0.0)
        hidden = np.maximum(hidden @ parameters[4].T + parameters[5], 0.0)
        expected = (hidden @ parameters[6].T + parameters[7]).reshape(-1)

        actual = fusion_ocr.light_reranker_forward(features, parameters)

        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-5)


class LightSelectionTests(unittest.TestCase):
    def make_fusion(self):
        fusion = object.__new__(fusion_ocr.Fixed4FusionOcr)
        fusion.light_threshold = 0.35
        fusion.light_margin = 0.02
        fusion.light_eps = 1e-5
        fusion.light_parameters = [np.zeros(shape, dtype=np.float32) for shape in (
            (128, 144), (128,), (128,), (128,), (64, 128), (64,), (1, 64), (1,),
        )]
        fusion.config = {
            "light_reranker": {"beam_width": 160, "topn": 5},
        }
        return fusion

    def probability_variants(self):
        probability = {
            "probabilities": [],
            "charset": [""],
            "text": "WXYZ",
        }
        return [(name, probability) for name in fusion_ocr.LIGHT_VARIANTS]

    def test_high_confidence_light_candidate_overrides_pure_letter_baseline(self):
        fusion = self.make_fusion()
        candidates = [
            {"answer": "ABCD", "relative_probability": 1.0},
            {"answer": "WXYZ", "relative_probability": 0.4},
        ]
        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=candidates), \
                patch.object(fusion, "_light_reranker", return_value=np.array([4.0, 0.0])):
            result = fusion.recognize(b"unused", "WXYZ", self.probability_variants())

        self.assertEqual(result["answer"], "ABCD")
        self.assertTrue(result["overridden"])
        self.assertEqual(result["selection_strategy"], "light_generic_v1")

    def test_low_confidence_light_candidate_keeps_baseline(self):
        fusion = self.make_fusion()
        candidates = [
            {"answer": "ABCD", "relative_probability": 1.0},
            {"answer": "WXYZ", "relative_probability": 0.4},
        ]
        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=candidates), \
                patch.object(fusion, "_light_reranker", return_value=np.array([0.0, 0.0])):
            result = fusion.recognize(b"unused", "WXYZ", self.probability_variants())

        self.assertEqual(result["answer"], "WXYZ")
        self.assertFalse(result["overridden"])

    def test_four_character_mixed_baseline_is_never_overridden(self):
        fusion = self.make_fusion()
        candidates = [
            {"answer": "ABCD", "relative_probability": 1.0},
            {"answer": "WXYZ", "relative_probability": 0.4},
        ]
        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=candidates), \
                patch.object(fusion, "_light_reranker", return_value=np.array([4.0, 0.0])):
            result = fusion.recognize(b"unused", "WX1Z", self.probability_variants())

        self.assertEqual(result["answer"], "WX1Z")
        self.assertFalse(result["overridden"])

    def test_light_features_use_raw_probability_text_not_ensemble_baseline(self):
        fusion = self.make_fusion()
        seen_feature_baselines = []
        candidates = [
            {"answer": "ABCD", "relative_probability": 1.0},
            {"answer": "WXYZ", "relative_probability": 0.4},
        ]

        def capture_features(candidate, variant_candidates, variant_texts, baseline_answer):
            seen_feature_baselines.append(baseline_answer)
            return [0.0] * 144

        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=candidates), \
                patch.object(fusion_ocr, "build_light_candidate_features", side_effect=capture_features), \
                patch.object(fusion, "_light_reranker", return_value=np.array([0.0, 0.0])):
            fusion.recognize(b"unused", "ENSE", self.probability_variants())

        self.assertEqual(seen_feature_baselines, ["WXYZ", "WXYZ"])

    def test_dark_variant_names_do_not_enter_light_branch(self):
        self.assertFalse(
            fusion_ocr.Fixed4FusionOcr._is_light_branch([
                ("dark_primary", {}),
                ("dark_raw", {}),
            ])
        )

    def test_dark_fusion_keeps_the_existing_v4_v6_v7_path(self):
        fusion = self.make_fusion()
        fusion.charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        fusion.alpha = 1.0
        fusion.beta = 1.0
        fusion.threshold = 0.5
        dark_variants = [
            ("dark_primary", {"probabilities": [], "charset": [""], "text": "WXYZ"}),
            ("dark_raw", {"probabilities": [], "charset": [""], "text": "WXYZ"}),
        ]
        candidate_rows = [
            {"answer": "ABCD", "relative_probability": 1.0},
            {"answer": "WXYZ", "relative_probability": 0.5},
        ]
        direct = np.full((4, 36), 1e-4, dtype=np.float32)
        crop = np.full((4, 36), 1e-4, dtype=np.float32)
        for position, character in enumerate("ABCD"):
            direct[position, fusion.charset.index(character)] = 0.9
            crop[position, fusion.charset.index(character)] = 0.9
        image_stream = BytesIO()
        Image.new("RGB", (40, 20), "white").save(image_stream, format="PNG")
        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=candidate_rows), \
                patch.object(fusion, "_reranker", return_value=np.array([0.0, 0.0])), \
                patch.object(fusion, "_direct_probabilities", return_value=direct), \
                patch.object(fusion, "_crop_probabilities", return_value=crop):
            result = fusion.recognize(image_stream.getvalue(), "WXYZ", dark_variants)

        self.assertEqual(result["answer"], "ABCD")
        self.assertEqual(result["fusion_model"], "v4+v6+v7")
        self.assertNotIn("selection_strategy", result)

    def test_dark_fusion_rescues_3_letter_baseline_and_injects_direct_crop_top1(self):
        fusion = self.make_fusion()
        fusion.charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        fusion.alpha = 6.0
        fusion.beta = 6.0
        fusion.threshold = 0.5
        dark_variants = [
            ("dark_primary", {"probabilities": [], "charset": [""], "text": "LMR"}),
        ]
        # Official beam only contains a wrong 4-letter candidate ("ILMR"), missing "TLMR".
        candidate_rows = [{"answer": "ILMR", "relative_probability": 1.0}]
        direct = np.full((4, 36), 1e-4, dtype=np.float32)
        crop = np.full((4, 36), 1e-4, dtype=np.float32)
        for position, character in enumerate("TLMR"):
            direct[position, fusion.charset.index(character)] = 0.95
            crop[position, fusion.charset.index(character)] = 0.95
        image_stream = BytesIO()
        Image.new("RGB", (40, 20), (2, 108, 223)).save(image_stream, format="PNG")
        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=candidate_rows), \
                patch.object(fusion, "_reranker", side_effect=lambda feats: np.zeros(len(feats), dtype=np.float32)), \
                patch.object(fusion, "_direct_probabilities", return_value=direct), \
                patch.object(fusion, "_crop_probabilities", return_value=crop):
            result = fusion.recognize(image_stream.getvalue(), "LMR", dark_variants)

        self.assertEqual(result["answer"], "TLMR")
        self.assertEqual(result["fusion_candidate_count"], 2)

    def test_dark_fusion_rejects_uniform_cnn_guess_when_official_beams_are_empty(self):
        fusion = self.make_fusion()
        fusion.charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        fusion.alpha = 6.0
        fusion.beta = 6.0
        fusion.threshold = 0.5
        dark_variants = [("dark_primary", {"probabilities": [], "charset": [""], "text": "LMR"})]
        uniform = np.full((4, 36), 1.0 / 36.0, dtype=np.float32)
        image_stream = BytesIO()
        Image.new("RGB", (40, 20), (2, 108, 223)).save(image_stream, format="PNG")
        with patch.object(fusion_ocr, "ctc_prefix_beam", return_value=[]), \
                patch.object(fusion, "_reranker", side_effect=lambda feats: np.zeros(len(feats), dtype=np.float32)), \
                patch.object(fusion, "_direct_probabilities", return_value=uniform), \
                patch.object(fusion, "_crop_probabilities", return_value=uniform):
            result = fusion.recognize(image_stream.getvalue(), "LMR", dark_variants)

        self.assertIsNone(result)


class BundleValidationTests(unittest.TestCase):
    def test_partial_bundle_rejects_missing_light_npz(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "config.json").write_text(
                '{"feature_names": []}', encoding="utf-8"
            )
            for name in ("reranker.npz", "direct.onnx", "crop.onnx"):
                (folder / name).write_bytes(b"placeholder")

            with self.assertRaisesRegex(fusion_ocr.FusionModelError, "light_reranker.npz"):
                fusion_ocr.Fixed4FusionOcr(folder)

    def test_light_reranker_config_bounds_accept_tuned_values_and_reject_out_of_range(self):
        import hashlib
        import json
        import ocr_server

        with TemporaryDirectory() as directory:
            folder = Path(directory)
            npz_path = folder / "light_reranker.npz"
            shapes = ((128, 144), (128,), (128,), (128,), (64, 128), (64,), (1, 64), (1,))
            np.savez(npz_path, **{f"param_{i}": np.zeros(shape, dtype=np.float32) for i, shape in enumerate(shapes)})
            npz_sha = hashlib.sha256(npz_path.read_bytes()).hexdigest()
            np.savez(
                folder / "reranker.npz",
                mean=np.zeros(145, dtype=np.float32),
                std=np.ones(145, dtype=np.float32),
                w0=np.zeros((8, 145), dtype=np.float32),
                b0=np.zeros(8, dtype=np.float32),
                w1=np.zeros((4, 8), dtype=np.float32),
                b1=np.zeros(4, dtype=np.float32),
                w2=np.zeros((1, 4), dtype=np.float32),
                b2=np.zeros(1, dtype=np.float32),
            )
            (folder / "direct.onnx").write_bytes(b"fake")
            (folder / "crop.onnx").write_bytes(b"fake")
            base_cfg = {
                "charset": "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                "alpha": 1.0,
                "beta": 1.0,
                "threshold": 0.5,
                "feature_names": fusion_ocr.feature_names(),
                "light_reranker": {
                    "feature_version": fusion_ocr.LIGHT_FEATURE_VERSION,
                    "feature_names": fusion_ocr.light_feature_names(),
                    "feature_dim": len(fusion_ocr.light_feature_names()),
                    "variants": list(fusion_ocr.LIGHT_VARIANTS),
                    "beam_width": 96,
                    "topn": 8,
                    "threshold": 0.42,
                    "margin": 0.05,
                    "layer_norm_eps": 1e-5,
                    "source_sha256": npz_sha,
                },
            }
            (folder / "config.json").write_text(json.dumps(base_cfg), encoding="utf-8")
            with patch("onnxruntime.InferenceSession", return_value=object()):
                loaded = fusion_ocr.Fixed4FusionOcr(folder)
            self.assertEqual(loaded.light_threshold, 0.42)
            self.assertEqual(loaded.light_margin, 0.05)

            bad_cfg = json.loads(json.dumps(base_cfg))
            bad_cfg["light_reranker"]["threshold"] = 1.5
            (folder / "config.json").write_text(json.dumps(bad_cfg), encoding="utf-8")
            with self.assertRaisesRegex(fusion_ocr.FusionModelError, "gate"):
                fusion_ocr.Fixed4FusionOcr(folder)


if __name__ == "__main__":
    unittest.main()
