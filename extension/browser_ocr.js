(function (root, factory) {
  const api = factory();
  root.BrowserOcr = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const NEG_INF = -Infinity;

  function dimension(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Invalid image dimension");
  }

  function checkPixels(bytes, width, height, channels) {
    dimension(width);
    dimension(height);
    if (
      !(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray)
      || bytes.length !== width * height * channels
    ) {
      throw new RangeError("Unexpected pixel buffer");
    }
  }

  // Pillow widens the triangle filter for downsampling and rounds each pass to bytes.
  const precision = 2 ** 22;
  function coefficients(source, destination) {
    const scale = source / destination;
    const radius = Math.max(1, scale);
    return Array.from({ length: destination }, (_, index) => {
      const center = (index + 0.5) * scale;
      const start = Math.max(0, Math.floor(center - radius + 0.5));
      const end = Math.min(source, Math.floor(center + radius + 0.5));
      const weights = Array.from({ length: end - start }, (_, offset) =>
        Math.max(0, 1 - Math.abs((start + offset - center + 0.5) * (1 / radius))));
      const total = weights.reduce((a, b) => a + b, 0);
      return { start, weights: weights.map((w) => Math.round((w / total) * precision)) };
    });
  }

  function sample(bytes, base, stride, weights) {
    let sum = precision / 2;
    for (let k = 0; k < weights.length; k++) sum += bytes[base + k * stride] * weights[k];
    return Math.min(255, Math.floor(sum / precision));
  }

  function resizeRgbBilinear(pixels, srcWidth, srcHeight, dstWidth, dstHeight, channels = 4) {
    if (channels !== 3 && channels !== 4) throw new RangeError("Expected RGB or RGBA");
    checkPixels(pixels, srcWidth, srcHeight, channels);
    dimension(dstWidth);
    dimension(dstHeight);
    const horizontal = coefficients(srcWidth, dstWidth);
    const vertical = coefficients(srcHeight, dstHeight);
    const tmp = new Uint8Array(dstWidth * srcHeight * 3);
    const out = new Uint8Array(dstWidth * dstHeight * 3);
    for (let y = 0; y < srcHeight; y++) {
      horizontal.forEach(({ start, weights }, x) => {
        const base = (y * srcWidth + start) * channels;
        for (let c = 0; c < 3; c++) {
          tmp[(y * dstWidth + x) * 3 + c] = sample(pixels, base + c, channels, weights);
        }
      });
    }
    const stride = dstWidth * 3;
    vertical.forEach(({ start, weights }, y) => {
      for (let i = 0; i < stride; i++) {
        out[y * stride + i] = sample(tmp, start * stride + i, stride, weights);
      }
    });
    return out;
  }

  function rgbToChwFloat32(rgbBytes, width, height, normalizeImageNet = false) {
    checkPixels(rgbBytes, width, height, 3);
    const plane = width * height;
    const out = new Float32Array(3 * plane);
    const mean = Float32Array.of(0.485, 0.456, 0.406);
    const std = Float32Array.of(0.229, 0.224, 0.225);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < plane; i++) {
        const value = Math.fround(rgbBytes[i * 3 + c] / 255);
        out[c * plane + i] = normalizeImageNet ? Math.fround(value - mean[c]) / std[c] : value;
      }
    }
    return out;
  }

  function rgbaToRgb(pixels, width, height, channels = 4) {
    if (channels === 3) {
      checkPixels(pixels, width, height, 3);
      return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    }
    checkPixels(pixels, width, height, 4);
    const out = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
      out[j] = pixels[i];
      out[j + 1] = pixels[i + 1];
      out[j + 2] = pixels[i + 2];
    }
    return out;
  }

  function rgbToGrayscaleBytes(rgbBytes, width, height) {
    checkPixels(rgbBytes, width, height, 3);
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) {
      // Pillow BT.601 integer approximation: (R * 19595 + G * 38470 + B * 7471 + 32768) >> 16
      out[i] = (rgbBytes[i * 3] * 19595 + rgbBytes[i * 3 + 1] * 38470 + rgbBytes[i * 3 + 2] * 7471 + 32768) >> 16;
    }
    return out;
  }

  function computeMedianLuminance(grayBytes) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < grayBytes.length; i++) hist[grayBytes[i]] += 1;
    const midpoint = Math.floor((grayBytes.length + 1) / 2);
    let running = 0;
    for (let lum = 0; lum < 256; lum++) {
      running += hist[lum];
      if (running >= midpoint) return lum;
    }
    return 255;
  }

  function histogramMedian(hist, midpoint) {
    let running = 0;
    for (let v = 0; v < 256; v++) {
      running += hist[v];
      if (running >= midpoint) return v;
    }
    return 255;
  }

  function isBlueBackground(rgbBytes, width, height) {
    checkPixels(rgbBytes, width, height, 3);
    const n = width * height;
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      histR[rgbBytes[i * 3]] += 1;
      histG[rgbBytes[i * 3 + 1]] += 1;
      histB[rgbBytes[i * 3 + 2]] += 1;
    }
    const midpoint = Math.floor((n + 1) / 2);
    const medR = histogramMedian(histR, midpoint);
    const medG = histogramMedian(histG, midpoint);
    const medB = histogramMedian(histB, midpoint);
    return medB >= 140 && (medB - medR) >= 60 && (medB - medG) >= 30;
  }

  function alignedCharMatches(shortOrFour, four) {
    const a = String(shortOrFour || "");
    const b = String(four || "");
    if (b.length !== 4) return 0;
    if (a.length === 4) {
      let matches = 0;
      for (let i = 0; i < 4; i++) if (a[i] === b[i]) matches += 1;
      return matches;
    }
    if (a.length === 3) {
      let best = 0;
      for (let skip = 0; skip < 4; skip++) {
        const sub = b.slice(0, skip) + b.slice(skip + 1);
        let matches = 0;
        for (let i = 0; i < 3; i++) if (a[i] === sub[i]) matches += 1;
        if (matches > best) best = matches;
      }
      return best;
    }
    return 0;
  }

  function grayToRgbBytes(grayBytes) {
    const out = new Uint8Array(grayBytes.length * 3);
    for (let i = 0; i < grayBytes.length; i++) {
      const v = grayBytes[i];
      out[i * 3] = v;
      out[i * 3 + 1] = v;
      out[i * 3 + 2] = v;
    }
    return out;
  }

  function enhanceDarkPrimaryRgb(grayBytes, width, height) {
    // Mirrors ocr_server.py dark_primary: invert -> autocontrast -> MaxFilter(3)
    const n = grayBytes.length;
    const inv = new Uint8Array(n);
    let minV = 255;
    let maxV = 0;
    for (let i = 0; i < n; i++) {
      const v = 255 - grayBytes[i];
      inv[i] = v;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const auto = new Uint8Array(n);
    if (maxV > minV) {
      const scale = 255 / (maxV - minV);
      for (let i = 0; i < n; i++) auto[i] = Math.round((inv[i] - minV) * scale);
    } else {
      auto.set(inv);
    }
    const dilated = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(width - 1, x + 1);
        let best = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const val = auto[yy * width + xx];
            if (val > best) best = val;
          }
        }
        dilated[y * width + x] = best;
      }
    }
    return grayToRgbBytes(dilated);
  }

  function enhanceLightContrastRgb(grayBytes, factor = 2.4) {
    const n = grayBytes.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += grayBytes[i];
    const mean = sum / Math.max(1, n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.round(mean + (grayBytes[i] - mean) * factor);
      out[i] = Math.max(0, Math.min(255, v));
    }
    return grayToRgbBytes(out);
  }

  function resizeGrayscaleUnit01(rgbBytes, srcWidth, srcHeight, targetHeight = 64) {
    // Mirrors ddddocr._preprocess_image: resize to (int(w * 64 / h), 64), convert to grayscale, / 255.0
    const targetWidth = Math.max(1, Math.floor(srcWidth * (targetHeight / srcHeight)));
    const resizedRgb = resizeRgbBilinear(rgbBytes, srcWidth, srcHeight, targetWidth, targetHeight, 3);
    const gray = rgbToGrayscaleBytes(resizedRgb, targetWidth, targetHeight);
    const tensor = new Float32Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      tensor[i] = gray[i] / 255.0;
    }
    return { tensor, width: targetWidth, height: targetHeight };
  }

  function cropHorizontalSegment(rgbBytes, width, height, position, segments = 4, marginRatio = 0.32) {
    checkPixels(rgbBytes, width, height, 3);
    const segment = width / segments;
    const margin = segment * marginRatio;
    const left = Math.max(0, Math.round(position * segment - margin));
    const right = Math.min(width, Math.round((position + 1) * segment + margin));
    const cropWidth = Math.max(1, right - left);
    const out = new Uint8Array(cropWidth * height * 3);
    for (let y = 0; y < height; y++) {
      const srcStart = (y * width + left) * 3;
      const dstStart = y * cropWidth * 3;
      out.set(rgbBytes.subarray(srcStart, srcStart + cropWidth * 3), dstStart);
    }
    return { rgb: out, width: cropWidth, height, left, right };
  }

  function resizeGrayscaleChw(pixels, srcWidth, srcHeight, targetHeight = 64, channels = 4) {
    const targetWidth = Math.max(1, Math.round(srcWidth * (targetHeight / srcHeight)));
    const rgb = resizeRgbBilinear(pixels, srcWidth, srcHeight, targetWidth, targetHeight, channels);
    const out = new Float32Array(targetWidth * targetHeight);
    for (let i = 0; i < out.length; i++) {
      const gray = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      out[i] = (gray / 255 - 0.5) / 0.5;
    }
    return { tensor: out, width: targetWidth, height: targetHeight };
  }

  function softmaxRows(logits, rows, cols) {
    const probs = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const offset = r * cols;
      let maxVal = NEG_INF;
      for (let c = 0; c < cols; c++) {
        if (logits[offset + c] > maxVal) maxVal = logits[offset + c];
      }
      let sum = 0;
      for (let c = 0; c < cols; c++) {
        const exp = Math.exp(logits[offset + c] - maxVal);
        probs[offset + c] = exp;
        sum += exp;
      }
      for (let c = 0; c < cols; c++) {
        probs[offset + c] /= sum || 1;
      }
    }
    return probs;
  }

  function logAdd(a, b) {
    if (a === NEG_INF) return b;
    if (b === NEG_INF) return a;
    const m = a > b ? a : b;
    return m + Math.log1p(Math.exp(-Math.abs(a - b)));
  }

  function isCharAllowed(character, charsetHint) {
    if (charsetHint === "digits") return /^[0-9]$/.test(character);
    if (charsetHint === "letters") return /^[A-Za-z]$/.test(character);
    return /^[0-9A-Za-z]$/.test(character);
  }

  function ctcPrefixBeamAscii(logits, dims, asciiEntries, options = {}) {
    const charsetHint = options.charsetHint || "alphanumeric";
    const caseSensitive = Boolean(options.caseSensitive);
    const blankIndex = Number(options.blankIndex ?? 0);
    const expectedLength = options.expectedLength ?? null;
    const lengthMode = options.lengthMode || "exact";
    const beamWidth = Number(options.beamWidth || 24);
    const maxLen = expectedLength && lengthMode !== "unknown" ? Math.min(6, expectedLength) : 6;

    const T = dims[0] === 1 && dims.length === 3 ? dims[1] : dims[0];
    const C = dims[dims.length - 1];

    // Group ASCII indices by emitted character (folding case when caseSensitive is false).
    const charGroups = new Map();
    for (const entry of asciiEntries) {
      const rawChar = String(entry.char || "");
      if (!isCharAllowed(rawChar, charsetHint)) continue;
      const key = caseSensitive ? rawChar : rawChar.toUpperCase();
      if (!charGroups.has(key)) charGroups.set(key, []);
      charGroups.get(key).push(entry.index);
    }
    const symbols = Array.from(charGroups.entries());

    // Track per-timestep log-probs restricted to [blank, ...allowed ascii] so non-ASCII classes
    // never steal probability mass or emit garbage.
    let beams = new Map([["", [0, NEG_INF]]]);
    const timestepStats = [];

    for (let t = 0; t < T; t++) {
      const base = t * C;
      let maxL = logits[base + blankIndex];
      for (const [, indices] of symbols) {
        for (const idx of indices) {
          const v = logits[base + idx];
          if (v > maxL) maxL = v;
        }
      }
      let expSum = Math.exp(logits[base + blankIndex] - maxL);
      const symLogProbs = [];
      let topSym = "";
      let topSymProb = 0;
      let secondSym = "";
      let secondSymProb = 0;

      for (const [sym, indices] of symbols) {
        let symExp = 0;
        for (const idx of indices) {
          symExp += Math.exp(logits[base + idx] - maxL);
        }
        expSum += symExp;
        symLogProbs.push([sym, symExp]);
      }
      const logZ = maxL + Math.log(expSum || 1);
      const blankLog = logits[base + blankIndex] - logZ;
      const charLogs = [];
      for (const [sym, symExp] of symLogProbs) {
        const prob = symExp / (expSum || 1);
        const lp = Math.log(Math.max(prob, 1e-12));
        charLogs.push([sym, lp]);
        if (prob > topSymProb) {
          secondSym = topSym;
          secondSymProb = topSymProb;
          topSym = sym;
          topSymProb = prob;
        } else if (prob > secondSymProb) {
          secondSym = sym;
          secondSymProb = prob;
        }
      }
      timestepStats.push({
        blankProb: Math.exp(blankLog),
        topSym,
        topSymProb,
        secondSym,
        secondSymProb,
      });

      const nextBeams = new Map();
      const addBeam = (prefix, pb, pnb) => {
        const cur = nextBeams.get(prefix);
        if (cur) {
          cur[0] = logAdd(cur[0], pb);
          cur[1] = logAdd(cur[1], pnb);
        } else {
          nextBeams.set(prefix, [pb, pnb]);
        }
      };

      for (const [prefix, [pb, pnb]] of beams.entries()) {
        const total = logAdd(pb, pnb);
        addBeam(prefix, total + blankLog, NEG_INF);
        const lastChar = prefix.length ? prefix[prefix.length - 1] : "";
        for (const [sym, symLog] of charLogs) {
          if (sym === lastChar) {
            addBeam(prefix, NEG_INF, pnb + symLog);
            if (prefix.length < maxLen) {
              addBeam(prefix + sym, NEG_INF, pb + symLog);
            }
          } else if (prefix.length < maxLen) {
            addBeam(prefix + sym, NEG_INF, total + symLog);
          }
        }
      }

      const ranked = Array.from(nextBeams.entries())
        .map(([prefix, scores]) => [prefix, scores, logAdd(scores[0], scores[1])])
        .sort((a, b) => b[2] - a[2])
        .slice(0, beamWidth);
      beams = new Map(ranked.map(([prefix, scores]) => [prefix, scores]));
    }

    const allCandidates = Array.from(beams.entries())
      .map(([text, [pb, pnb]]) => ({ text, logProb: logAdd(pb, pnb) }))
      .filter((item) => item.text.length >= 3 && item.text.length <= 6)
      .sort((a, b) => b.logProb - a.logProb);

    let filtered = allCandidates;
    if (expectedLength && lengthMode === "exact") {
      const exact = allCandidates.filter((c) => c.text.length === expectedLength);
      if (exact.length) filtered = exact;
    } else if (expectedLength && lengthMode === "max") {
      const bounded = allCandidates.filter((c) => c.text.length <= expectedLength);
      if (bounded.length) filtered = bounded;
    }

    if (!filtered.length) {
      return {
        answer: "",
        confidence: 0,
        char_confidences: [],
        top_candidates: [],
        candidates: [],
      };
    }

    const top3Raw = filtered.slice(0, 3);
    const maxScore = top3Raw[0].logProb;
    let relSum = 0;
    const relWeights = top3Raw.map((item) => {
      const w = Math.exp(Math.max(-40, item.logProb - maxScore));
      relSum += w;
      return w;
    });

    const answer = top3Raw[0].text;
    const rawConfidence = Math.min(0.999, Math.max(0.01, Math.exp(top3Raw[0].logProb)));
    const topCandidates = top3Raw.map((item, idx) => ({
      answer: item.text,
      confidence: Number(((relWeights[idx] / (relSum || 1)) * Math.min(1, rawConfidence + 0.15)).toFixed(4)),
      solver_votes: 1,
      total_votes: 1,
    }));

    // Extract per-character confidences & alternatives from CTC peak frames + runner-up candidates.
    const charPeaks = [];
    let prevEmit = "";
    for (const stat of timestepStats) {
      if (stat.topSymProb > stat.blankProb && stat.topSym) {
        if (stat.topSym !== prevEmit) {
          charPeaks.push({
            char: stat.topSym,
            confidence: stat.topSymProb,
            alt: stat.secondSymProb > 0.05 ? stat.secondSym : "",
          });
        } else if (charPeaks.length && stat.topSymProb > charPeaks[charPeaks.length - 1].confidence) {
          charPeaks[charPeaks.length - 1].confidence = stat.topSymProb;
        }
        prevEmit = stat.topSym;
      } else {
        prevEmit = "";
      }
    }

    const runnerUp = topCandidates.find((c) => c.answer !== answer && c.answer.length === answer.length)?.answer || "";
    const charConfidences = answer.split("").map((ch, idx) => {
      const peak = charPeaks[idx]?.char === ch ? charPeaks[idx] : null;
      const alts = [];
      if (runnerUp && runnerUp[idx] !== ch) alts.push(runnerUp[idx]);
      if (peak?.alt && peak.alt !== ch && !alts.includes(peak.alt)) alts.push(peak.alt);
      const conf = peak ? peak.confidence : rawConfidence;
      return {
        char: ch,
        confidence: Number(Math.min(0.999, Math.max(0.05, conf)).toFixed(4)),
        alternatives: alts.slice(0, 2),
      };
    });

    const result = {
      answer,
      confidence: Number(rawConfidence.toFixed(4)),
      char_confidences: charConfidences,
      top_candidates: topCandidates,
      candidates: topCandidates,
    };
    if (options.includeBeams) {
      result.raw_beams = filtered.slice(0, 10);
    }
    return result;
  }

  function fuseOfficialAndFixed4(
    officialBeams4,
    directProbs,
    cropProbs,
    charset = DEFAULT_CHARSET,
    options = {},
  ) {
    const charsetHint = options.charsetHint || "letters";
    const wOfficial = Number(options.wOfficial ?? 1.0);
    const wDirect = Number(options.wDirect ?? 1.0);
    const wCrop = Number(options.wCrop ?? 1.0);
    const floorLogProb = Number(options.floorLogProb ?? -12.0);
    const cols = charset.length;
    const positions = 4;
    const eps = 1e-12;

    const charToIndex = new Map();
    for (let c = 0; c < cols; c++) {
      if (isCharAllowed(charset[c], charsetHint)) {
        charToIndex.set(charset[c], c);
      }
    }

    // Collect top-6 beam candidates from direct * crop over allowed characters.
    let dcBeams = [{ text: "", score: 0 }];
    const posTopChars = [];
    for (let pos = 0; pos < positions; pos++) {
      const offset = pos * cols;
      const ranked = [];
      for (const [ch, c] of charToIndex.entries()) {
        const dProb = Math.max(directProbs[offset + c] || 0, eps);
        const cProb = Math.max(cropProbs[offset + c] || 0, eps);
        ranked.push({
          char: ch,
          score: wDirect * Math.log(dProb) + wCrop * Math.log(cProb),
        });
      }
      ranked.sort((a, b) => b.score - a.score);
      const topChars = ranked.slice(0, 4);
      posTopChars.push(topChars);
      const next = [];
      for (const beam of dcBeams) {
        for (const item of topChars) {
          next.push({ text: beam.text + item.char, score: beam.score + item.score });
        }
      }
      next.sort((a, b) => b.score - a.score);
      dcBeams = next.slice(0, 8);
    }

    const officialMap = new Map();
    const pool = [];
    const seen = new Set();
    const validWord = (w) => typeof w === "string" && w.length === 4 && [...w].every((ch) => charToIndex.has(ch));

    for (const item of officialBeams4 || []) {
      const text = item?.text;
      if (!validWord(text)) continue;
      if (!officialMap.has(text)) officialMap.set(text, Number(item.logProb));
      if (!seen.has(text) && pool.length < 8) {
        seen.add(text);
        pool.push(text);
      }
    }
    for (const beam of dcBeams.slice(0, 6)) {
      if (validWord(beam.text) && !seen.has(beam.text)) {
        seen.add(beam.text);
        pool.push(beam.text);
      }
    }
    if (!pool.length) {
      return {
        answer: "",
        confidence: 0,
        char_confidences: [],
        top_candidates: [],
        candidates: [],
      };
    }

    let minOfficialLog = Infinity;
    for (const lp of officialMap.values()) {
      if (lp < minOfficialLog) minOfficialLog = lp;
    }
    const effectiveFloor = Number.isFinite(minOfficialLog)
      ? Math.min(floorLogProb, minOfficialLog - 1.0)
      : floorLogProb;

    const scored = pool.map((text) => {
      const offLog = officialMap.has(text) ? officialMap.get(text) : effectiveFloor;
      let dcLog = 0;
      let rawDcLog = 0;
      for (let pos = 0; pos < positions; pos++) {
        const idx = charToIndex.get(text[pos]);
        const dProb = Math.max(directProbs[pos * cols + idx] || 0, eps);
        const cProb = Math.max(cropProbs[pos * cols + idx] || 0, eps);
        const logD = Math.log(dProb);
        const logC = Math.log(cProb);
        rawDcLog += logD + logC;
        dcLog += wDirect * logD + wCrop * logC;
      }
      return {
        text,
        score: wOfficial * offLog + dcLog,
        cnnGeoMean: Math.exp(rawDcLog / (positions * 2)),
      };
    });
    scored.sort((a, b) => b.score - a.score);

    const maxScore = scored[0].score;
    let sumExp = 0;
    const weights = scored.map((item) => {
      const w = Math.exp(Math.max(-40, item.score - maxScore));
      sumExp += w;
      return w;
    });
    const probs = weights.map((w) => w / (sumExp || 1));

    const answer = scored[0].text;
    const rawConf = scored.length === 1 ? Math.min(probs[0], scored[0].cnnGeoMean) : probs[0];
    const confidence = Number(Math.min(0.999, Math.max(0.01, rawConf)).toFixed(4));
    const topCandidates = scored.slice(0, 3).map((item, idx) => ({
      answer: item.text,
      confidence: Number(Math.min(0.999, Math.max(0.001, idx === 0 ? rawConf : probs[idx])).toFixed(4)),
      solver_votes: 2,
      total_votes: 2,
    }));

    const charConfidences = answer.split("").map((ch, pos) => {
      let charProb = 0;
      for (let i = 0; i < scored.length; i++) {
        if (scored[i].text[pos] === ch) charProb += probs[i];
      }
      const alts = [];
      for (let i = 1; i < Math.min(4, scored.length); i++) {
        const altCh = scored[i].text[pos];
        if (altCh !== ch && !alts.includes(altCh)) alts.push(altCh);
      }
      for (const item of posTopChars[pos] || []) {
        if (item.char !== ch && !alts.includes(item.char)) alts.push(item.char);
        if (alts.length >= 2) break;
      }
      return {
        char: ch,
        confidence: Number(Math.min(0.999, Math.max(0.05, charProb)).toFixed(4)),
        alternatives: alts.slice(0, 2),
      };
    });

    return {
      answer,
      confidence,
      cnn_confidence: Number(scored[0].cnnGeoMean.toFixed(4)),
      char_confidences: charConfidences,
      top_candidates: topCandidates,
      candidates: topCandidates,
    };
  }

  function fuseFixed4Probabilities(
    directProbs,
    cropProbs,
    charset = DEFAULT_CHARSET,
    alpha = 6.0,
    beta = 6.0,
    options = {},
  ) {
    const charsetHint = options.charsetHint || "alphanumeric";
    const cols = charset.length;
    const positions = 4;
    const eps = 1e-12;
    const perPositionRanked = [];

    for (let pos = 0; pos < positions; pos++) {
      const offset = pos * cols;
      const combinedLogits = new Float64Array(cols);
      let maxLogit = NEG_INF;
      for (let c = 0; c < cols; c++) {
        if (!isCharAllowed(charset[c], charsetHint)) {
          combinedLogits[c] = -1e9;
          continue;
        }
        const dProb = Math.max(directProbs[offset + c] || 0, eps);
        const cProb = Math.max(cropProbs[offset + c] || 0, eps);
        const score = alpha * Math.log(dProb) + beta * Math.log(cProb);
        combinedLogits[c] = score;
        if (score > maxLogit) maxLogit = score;
      }
      let expSum = 0;
      const probs = new Float64Array(cols);
      for (let c = 0; c < cols; c++) {
        if (combinedLogits[c] <= -1e8) {
          probs[c] = 0;
          continue;
        }
        const val = Math.exp(combinedLogits[c] - maxLogit);
        probs[c] = val;
        expSum += val;
      }
      const ranked = [];
      for (let c = 0; c < cols; c++) {
        if (probs[c] <= 0) continue;
        const probability = probs[c] / (expSum || 1);
        ranked.push({ char: charset[c], probability, logProb: Math.log(Math.max(probability, eps)) });
      }
      ranked.sort((a, b) => b.probability - a.probability);
      perPositionRanked.push(ranked.slice(0, 4));
    }

    const answer = perPositionRanked.map((items) => items[0]?.char || "").join("");
    const charConfidences = perPositionRanked.map((items) => ({
      char: items[0]?.char || "",
      confidence: Number((items[0]?.probability || 0).toFixed(4)),
      alternatives: items.slice(1, 3).map((item) => item.char),
    }));

    let beams = [{ text: "", logProb: 0 }];
    for (let pos = 0; pos < positions; pos++) {
      const next = [];
      for (const beam of beams) {
        for (const item of perPositionRanked[pos]) {
          next.push({ text: beam.text + item.char, logProb: beam.logProb + item.logProb });
        }
      }
      next.sort((a, b) => b.logProb - a.logProb);
      beams = next.slice(0, 12);
    }

    const topCandidates = beams.slice(0, 3).map((item) => ({
      answer: item.text,
      confidence: Number(Math.exp(item.logProb).toFixed(4)),
      solver_votes: 2,
      total_votes: 2,
    }));
    const confidence = topCandidates[0]?.confidence ?? 0;

    return {
      answer,
      confidence,
      char_confidences: charConfidences,
      top_candidates: topCandidates,
      candidates: topCandidates,
    };
  }

  function ctcGreedyDecode(outputData, dims, charset, options = {}) {
    const charsetHint = options.charsetHint || "alphanumeric";
    const caseSensitive = Boolean(options.caseSensitive);
    const indices = [];

    if (Array.isArray(dims) && dims.length === 3) {
      const [d0, d1, classes] = dims;
      const seqLen = d0 === 1 ? d1 : d0;
      const stride = classes;
      for (let t = 0; t < seqLen; t++) {
        const base = t * stride;
        let bestIdx = 0;
        let bestVal = NEG_INF;
        for (let c = 0; c < classes; c++) {
          const val = Number(outputData[base + c]);
          if (val > bestVal) {
            bestVal = val;
            bestIdx = c;
          }
        }
        indices.push(bestIdx);
      }
    } else {
      for (let i = 0; i < outputData.length; i++) {
        indices.push(Number(outputData[i]));
      }
    }

    let prev = -1;
    const chars = [];
    for (const idx of indices) {
      if (idx !== prev && idx > 0 && idx < charset.length) {
        const raw = String(charset[idx] || "");
        const ch = caseSensitive ? raw : raw.toUpperCase();
        if (ch && isCharAllowed(ch, charsetHint)) {
          chars.push(ch);
        }
      }
      prev = idx;
    }
    return chars.join("");
  }

  function createBrowserOcrRuntime({ ort, modelBaseUrl, fetchImpl = globalThis.fetch } = {}) {
    let initPromise = null;
    let inferenceQueue = Promise.resolve();
    let state = {
      ready: false,
      backend: "wasm",
      models: [],
      error: null,
      official: null,
      fusion: null,
      universal: null,
    };

    function serializeInference(task) {
      const next = inferenceQueue.catch(() => {}).then(task);
      inferenceQueue = next;
      return next;
    }

    async function fetchJson(url) {
      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`無法載入模型設定 (${response.status})`);
      return response.json();
    }

    async function fetchBytes(url) {
      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`無法載入 ONNX 模型 (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    }

    async function createSession(modelBytes, providers) {
      return ort.InferenceSession.create(modelBytes, { executionProviders: providers });
    }

    async function warmUp() {
      if (state.ready) return getStatus();
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          if (!ort || typeof ort.InferenceSession?.create !== "function") {
            throw new Error("onnxruntime-web 尚未載入");
          }
          const manifestUrl = `${modelBaseUrl}/bundle_manifest.json`;
          const manifest = await fetchJson(manifestUrl);
          const bundles = manifest?.bundles || {};
          const providers = ["wasm"];
          const loadedModels = [];

          // onnxruntime-web WASM shares a single global session lock; create sessions sequentially.
          if (bundles.official) {
            const base = `${modelBaseUrl}/official`;
            const [charsetMeta, modelBytes] = await Promise.all([
              fetchJson(`${base}/charset.json`),
              fetchBytes(`${base}/common_old.onnx`),
            ]);
            const session = await createSession(modelBytes, providers);
            state.official = { charsetMeta, session };
            loadedModels.push("official");
          }

          if (bundles.fusion_v7) {
            const base = `${modelBaseUrl}/fusion_v7`;
            const [config, directBytes, cropBytes] = await Promise.all([
              fetchJson(`${base}/config.json`),
              fetchBytes(`${base}/direct.onnx`),
              fetchBytes(`${base}/crop.onnx`),
            ]);
            const directSession = await createSession(directBytes, providers);
            const cropSession = await createSession(cropBytes, providers);
            state.fusion = { config, directSession, cropSession };
            loadedModels.push("fusion_v7");
          }

          if (bundles.universal) {
            const base = `${modelBaseUrl}/universal`;
            const [charsets, modelBytes] = await Promise.all([
              fetchJson(`${base}/charsets.json`),
              fetchBytes(`${base}/custom.onnx`),
            ]);
            const session = await createSession(modelBytes, providers);
            state.universal = { charsets, session };
            loadedModels.push("universal");
          }

          if (!loadedModels.length) {
            throw new Error("未找到本機瀏覽器 ONNX 模型，請先執行 prepare_browser_bundle.py");
          }

          state.models = loadedModels;
          state.ready = true;
          state.error = null;
          return getStatus();
        } catch (error) {
          state.ready = false;
          state.error = error?.message || String(error);
          throw error;
        } finally {
          initPromise = null;
        }
      })();
      return initPromise;
    }

    function getStatus() {
      return {
        ok: state.ready,
        ready: state.ready,
        backend: state.backend,
        models: [...state.models],
        error: state.error,
      };
    }

    async function runOfficialTensor(rgbBytes, width, height) {
      const { charsetMeta, session } = state.official;
      const targetH = Number(charsetMeta.target_height || 64);
      const { tensor, width: resizedW, height: resizedH } = resizeGrayscaleUnit01(rgbBytes, width, height, targetH);
      const inputName = session.inputNames[0];
      const outMap = await session.run({
        [inputName]: new ort.Tensor("float32", tensor, [1, 1, resizedH, resizedW]),
      });
      const outTensor = outMap[session.outputNames[0]];
      return { data: outTensor.data, dims: outTensor.dims, charsetMeta };
    }

    function decodeOfficialTensor(tensorOut, options) {
      return ctcPrefixBeamAscii(tensorOut.data, tensorOut.dims, tensorOut.charsetMeta.ascii_entries || [], {
        blankIndex: tensorOut.charsetMeta.blank_index ?? 0,
        charsetHint: options.charsetHint,
        caseSensitive: options.caseSensitive,
        expectedLength: options.expectedLength,
        lengthMode: options.lengthMode,
        beamWidth: options.beamWidth,
        includeBeams: options.includeBeams,
      });
    }

    async function runOfficialOnRgb(rgbBytes, width, height, options) {
      const tensorOut = await runOfficialTensor(rgbBytes, width, height);
      return decodeOfficialTensor(tensorOut, options);
    }

    async function runFusionFixed4Probs(rgbFull, width, height) {
      const { config, directSession, cropSession } = state.fusion;
      const [directH, directW] = config.direct_image_size || [96, 160];
      const [cropH, cropW] = config.crop_image_size || [96, 64];
      const cropMargin = Number(config.crop_margin ?? 0.32);

      const directRgb = resizeRgbBilinear(rgbFull, width, height, directW, directH, 3);
      const directChw = rgbToChwFloat32(directRgb, directW, directH, true);
      const directFeed = {
        [directSession.inputNames[0]]: new ort.Tensor("float32", directChw, [1, 3, directH, directW]),
      };

      const cropPlaneSize = 3 * cropH * cropW;
      const cropBatch = new Float32Array(4 * cropPlaneSize);
      for (let pos = 0; pos < 4; pos++) {
        const seg = cropHorizontalSegment(rgbFull, width, height, pos, 4, cropMargin);
        const resized = resizeRgbBilinear(seg.rgb, seg.width, seg.height, cropW, cropH, 3);
        const chw = rgbToChwFloat32(resized, cropW, cropH, false);
        cropBatch.set(chw, pos * cropPlaneSize);
      }
      const cropFeed = {
        [cropSession.inputNames[0]]: new ort.Tensor("float32", cropBatch, [4, 3, cropH, cropW]),
      };

      const directOutMap = await directSession.run(directFeed);
      const cropOutMap = await cropSession.run(cropFeed);
      const directLogits = directOutMap[directSession.outputNames[0]].data;
      const cropLogits = cropOutMap[cropSession.outputNames[0]].data;
      const charset = String(config.charset || DEFAULT_CHARSET);
      const directProbs = softmaxRows(directLogits, 4, charset.length);
      const cropProbs = softmaxRows(cropLogits, 4, charset.length);
      return { directProbs, cropProbs, config, charset };
    }

    async function runFusionFixed4(rgbFull, width, height, options) {
      const { directProbs, cropProbs, config, charset } = await runFusionFixed4Probs(rgbFull, width, height);
      return fuseFixed4Probabilities(
        directProbs,
        cropProbs,
        charset,
        Number(config.alpha ?? 6.0),
        Number(config.beta ?? 6.0),
        { charsetHint: options.charsetHint },
      );
    }

    async function recognizeRgba(params) {
      return serializeInference(() => recognizeRgbaInner(params));
    }

    async function recognizeRgbaInner({
      rgba,
      width,
      height,
      expectedLength = null,
      lengthMode = "exact",
      charsetHint = "alphanumeric",
      caseSensitive = false,
    }) {
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      await warmUp();

      const rgbFull = rgbaToRgb(rgba, width, height, 4);
      const grayFull = rgbToGrayscaleBytes(rgbFull, width, height);
      const medianLum = computeMedianLuminance(grayFull);
      const isDarkBg = medianLum < 170;
      const isBlueBg = isDarkBg && isBlueBackground(rgbFull, width, height);
      const decodeOpts = { expectedLength, lengthMode, charsetHint, caseSensitive };

      // 1. Primary path: MIT-licensed general-purpose ddddocr official model (common_old.onnx)
      if (state.official) {
        let best;
        let darkPrimaryTensor = null;
        if (isDarkBg) {
          const darkPrimaryRgb = enhanceDarkPrimaryRgb(grayFull, width, height);
          darkPrimaryTensor = await runOfficialTensor(darkPrimaryRgb, width, height);
          best = decodeOfficialTensor(darkPrimaryTensor, decodeOpts);
          if (!best.answer || best.confidence < 0.85 || (expectedLength === 4 && (lengthMode === "exact" || isBlueBg) && best.answer.length !== 4)) {
            const rawRes = await runOfficialOnRgb(rgbFull, width, height, decodeOpts);
            const rawFixesDroppedChar = expectedLength === 4
              && (lengthMode === "exact" || isBlueBg)
              && best.answer.length !== 4
              && rawRes.answer.length === 4
              && rawRes.confidence >= 0.35;
            if (rawFixesDroppedChar || (rawRes.answer && rawRes.confidence > (best.confidence || 0))) {
              best = rawRes;
            }
          }
        } else {
          best = await runOfficialOnRgb(rgbFull, width, height, decodeOpts);
          if (!best.answer || best.confidence < 0.82) {
            const contrastRgb = enhanceLightContrastRgb(grayFull, 2.4);
            const contrastRes = await runOfficialOnRgb(contrastRgb, width, height, decodeOpts);
            if (contrastRes.answer && contrastRes.confidence > (best.confidence || 0)) best = contrastRes;
          }
        }

        // Product-of-Experts joint fusion with fusion_v7 on dark/blue 4-letter CAPTCHAs.
        // Protects digit-bearing answers when the input is not explicitly letter-only.
        const officialHasDigits = /[0-9]/.test(best.answer || "");
        const protectDigits = officialHasDigits && charsetHint !== "letters";
        const lengthEligibleForFixed4 = expectedLength === 4
          || (expectedLength === null && /^[A-Z]{3,4}$/.test(best.answer || ""));
        const eligibleDarkFusion = isDarkBg
          && Boolean(state.fusion)
          && !caseSensitive
          && charsetHint !== "digits"
          && !protectDigits
          && lengthEligibleForFixed4;
        let modelUsed = "official";
        if (eligibleDarkFusion && (isBlueBg || best.answer.length !== 4 || best.confidence < 0.92)) {
          const official4 = darkPrimaryTensor
            ? decodeOfficialTensor(darkPrimaryTensor, {
              expectedLength: 4,
              lengthMode: "exact",
              charsetHint: "letters",
              caseSensitive: false,
              beamWidth: 32,
              includeBeams: true,
            }).raw_beams || []
            : [];
          const { directProbs, cropProbs, charset } = await runFusionFixed4Probs(rgbFull, width, height);
          const joint = fuseOfficialAndFixed4(official4, directProbs, cropProbs, charset, {
            charsetHint: "letters",
          });
          const matches = alignedCharMatches(best.answer, joint.answer);
          const cnnConf = joint.cnn_confidence ?? 0;
          const adoptJoint = Boolean(joint.answer) && (
            (isBlueBg && ((matches >= 2 && cnnConf >= 0.15) || (matches >= 1 && cnnConf >= 0.30) || (!best.answer && cnnConf >= 0.30) || (charsetHint === "letters" && cnnConf >= 0.45) || cnnConf >= 0.60))
            || (!best.answer && cnnConf >= 0.30)
            || (best.answer.length === 3 && matches >= 2 && cnnConf >= 0.15 && joint.confidence >= 0.75)
            || (matches >= 2 && cnnConf >= 0.25 && joint.confidence >= 0.82)
          );
          if (adoptJoint) {
            best = joint;
            modelUsed = "official+fusion_v7";
          }
        }

        const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
        const lengthMatch = expectedLength === null || lengthMode === "unknown"
          ? null
          : lengthMode === "max"
            ? best.answer.length <= expectedLength
            : best.answer.length === expectedLength;

        if (!best.answer) throw new Error("離線模型無法辨識有效英數字元");
        return {
          ok: true,
          ...best,
          solver_votes: modelUsed.includes("+") ? 2 : 1,
          solver_count: state.models.length,
          total_votes: modelUsed.includes("+") ? 2 : 1,
          expected_length: expectedLength,
          length_mode: lengthMode,
          charset_hint: charsetHint,
          case_sensitive: caseSensitive,
          length_match: lengthMatch,
          latency_ms: Math.round(elapsed * 10) / 10,
          engine: "browser_onnx",
          model: modelUsed,
          backend: state.backend,
          selection_strategy: "browser_onnx_official_ctc",
        };
      }

      // 2. Fallback when only fusion_v7 is bundled (e.g. unit test / dark-only local bundle)
      const canUseFixed4 = Boolean(state.fusion)
        && !caseSensitive
        && (
          expectedLength === 4
          || expectedLength === null
          || lengthMode === "unknown"
          || (lengthMode === "max" && expectedLength >= 4)
        );
      if (canUseFixed4) {
        const fused = await runFusionFixed4(rgbFull, width, height, decodeOpts);
        const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
        const lengthMatch = expectedLength === null || lengthMode === "unknown"
          ? null
          : lengthMode === "max"
            ? fused.answer.length <= expectedLength
            : fused.answer.length === expectedLength;
        return {
          ok: true,
          ...fused,
          solver_votes: 2,
          solver_count: 2,
          total_votes: 2,
          expected_length: expectedLength,
          length_mode: lengthMode,
          charset_hint: charsetHint,
          case_sensitive: caseSensitive,
          length_match: lengthMatch,
          latency_ms: Math.round(elapsed * 10) / 10,
          engine: "browser_onnx",
          model: "fusion_v7",
          backend: state.backend,
          selection_strategy: "browser_onnx_fixed4_dual_cnn",
        };
      }

      if (state.universal) {
        const { charsets, session } = state.universal;
        const targetH = Array.isArray(charsets.image) && charsets.image[1] > 0 ? charsets.image[1] : 64;
        const { tensor, width: resizedW, height: resizedH } = resizeGrayscaleChw(rgba, width, height, targetH, 4);
        const inputName = session.inputNames[0];
        const outMap = await session.run({
          [inputName]: new ort.Tensor("float32", tensor, [1, 1, resizedH, resizedW]),
        });
        const outTensor = outMap[session.outputNames[0]];
        const answer = ctcGreedyDecode(outTensor.data, outTensor.dims, charsets.charset || [], {
          charsetHint,
          caseSensitive,
        });
        const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
        const lengthMatch = expectedLength === null || lengthMode === "unknown"
          ? null
          : lengthMode === "max"
            ? answer.length <= expectedLength
            : answer.length === expectedLength;
        const top = answer ? [{ answer, confidence: 0.9, solver_votes: 1, total_votes: 1 }] : [];
        return {
          ok: Boolean(answer),
          answer,
          confidence: answer ? 0.9 : 0,
          char_confidences: answer.split("").map((ch) => ({ char: ch, confidence: 0.9, alternatives: [] })),
          top_candidates: top,
          candidates: top,
          solver_votes: 1,
          solver_count: 1,
          total_votes: 1,
          expected_length: expectedLength,
          length_mode: lengthMode,
          charset_hint: charsetHint,
          case_sensitive: caseSensitive,
          length_match: lengthMatch,
          latency_ms: Math.round(elapsed * 10) / 10,
          engine: "browser_onnx",
          model: "universal",
          backend: state.backend,
          selection_strategy: "browser_onnx_ctc",
        };
      }

      throw new Error("目前沒有適用於此長度的離線瀏覽器模型");
    }

    async function dispose() {
      const sessions = [
        state.official?.session,
        state.fusion?.directSession,
        state.fusion?.cropSession,
        state.universal?.session,
      ].filter(Boolean);
      state.ready = false;
      state.models = [];
      state.official = null;
      state.fusion = null;
      state.universal = null;
      for (const session of sessions) {
        if (typeof session.release === "function") {
          try {
            await session.release();
          } catch {
            // Ignore release errors during shutdown.
          }
        }
      }
    }

    return { warmUp, getStatus, recognizeRgba, dispose };
  }

  return {
    DEFAULT_CHARSET,
    resizeRgbBilinear,
    rgbToChwFloat32,
    rgbaToRgb,
    rgbToGrayscaleBytes,
    computeMedianLuminance,
    isBlueBackground,
    alignedCharMatches,
    enhanceDarkPrimaryRgb,
    enhanceLightContrastRgb,
    resizeGrayscaleUnit01,
    cropHorizontalSegment,
    resizeGrayscaleChw,
    softmaxRows,
    ctcPrefixBeamAscii,
    fuseFixed4Probabilities,
    fuseOfficialAndFixed4,
    ctcGreedyDecode,
    createBrowserOcrRuntime,
  };
});
