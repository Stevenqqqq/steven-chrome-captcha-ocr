import json
from pathlib import Path
import subprocess
import unittest

import numpy as np
from PIL import Image, ImageDraw

from fusion_ocr import Fixed4FusionOcr


ROOT = Path(__file__).resolve().parents[1]
NODE = """
const fs = require('node:fs');
const {resizeRgbBilinear, rgbToChwFloat32} = require('./extension/browser_ocr.js');
const {pixels, w, h, dw, dh} = JSON.parse(fs.readFileSync(0, 'utf8'));
const rgb = resizeRgbBilinear(Uint8Array.from(pixels), w, h, dw, dh, 3);
const tensor = norm => Array.from(rgbToChwFloat32(rgb, dw, dh, norm));
process.stdout.write(JSON.stringify([Array.from(rgb), tensor(false), tensor(true)]));
"""


class BrowserParity(unittest.TestCase):
    def test_ordinary_text_rgb_and_tensor(self):
        image = Image.new("RGB", (121, 43), (231, 225, 218))
        ImageDraw.Draw(image).text((7, 8), "Library hours", fill=(17, 47, 83))
        for width, height in ((53, 17), (135, 67), (121, 43), (1, 1)):
            with self.subTest(size=(width, height)):
                payload = dict(pixels=list(image.tobytes()), w=image.width, h=image.height,
                               dw=width, dh=height)
                proc = subprocess.run(["node", "-e", NODE], input=json.dumps(payload),
                                      cwd=ROOT, capture_output=True, text=True, check=True)
                rgb, plain, normalized = json.loads(proc.stdout)
                reference = image.resize((width, height), Image.Resampling.BILINEAR)
                pixel_delta = np.max(np.abs(np.array(rgb) - np.asarray(reference).ravel()))
                self.assertEqual(pixel_delta, 0)
                tensor_deltas = []
                for normalize, actual in ((False, plain), (True, normalized)):
                    expected = Fixed4FusionOcr._image_tensor(image, (height, width), normalize)
                    delta = np.max(np.abs(expected.ravel() - np.array(actual)))
                    self.assertLessEqual(delta, 1e-5)
                    tensor_deltas.append(float(delta))
                print(f"{width}x{height} max RGB={pixel_delta}, CHW={tensor_deltas}")
