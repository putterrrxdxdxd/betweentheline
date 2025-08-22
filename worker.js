// worker.js

// Import MediaPipe via script tag approach
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/control_utils/control_utils.js');
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');

const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const COLS = 160;
const ROWS = 60;

let lastFrame = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));
let selfieSegmentation = null;
let isInitialized = false;

// Initialize MediaPipe
function initializeMediaPipe() {
  try {
    selfieSegmentation = new SelfieSegmentation({
      locateFile: (file) => {
        // Use a different CDN or local fallback for model files
        if (file.endsWith('.tflite') || file.endsWith('.wasm')) {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
        }
        return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
      }
    });

    selfieSegmentation.setOptions({
      modelSelection: 0, // Use general model (more stable)
      selfieMode: true,
    });

    selfieSegmentation.onResults(onSegmentationResults);
    isInitialized = true;
    console.log('MediaPipe initialized successfully');
  } catch (error) {
    console.error('MediaPipe initialization failed:', error);
    // Fallback to simple processing
    isInitialized = false;
  }
}

function onSegmentationResults(results) {
  try {
    const offscreen = new OffscreenCanvas(COLS, ROWS);
    const ctx = offscreen.getContext('2d');
    
    // Draw and flip the image horizontally (mirror effect)
    ctx.scale(-1, 1);
    ctx.drawImage(results.image, -COLS, 0, COLS, ROWS);
    const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

    // Process segmentation mask
    const maskCanvas = new OffscreenCanvas(COLS, ROWS);
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.scale(-1, 1);
    maskCtx.drawImage(results.segmentationMask, -COLS, 0, COLS, ROWS);
    const maskData = maskCtx.getImageData(0, 0, COLS, ROWS).data;

    let diffs = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const idx = (y * COLS + x) * 4;
        
        // Check if this pixel is a person (from segmentation mask)
        const maskValue = maskData[idx]; // Red channel of mask
        const isPerson = maskValue > 128; // Threshold for person detection
        
        let char = '.'; // Background character
        
        if (isPerson) {
          // Convert person pixels to ASCII based on brightness
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const charIdx = Math.floor((lum / 255) * (ASCII_CHARS.length - 1));
          char = ASCII_CHARS[charIdx];
        }
        
        // Only send diff if character changed
        if (lastFrame[y][x] !== char) {
          lastFrame[y][x] = char;
          diffs.push({ x, y, char });
        }
      }
    }
    
    postMessage({ diffs });
  } catch (error) {
    console.error('Segmentation processing error:', error);
  }
}

function processFrameSimple(bitmap) {
  // Fallback: simple ASCII conversion without segmentation
  const offscreen = new OffscreenCanvas(COLS, ROWS);
  const ctx = offscreen.getContext('2d');
  
  ctx.scale(-1, 1);
  ctx.drawImage(bitmap, -COLS, 0, COLS, ROWS);
  const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

  let diffs = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const idx = (y * COLS + x) * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const charIdx = Math.floor((lum / 255) * (ASCII_CHARS.length - 1));
      const char = ASCII_CHARS[charIdx];
      
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
    try {
      if (isInitialized && selfieSegmentation) {
        // Use MediaPipe segmentation
        await selfieSegmentation.send({ image: e.data.bitmap });
      } else {
        // Fallback to simple processing
        processFrameSimple(e.data.bitmap);
      }
    } catch (err) {
      console.error('Frame processing error:', err);
      // Fallback to simple processing on error
      processFrameSimple(e.data.bitmap);
    }
  }
};

// Initialize when worker starts
initializeMediaPipe();
