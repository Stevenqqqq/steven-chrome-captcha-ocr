import hashlib
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

import trial_pipeline


class TrialPipelineTests(unittest.TestCase):
    def make_dataset(self, directory: Path):
        samples = directory / "samples"
        samples.mkdir()
        entries = []
        labels = (("train.png", "ABCD", "train"), ("validation.png", "EFGH", "validation"), ("test.png", "IJKL", "test"))
        for filename, label, split in labels:
            content = f"image:{filename}".encode("ascii")
            (samples / filename).write_bytes(content)
            entries.append({
                "image_file": filename,
                "image_sha256": hashlib.sha256(content).hexdigest(),
                "label": label,
                "split": split,
            })
        manifest = {
            "seed": 20260809,
            "unique_verified_images": 3,
            "split_counts": {"train": 1, "validation": 1, "test": 1},
            "invalid_records": [],
            "label_conflicts": [],
            "ready_for_trial_training": True,
            "entries": entries,
        }
        manifest_path = directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path, samples

    def test_prepare_exports_only_training_split(self):
        with TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            manifest, samples = self.make_dataset(directory)
            output = directory / "output"

            result = trial_pipeline.prepare_trainer_dataset(manifest, samples, output)

            self.assertEqual(result["exported_count"], 1)
            self.assertEqual((output / "labels.txt").read_text(encoding="utf-8"), "train.png\tABCD\n")
            self.assertTrue((output / "images" / "train.png").is_file())
            self.assertFalse((output / "images" / "validation.png").exists())
            self.assertFalse((output / "images" / "test.png").exists())
            provenance = json.loads((output / "provenance.json").read_text(encoding="utf-8"))
            self.assertEqual(provenance["held_out_counts"], {"validation": 1, "test": 1})

    def test_prepare_rejects_a_hash_mismatch(self):
        with TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            manifest, samples = self.make_dataset(directory)
            (samples / "train.png").write_bytes(b"tampered")

            with self.assertRaisesRegex(trial_pipeline.TrialPipelineError, "雜湊不符"):
                trial_pipeline.prepare_trainer_dataset(manifest, samples, directory / "output")

    def test_trial_gate_never_authorizes_production_replacement(self):
        current = {
            "validation": {"accuracy": 0.7, "no_answer": 1},
            "test": {"accuracy": 0.6, "no_answer": 1},
        }
        candidate = {
            "validation": {"accuracy": 0.8, "no_answer": 0},
            "test": {"accuracy": 0.7, "no_answer": 0},
        }

        gate = trial_pipeline.trial_gate(current, candidate)

        self.assertTrue(gate["promising_trial_candidate"])
        self.assertFalse(gate["may_replace_production_model"])

    def test_edit_distance_counts_a_missing_character_once(self):
        self.assertEqual(trial_pipeline.edit_distance("FEK", "FEKY"), 1)
        self.assertEqual(trial_pipeline.edit_distance("ABCD", "ABCD"), 0)
        self.assertEqual(trial_pipeline.edit_distance("O", "0"), 1)

    def test_evaluate_predictor_summarizes_active_learning_priority(self):
        with TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            manifest_path, samples = self.make_dataset(directory)
            manifest = trial_pipeline.load_manifest(manifest_path)
            entries = [entry for entry in manifest["entries"] if entry["split"] == "validation"]

            def predictor(_image_bytes, _expected_length):
                return {
                    "answer": "EFGH",
                    "active_learning": {
                        "priority": "high",
                        "reasons": ["variant_disagreement"],
                        "save_if_site_accepted": True,
                        "recommended_sample_rate": 1.0,
                    },
                }

            result = trial_pipeline.evaluate_predictor("fixture", predictor, entries, samples)

            self.assertEqual(result["active_learning"]["priority_counts"], {"high": 1})
            self.assertEqual(result["active_learning"]["recommended_for_collection"], 1)
            self.assertEqual(result["active_learning"]["recommended_sample_equivalent"], 1.0)
            self.assertEqual(result["active_learning"]["reason_counts"], {"variant_disagreement": 1})
            self.assertEqual(result["character_count"], 4)
            self.assertEqual(result["character_errors"], 0)
            self.assertEqual(result["character_accuracy"], 1.0)


if __name__ == "__main__":
    unittest.main()
