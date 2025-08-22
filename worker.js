// worker.js

importScripts("https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js");

const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const COLS = 160;
const ROWS = 60;

let lastFrame = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));

// MediaPipe setup
const selfieSegmentation = new SelfieSegmentation({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
});
selfieSegmentation.setOptions({ modelSelection: 1 });

selfieSegmentation.onResults(onResults);

async function onResults(results) {
  const offscreen = new OffscreenCanvas(COLS, ROWS);
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(results.image, 0, 0, COLS, ROWS);
  const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

  const maskCtx = new OffscreenCanvas(COLS, ROWS).getContext('2d');
  maskCtx.drawImage(results.segmentationMask, 0, 0, COLS, ROWS);
  const maskData = maskCtx.getImageData(0, 0, COLS, ROWS).data;

  let diffs = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const idx = (y * COLS + x) * 4;
      const isPerson = maskData[idx + 3] > 128 && maskData[idx] > 128;
      let char = '.';
      if (isPerson) {
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const charIdx = Math.floor((lum / 255) * (ASCII_CHARS.length - 1));
        char = ASCII_CHARS[charIdx];
      }
      if (lastFrame[y][x] !== char) {
        lastFrame[y][x] = char;
        diffs.push({ x, y, char });
      }
    }
  }
  postMessage({ diffs });
}

onmessage = async (e) => {
  if (e.data.type === 'frame') {
    await selfieSegmentation.send({ image: e.data.bitmap });
  }
};
