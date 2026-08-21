import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WindowsLauncherTests(unittest.TestCase):
    def test_batch_files_use_windows_line_endings(self):
        batch_files = sorted(ROOT.glob("*.bat"))
        self.assertTrue(batch_files, "專案根目錄應包含批次檔")

        for batch_file in batch_files:
            with self.subTest(batch_file=batch_file.name):
                content = batch_file.read_bytes()
                self.assertIn(b"\r\n", content)
                self.assertNotIn(b"\n", content.replace(b"\r\n", b""))


if __name__ == "__main__":
    unittest.main()
