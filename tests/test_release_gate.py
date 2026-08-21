import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

import release_gate


class ReleaseGateTests(unittest.TestCase):
    def make_policy(self):
        return {
            "profiles": {
                "letters": {
                    "label_pattern": "^[A-Z]{4}$",
                    "required_character_classes": ["letters"],
                    "minimum_test_samples": 2,
                    "minimum_exact_accuracy": 0.95,
                    "minimum_character_accuracy": 0.98,
                    "maximum_no_answer_rate": 0.01,
                },
                "alphanumeric": {
                    "label_pattern": "^[A-Z0-9]{3,6}$",
                    "required_character_classes": ["letters", "digits"],
                    "minimum_test_samples": 2,
                    "minimum_exact_accuracy": 0.90,
                    "minimum_character_accuracy": 0.95,
                    "maximum_no_answer_rate": 0.02,
                    "minimum_occurrences_per_digit": 1,
                    "confusion_symbols": ["O", "0"],
                    "minimum_confusion_symbol_occurrences": 1,
                },
            }
        }

    def test_letter_profile_can_pass_while_digit_coverage_blocks_alphanumeric(self):
        manifest = {
            "entries": [
                {"split": "test", "label": "ABCD"},
                {"split": "test", "label": "EFGH"},
            ]
        }
        baseline = {
            "current": {
                "test": {
                    "count": 2,
                    "accuracy": 1.0,
                    "character_accuracy": 1.0,
                    "no_answer": 0,
                }
            }
        }

        result = release_gate.evaluate_release_readiness(manifest, baseline, self.make_policy())

        self.assertTrue(result["profiles"]["letters"]["passed"])
        self.assertFalse(result["profiles"]["alphanumeric"]["passed"])
        class_check = next(
            check
            for check in result["profiles"]["alphanumeric"]["checks"]
            if check["name"] == "required_character_classes"
        )
        self.assertFalse(class_check["passed"])
        self.assertFalse(result["github_release_ready"])

    def test_alphanumeric_requires_every_digit(self):
        labels = ["O0I1", "Z2S5", "G6B8", "3479"]
        manifest = {"entries": [{"split": "test", "label": label} for label in labels]}
        policy = self.make_policy()
        policy["profiles"]["alphanumeric"]["minimum_test_samples"] = 4
        baseline = {
            "current": {
                "test": {
                    "count": 4,
                    "accuracy": 1.0,
                    "character_accuracy": 1.0,
                    "no_answer": 0,
                }
            }
        }

        result = release_gate.evaluate_release_readiness(manifest, baseline, policy)

        self.assertTrue(result["profiles"]["alphanumeric"]["passed"])
        self.assertEqual(result["digit_counts"], {str(value): 1 for value in range(10)})

    def test_rejects_baseline_count_drift(self):
        with self.assertRaises(release_gate.ReleaseGateError):
            release_gate.evaluate_release_readiness(
                {"entries": [{"split": "test", "label": "ABCD"}]},
                {"current": {"test": {"count": 2}}},
                self.make_policy(),
            )


if __name__ == "__main__":
    unittest.main()
