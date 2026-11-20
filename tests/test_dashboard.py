import sys
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "training"))

import dashboard
import ocr_server


class DashboardTests(unittest.TestCase):
    def _png(self, color):
        buf = BytesIO()
        Image.new("RGB", (80, 32), color).save(buf, format="PNG")
        return buf.getvalue()

    def test_collects_confusions_and_renders_self_contained_html(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = ocr_server.FeedbackStore(root)
            rid1 = store.remember(
                self._png("white"),
                expected_length=4,
                result={"answer": "A7OK", "candidates": [], "predictions": []},
            )
            store.confirm(rid1, "A70K")
            rid2 = store.remember(
                self._png("black"),
                expected_length=4,
                result={"answer": "PIVU", "candidates": [], "predictions": []},
            )
            store.confirm(rid2, "PIVA")

            data = dashboard.collect_dashboard_data(root)
            rendered = dashboard.render_dashboard_html(data)

            self.assertEqual(data["manifest_summary"]["unique_verified_images"], 2)
            self.assertEqual(data["digits"]["0"], 1)
            self.assertEqual(data["digits"]["7"], 1)
            self.assertIn(("0 → O", 1), data["top_confusions"])
            self.assertIn(("A → U", 1), data["top_confusions"])
            self.assertIn("Steven OCR · 資料集與錯題審查儀表板", rendered)
            self.assertIn("A70K", rendered)
            self.assertIn("0 → O", rendered)


if __name__ == "__main__":
    unittest.main()
