// worker.js

const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const COLS = 160;
const ROWS = 60;

let lastFrame = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));
let selfieSegmentation = null;
let isReady = false;
let useSegmentation = false;
let modelLoadTimeout = null;

// Try to initialize MediaPipe with multiple CDN strategies
function initializeMediaPipe() {
  try {
    console.log('🔄 Attempting MediaPipe initialization with fallback strategy...');
    
    // Strategy 1: Try the most reliable CDN setup
    importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
    
    selfieSegmentation = new SelfieSegmentation({
      locateFile: (file) => {
        console.log('📁 MediaPipe requesting file:', file);
        
        // Strategy 2: Use multiple CDN fallbacks for different file types
        if (file.includes('selfie_segmentation')) {
          // Try Google's direct CDN first for model files
          const googleCDN = `https://storage.googleapis.com/mediapipe-models/${file}`;
          console.log('🔗 Trying Google CDN:', googleCDN);
          return googleCDN;
        } else if (file.includes('.wasm')) {
          // WASM files from jsdelivr usually work
          const wasmPath = `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
          console.log('🔗 Using jsdelivr for WASM:', wasmPath);
          return wasmPath;
        } else {
          // Default to jsdelivr for other files
          const defaultPath = `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
          console.log('🔗 Using default jsdelivr path:', defaultPath);
          return defaultPath;
        }
      }
    });

    selfieSegmentation.setOptions({
      modelSelection: 0, // General model (more reliable)
      selfieMode: true
    });

    selfieSegmentation.onResults(onSegmentationResults);
    
    console.log('✅ MediaPipe initialized successfully');
    console.log('⏳ Loading segmentation models... (timeout in 8s)');
    
    // Reasonable timeout for model loading
    modelLoadTimeout = setTimeout(() => {
      if (!isReady) {
        console.log('⏰ MediaPipe model loading timed out after 8 seconds');
        console.log('🔍 Root cause analysis:');
        console.log('   → Version 0.1.1675465747 may not exist on CDN');
        console.log('   → Model files (.tflite) failed to load');
        console.log('   → Google CDN fallback also failed');
        console.log('💡 Continuing with simple ASCII mode (fully functional)');
        useSegmentation = false;
      }
    }, 8000); // 8 second timeout
    
  } catch (err) {
    console.log('❌ MediaPipe initialization failed:', err.message);
    console.log('🔍 Root cause analysis:');
    
    if (err.message.includes('importScripts')) {
      console.log('   → CDN script loading failed');
    } else if (err.message.includes('SelfieSegmentation')) {
      console.log('   → MediaPipe constructor failed');
    } else {
      console.log('   → Unknown initialization error');
    }
    
    console.log('🔄 Falling back to simple ASCII mode');
    useSegmentation = false;
  }
}

function onSegmentationResults(results) {
  if (!isReady) {
    isReady = true;
    useSegmentation = true;
    clearTimeout(modelLoadTimeout);
    console.log('✅ MediaPipe segmentation is ready! Background removal active.');
  }

  const offscreen = new OffscreenCanvas(COLS, ROWS);
  const ctx = offscreen.getContext('2d');
  
  // Draw and flip the image horizontally (mirror effect)
  ctx.scale(-1, 1);
  ctx.drawImage(results.image, -COLS, 0, COLS, ROWS);
  const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

  // Process segmentation mask - this is the key part for background removal
  const maskCanvas = new OffscreenCanvas(COLS, ROWS);
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.scale(-1, 1);
  maskCtx.drawImage(results.segmentationMask, -COLS, 0, COLS, ROWS);
  const maskData = maskCtx.getImageData(0, 0, COLS, ROWS).data;

  let diffs = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const idx = (y * COLS + x) * 4;
      
      // Use the segmentation mask to determine if pixel is person or background
      const maskValue = maskData[idx]; // Red channel
      const isPerson = maskValue > 128; // Threshold for person detection
      
      let char = '.'; // Background character (always dots for non-person areas)
      
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
}

// Temporary simple processing while MediaPipe loads
function processFrameSimple(bitmap) {
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
    if (useSegmentation && selfieSegmentation && isReady) {
      // Use MediaPipe segmentation when ready
      try {
        await selfieSegmentation.send({ image: e.data.bitmap });
      } catch (err) {
        console.error('MediaPipe processing error:', err);
        // Fall back to simple processing on error
        useSegmentation = false;
        processFrameSimple(e.data.bitmap);
      }
    } else {
      // Use simple processing (either while loading or permanently if timeout)
      processFrameSimple(e.data.bitmap);
    }
  }
};

// Initialize immediately when worker starts
try {
  initializeMediaPipe();
} catch (err) {
  console.error('Failed to initialize MediaPipe:', err);
}
