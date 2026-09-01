import json
import threading
import unittest
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

import ocr_server


_test_image_output = BytesIO()
Image.new("RGB", (120, 40), "white").save(_test_image_output, format="PNG")
TEST_IMAGE_BYTES = _test_image_output.getvalue()


class FakeEngine:
    names = ["official", "universal", "tixcraft_tm"]
    last_expected_length = None

    def load(self):
        return self

    def recognize(self, image_bytes, expected_length=None):
        if image_bytes != TEST_IMAGE_BYTES:
            raise ocr_server.OcrError("unexpected image")
        self.last_expected_length = expected_length
        answer = "A7K2"
        return {
            "answer": answer,
            "solver_votes": 2,
            "total_votes": 4,
            "solver_count": 3,
            "candidates": [],
            "predictions": [],
            "expected_length": expected_length,
            "length_match": expected_length is None or len(answer) == expected_length,
        }


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_engine = ocr_server.ENGINE
        cls.original_feedback_store = ocr_server.FEEDBACK_STORE
        cls.feedback_directory = TemporaryDirectory()
        ocr_server.ENGINE = FakeEngine()
        ocr_server.FEEDBACK_STORE = ocr_server.FeedbackStore(Path(cls.feedback_directory.name))
        cls.server = ocr_server.OcrHttpServer(("127.0.0.1", 0), ocr_server.OcrRequestHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        ocr_server.ENGINE = cls.original_engine
        ocr_server.FEEDBACK_STORE = cls.original_feedback_store
        cls.feedback_directory.cleanup()

    def request(self, path, data=None, origin="chrome-extension://unit-test", content_type="image/png"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method="POST" if data is not None else "GET",
            headers={"Origin": origin, "Content-Type": content_type},
        )
        return urllib.request.urlopen(request, timeout=5)

    def test_health_lists_all_three_solvers(self):
        with self.request("/health") as response:
            payload = json.load(response)
            self.assertEqual(payload["solvers"], FakeEngine.names)
            self.assertEqual(payload["version"], 6)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "chrome-extension://unit-test")

    def test_recognize_returns_answer(self):
        with self.request("/recognize", TEST_IMAGE_BYTES) as response:
            payload = json.load(response)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["answer"], "A7K2")
            self.assertRegex(payload["report_id"], r"^[0-9a-f]{32}$")

    def test_feedback_saves_the_original_recognition_with_a_correct_label(self):
        with self.request("/recognize?expectedLength=4", TEST_IMAGE_BYTES) as response:
            recognition = json.load(response)

        body = json.dumps({
            "reportId": recognition["report_id"],
            "correctAnswer": "B8M3",
        }).encode("utf-8")
        with self.request("/feedback", body, content_type="application/json") as response:
            payload = json.load(response)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["image_file"].startswith("B8M3__"))
        self.assertEqual(len(list(Path(self.feedback_directory.name, "samples").glob("*.png"))), 1)

    def test_feedback_rejects_a_missing_or_invalid_report_id(self):
        body = json.dumps({
            "reportId": "../not-a-ticket",
            "correctAnswer": "B8M3",
        }).encode("utf-8")
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request("/feedback", body, content_type="application/json")

        self.assertEqual(context.exception.code, 422)

    def test_verified_sample_requires_site_acceptance_and_records_its_source(self):
        original_store = ocr_server.FEEDBACK_STORE
        with TemporaryDirectory() as directory:
            ocr_server.FEEDBACK_STORE = ocr_server.FeedbackStore(Path(directory))
            try:
                with self.request("/recognize?expectedLength=4", TEST_IMAGE_BYTES) as response:
                    recognition = json.load(response)

                rejected_body = json.dumps({
                    "reportId": recognition["report_id"],
                    "correctAnswer": "A7K2",
                    "source": "toolweb_practice",
                    "siteAccepted": False,
                }).encode("utf-8")
                with self.assertRaises(urllib.error.HTTPError) as context:
                    self.request("/verified-sample", rejected_body, content_type="application/json")
                self.assertEqual(context.exception.code, 422)

                accepted_body = json.dumps({
                    "reportId": recognition["report_id"],
                    "correctAnswer": "A7K2",
                    "source": "toolweb_practice",
                    "siteAccepted": True,
                    "evidence": {
                        "captchaChanged": True,
                        "attemptsBefore": 20,
                        "attemptsAfter": 21,
                    },
                }).encode("utf-8")
                with self.request("/verified-sample", accepted_body, content_type="application/json") as response:
                    saved = json.load(response)
            finally:
                ocr_server.FEEDBACK_STORE = original_store

            self.assertTrue(saved["ok"])
            metadata = json.loads(
                next(Path(directory, "feedback").glob("*.json")).read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["source"], "toolweb_practice")
            self.assertEqual(metadata["verification"], "site_accepted")
            self.assertEqual(metadata["verification_evidence"]["attempts_after"], 21)

    def test_recognize_passes_a_valid_expected_length_to_the_engine(self):
        with self.request("/recognize?expectedLength=4", TEST_IMAGE_BYTES) as response:
            payload = json.load(response)

        self.assertTrue(payload["ok"])
        self.assertEqual(ocr_server.ENGINE.last_expected_length, 4)

    def test_length_mismatch_still_returns_a_report_id_for_manual_feedback(self):
        original_recognize = ocr_server.ENGINE.recognize
        ocr_server.ENGINE.recognize = lambda image_bytes, expected_length=None: {
            "answer": "WNE",
            "solver_votes": 1,
            "total_votes": 6,
            "solver_count": 3,
            "candidates": [{"answer": "WNE", "solver_votes": 1, "total_votes": 6}],
            "predictions": [],
            "expected_length": expected_length,
            "length_match": False,
        }
        try:
            with self.request("/recognize?expectedLength=4", TEST_IMAGE_BYTES) as response:
                payload = json.load(response)
        finally:
            ocr_server.ENGINE.recognize = original_recognize

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["answer"], "WNE")
        self.assertFalse(payload["length_match"])
        self.assertRegex(payload["report_id"], r"^[0-9a-f]{32}$")

    def test_recognize_rejects_an_invalid_expected_length(self):
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request("/recognize?expectedLength=999", b"test-image")

        self.assertEqual(context.exception.code, 422)

    def test_regular_web_origin_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request("/health", origin="https://example.com")
        self.assertEqual(context.exception.code, 403)


class ServerLifecycleTests(unittest.TestCase):
    def test_prevents_two_ocr_versions_from_sharing_the_same_port(self):
        self.assertFalse(ocr_server.OcrHttpServer.allow_reuse_address)

    def test_running_service_probe_requires_matching_api_version(self):
        class Response:
            status = 200

            def __init__(self, version):
                self.version = version

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _limit):
                return json.dumps({"ok": True, "version": self.version}).encode("utf-8")

        with patch("ocr_server.urllib.request.urlopen", return_value=Response(ocr_server.API_VERSION)):
            self.assertTrue(ocr_server.matching_service_is_running())
        with patch("ocr_server.urllib.request.urlopen", return_value=Response(ocr_server.API_VERSION - 1)):
            self.assertFalse(ocr_server.matching_service_is_running())


if __name__ == "__main__":
    unittest.main()
