import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

import solver_oracle


class SolverOracleTests(unittest.TestCase):
    def test_analyze_result_finds_recoverable_ensemble_error(self):
        result = {
            "answer": "ABCU",
            "candidates": [{"answer": "ABCU"}, {"answer": "ABCD"}],
            "predictions": [
                {"solver": "official", "variant": "dark_primary", "answer": "ABCU", "preferred": True},
                {"solver": "official", "variant": "contrast", "answer": "ABCD"},
                {"solver": "universal", "variant": "dark_primary", "answer": "ABCD", "preferred": True},
            ],
        }

        analysis = solver_oracle.analyze_result("ABCD", result)

        self.assertFalse(analysis["ensemble_correct"])
        self.assertTrue(analysis["any_variant_correct"])
        self.assertEqual(analysis["candidate_rank"], 2)
        self.assertTrue(analysis["solver_any_correct"]["official"])
        self.assertFalse(analysis["solver_preferred_correct"]["official"])
        self.assertTrue(analysis["solver_preferred_correct"]["universal"])

    def test_analyze_result_handles_missing_predictions(self):
        analysis = solver_oracle.analyze_result("ABCD", {"answer": "ABCD"})

        self.assertTrue(analysis["ensemble_correct"])
        self.assertFalse(analysis["any_variant_correct"])
        self.assertEqual(analysis["solver_any_correct"], {})

    def test_total_vote_override_requires_support_and_margin(self):
        row = {
            "expected": "ABCD",
            "ensemble_answer": "ABCU",
            "candidates": [
                {"answer": "ABCU", "total_votes": 1, "preferred_votes": 1, "solver_votes": 1},
                {"answer": "ABCD", "total_votes": 5, "preferred_votes": 0, "solver_votes": 1},
            ],
        }

        self.assertEqual(solver_oracle.select_total_override(row, 2, 1), "ABCD")
        self.assertEqual(solver_oracle.select_total_override(row, 6, 1), "ABCU")

    def test_policy_reports_recovery_and_regression(self):
        rows = [
            {
                "expected": "ABCD",
                "ensemble_answer": "ABCU",
                "candidates": [
                    {"answer": "ABCU", "total_votes": 1},
                    {"answer": "ABCD", "total_votes": 4},
                ],
            },
            {
                "expected": "WXYZ",
                "ensemble_answer": "WXYZ",
                "candidates": [
                    {"answer": "WXYZ", "total_votes": 1},
                    {"answer": "WXYA", "total_votes": 3},
                ],
            },
        ]

        metrics = solver_oracle.evaluate_selector_policy(rows, 2, 1)

        self.assertEqual(metrics["correct"], 1)
        self.assertEqual(metrics["recoveries"], 1)
        self.assertEqual(metrics["regressions"], 1)
        self.assertEqual(metrics["changed"], 2)


if __name__ == "__main__":
    unittest.main()
