import hashlib
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

import fixed4_transfer


class Fixed4TransferTests(unittest.TestCase):
    def make_manifest(self, directory: Path):
        samples = directory / "samples"
        samples.mkdir()
        entries = []
        labels = ["ABCD", "EFGH", "IJKL", "MNOP", "QRST", "UVWX", "YZAB", "CDEF"]
        for index, label in enumerate(labels):
            split = "train" if index < 6 else ("validation" if index == 6 else "test")
            filename = f"sample-{index}.png"
            content = f"image-{index}".encode("ascii")
            (samples / filename).write_bytes(content)
            entries.append({
                "image_file": filename,
                "image_sha256": hashlib.sha256(content).hexdigest(),
                "label": label,
                "split": split,
            })
        manifest = {
            "seed": 7,
            "unique_verified_images": len(entries),
            "split_counts": {"train": 6, "validation": 1, "test": 1},
            "invalid_records": [],
            "label_conflicts": [],
            "entries": entries,
        }
        manifest_path = directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path, samples

    def test_prepare_is_deterministic_and_excludes_external_splits(self):
        with TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            manifest, samples = self.make_manifest(directory)
            first = directory / "first"
            second = directory / "second"

            fixed4_transfer.prepare_dataset(manifest, samples, first, seed=11, validation_count=2)
            fixed4_transfer.prepare_dataset(manifest, samples, second, seed=11, validation_count=2)

            first_index = json.loads((first / "dataset.json").read_text(encoding="utf-8"))
            second_index = json.loads((second / "dataset.json").read_text(encoding="utf-8"))
            self.assertEqual(first_index["entries"], second_index["entries"])
            self.assertEqual(first_index["internal_counts"], {"train": 4, "validation": 2})
            self.assertEqual(len(list((first / "images").iterdir())), 6)
            self.assertFalse((first / "images" / "sample-6.png").exists())
            self.assertFalse((first / "images" / "sample-7.png").exists())
            self.assertEqual(first_index["isolation"]["training_external_hash_intersection"], 0)

    def test_fixed4_rejects_variable_length_or_non_uppercase_labels(self):
        with self.assertRaises(fixed4_transfer.Fixed4TransferError):
            fixed4_transfer.validate_fixed4_entries([{"label": "ABC"}])
        with self.assertRaises(fixed4_transfer.Fixed4TransferError):
            fixed4_transfer.validate_fixed4_entries([{"label": "AB1D"}])

    def test_metrics_count_exact_and_character_accuracy(self):
        metrics = fixed4_transfer.predictions_to_metrics(["ABCD", "WXYZ"], ["ABCD", "WXYA"])

        self.assertEqual(metrics["correct"], 1)
        self.assertEqual(metrics["accuracy"], 0.5)
        self.assertEqual(metrics["correct_characters"], 7)
        self.assertEqual(metrics["character_accuracy"], 0.875)

    def test_label_indices_are_stable_alphabetical_positions(self):
        self.assertEqual(fixed4_transfer.label_to_indices("AZBY"), [0, 25, 1, 24])


if __name__ == "__main__":
    unittest.main()
