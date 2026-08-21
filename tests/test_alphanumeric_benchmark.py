import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

import alphanumeric_benchmark as benchmark


class AlphanumericLabelTests(unittest.TestCase):
    def test_balanced_labels_are_deterministic_unique_and_cover_digits(self):
        first = benchmark.generate_balanced_labels(200, 20260820)
        second = benchmark.generate_balanced_labels(200, 20260820)
        coverage = benchmark.label_coverage(first)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 200)
        self.assertEqual(len(set(first)), 200)
        self.assertGreaterEqual(coverage["minimum_digit_occurrences"], 20)
        self.assertGreaterEqual(coverage["minimum_confusion_symbol_occurrences"], 20)

    def test_different_seed_changes_labels(self):
        self.assertNotEqual(
            benchmark.generate_balanced_labels(20, 1),
            benchmark.generate_balanced_labels(20, 2),
        )


class AlphanumericRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fonts = benchmark.discover_fonts(Path(r"C:\Windows\Fonts"))

    def test_render_is_deterministic_rgb_and_does_not_clip(self):
        first, metadata = benchmark.render_captcha("O0I1", self.fonts[0]["path"], 7, 3)
        second, _ = benchmark.render_captcha("O0I1", self.fonts[0]["path"], 7, 3)
        image = Image.open(__import__("io").BytesIO(first))

        self.assertEqual(first, second)
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(image.size, (120, 100))
        left, top, right, bottom = metadata["foreground_bbox"]
        self.assertGreater(left, 1)
        self.assertGreater(top, 1)
        self.assertLess(right, 119)
        self.assertLess(bottom, 99)


class AlphanumericSummaryTests(unittest.TestCase):
    def test_alignment_and_confusion_summary(self):
        summary = benchmark.summarize_predictions([
            {"expected": "O0I1", "predicted": "0011", "latency_ms": 1.0},
            {"expected": "Z2S5", "predicted": "Z2S5", "latency_ms": 2.0},
        ])

        self.assertEqual(summary["correct"], 1)
        self.assertEqual(summary["character_errors"], 2)
        self.assertIn(
            {"expected": "O", "predicted": "0", "count": 1},
            summary["top_confusions"],
        )
        self.assertIn(
            {"expected": "I", "predicted": "1", "count": 1},
            summary["top_confusions"],
        )

    def test_flags_are_fail_closed(self):
        flags = benchmark.benchmark_flags()
        self.assertTrue(flags["synthetic"])
        self.assertFalse(flags["release_evidence"])
        self.assertFalse(flags["may_enter_verified_training_data"])

    def test_label_coverage_preserves_all_characters(self):
        labels = benchmark.generate_balanced_labels(200, 20260820)
        coverage = benchmark.label_coverage(labels)
        self.assertEqual(sum(coverage["character_counts"].values()), 800)
        self.assertEqual(set(coverage["character_counts"]), set(benchmark.CHARSET))

    def test_nonempty_output_directory_is_rejected(self):
        with TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "existing.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "not empty"):
                benchmark.ensure_empty_output_dir(path)


if __name__ == "__main__":
    unittest.main()
