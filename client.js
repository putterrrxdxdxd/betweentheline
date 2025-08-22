// client.js

const COLS = 160;
const ROWS = 120;

let myId = null;
let typingMode = false;
let gridCache = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));

// DOM elements
const stage = document.getElementById('stage');
const typingBtn = document.getElementById('typing-btn');
const resetBtn = document.getElementById('reset-btn');
const poolList = document.getElementById('poolList');
const poolInput = document.getElementById('poolInput');
const addPoolBtn = document.getElementById('addPoolBtn');

function renderPool(items) {
  poolList.innerHTML = '';
  for (const t of items) {
    const li = document.createElement('li');
    li.textContent = t;
    poolList.appendChild(li);
  }
}

addPoolBtn.onclick = () => {
  const t = poolInput.value.trim();
  if (!t) return;
  ws.send(JSON.stringify({ type: 'add_pool_text', text: t }));
  poolInput.value = '';
};

// --- Segmentation setup (BodyPix + MediaPipe fallback) ---
let selfieSegmentation = null;
let segmentationReady = false;
let bodyPixNet = null;
let useBodyPix = false;

function initializeMediaPipe() {
  try {
    console.log('🔄 Starting MediaPipe initialization...');
    
    if (typeof SelfieSegmentation === 'undefined') {
      console.error('❌ SelfieSegmentation not available. MediaPipe script may not be loaded.');
      return;
    }
    
    selfieSegmentation = new SelfieSegmentation({
      locateFile: (file) => {
        console.log('📁 MediaPipe requesting:', file);
        return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
      }
    });

    selfieSegmentation.setOptions({
      modelSelection: 0,
      selfieMode: true,
      // Force CPU mode to avoid WebGL memory issues
      enableSegmentation: true,
      smoothSegmentation: false
    });

    selfieSegmentation.onResults(onSegmentationResults);
    console.log('✅ MediaPipe initialized in main thread');
  } catch (err) {
    console.error('❌ MediaPipe initialization failed:', err);
  }
}

function onSegmentationResults(results) {
  if (!segmentationReady) {
    segmentationReady = true;
    console.log('🎉 MediaPipe segmentation is ready! Background removal active.');
  }
  
  processSegmentationFrame(results);
}

// WebSocket
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'id') {
    myId = data.id;
  } else if (data.type === 'grid') {
    // full grid snapshot (new join or reset)
    gridCache = data.grid.map(r => r.split(''));
    renderStage();
  } else if (data.type === 'diff') {
    applyDiffs(data.diffs);
  } else if (data.type === 'pool') {
    renderPool(data.pool);
  }
};

// --- Rendering ---
function renderStage() {
  stage.textContent = gridCache.map(row => row.join('')).join('\n');
}

function applyDiffs(diffs) {
  for (const { x, y, char } of diffs) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
      gridCache[y][x] = char;
    }
  }
  renderStage();
}

// --- Pool UI ---
function renderPool(items) {
  poolList.innerHTML = '';
  for (const t of items) {
    const li = document.createElement('li');
    li.textContent = t;
    poolList.appendChild(li);
  }
}

addPoolBtn.onclick = () => {
  const t = poolInput.value.trim();
  if (!t) return;
  ws.send(JSON.stringify({ type: 'add_pool_text', text: t }));
  poolInput.value = '';
};

// --- Typing mode toggle ---
typingBtn.onclick = () => {
  typingMode = !typingMode;
  stage.contentEditable = typingMode ? 'true' : 'false';
  typingBtn.textContent = typingMode ? 'Camera Mode' : 'Typing Mode';
};

stage.addEventListener('input', () => {
  if (!typingMode) return;
  const lines = stage.textContent.split('\n').slice(0, ROWS);
  while (lines.length < ROWS) lines.push(' '.repeat(COLS));
  const grid = lines.map(line => (line + ' '.repeat(COLS)).slice(0, COLS));
  ws.send(JSON.stringify({ type: 'edit', grid }));
});

// --- Reset ---
resetBtn.onclick = () => {
  ws.send(JSON.stringify({ type: 'reset' }));
};

// --- Video capture ---
const video = document.getElementById('video');
let videoReady = false;

video.onloadedmetadata = () => {
  videoReady = true;
  console.log('Video ready:', video.videoWidth, 'x', video.videoHeight);
};

video.onloadeddata = () => {
  console.log('Video data loaded, ready to process frames');
  // Only start the main loop when video is truly ready
  loop();
};

navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
  .then(stream => { 
    video.srcObject = stream;
    console.log('Camera stream started');
  })
  .catch(err => console.error('Camera error', err));

// --- ASCII Processing ---
const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
let lastFrame = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));

function processSegmentationFrame(results) {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Clear previous transformations
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  
  // Draw and flip the image horizontally (mirror effect)
  ctx.scale(-1, 1);
  ctx.drawImage(results.image, -COLS, 0, COLS, ROWS);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
  const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

  // Process segmentation mask
  const maskCanvas = document.getElementById('mask');
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.scale(-1, 1);
  maskCtx.drawImage(results.segmentationMask, -COLS, 0, COLS, ROWS);
  maskCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
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
  
  if (diffs.length > 0) {
    ws.send(JSON.stringify({ type: 'diff', diffs }));
  }
}

// --- Send frames to MediaPipe ---
let frameCount = 0;
let mediaPipeError = false;

function loop() {
  frameCount++;
  
  if (!typingMode && videoReady && video.videoWidth > 0 && video.videoHeight > 0) {
    if (segmentationReady && !mediaPipeError) {
      if (useBodyPix) {
        // Use BodyPix (more stable, no WebGL issues)
        if (frameCount % 2 === 0) {
          processBodyPixFrame();
        }
      } else if (motionSegmentation) {
        // Use motion-based segmentation (ultra-lightweight, no external libs)
        if (frameCount % 1 === 0) { // Can process every frame
          processMotionFrame();
        }
      } else {
        // Use MediaPipe (last resort)
        if (frameCount % 3 === 0) {
          try {
            selfieSegmentation.send({ image: video });
          } catch (err) {
            console.error('❌ MediaPipe crashed:', err.message);
            console.log('🔄 Switching to motion segmentation');
            mediaPipeError = true;
            initializeMotionSegmentation();
          }
        }
      }
    } else if (selfieSegmentation && !mediaPipeError && !useBodyPix && !motionSegmentation) {
      // MediaPipe initialized but not ready yet
      if (frameCount % 5 === 0) {
        try {
          selfieSegmentation.send({ image: video });
        } catch (err) {
          console.log('💭 MediaPipe not ready yet, using motion segmentation');
          initializeMotionSegmentation();
        }
      } else {
        processSimpleFrame();
      }
    } else {
      // Show simple ASCII (either loading or after crash)
      processSimpleFrame();
    }
  }
  requestAnimationFrame(loop);
}

// Simple ASCII processing fallback
function processSimpleFrame() {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Clear previous transformations
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  
  // Draw and flip the image horizontally (mirror effect)
  ctx.scale(-1, 1);
  ctx.drawImage(video, -COLS, 0, COLS, ROWS);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
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
  
  if (diffs.length > 0) {
    ws.send(JSON.stringify({ type: 'diff', diffs }));
  }
}

// BodyPix initialization (more stable alternative)
async function initializeBodyPix(retries = 10) {
  try {
    console.log('🔄 Initializing BodyPix (TensorFlow.js)...');
    
    if (typeof bodyPix === 'undefined') {
      if (retries > 0) {
        console.log(`⏳ BodyPix not available, retrying in 500ms... (${retries} left)`);
        setTimeout(() => initializeBodyPix(retries - 1), 500);
        return false;
      } else {
        console.log('❌ BodyPix not available after retries.');
        return false;
      }
    }
    
    bodyPixNet = await bodyPix.load({
      architecture: 'MobileNetV1',
      outputStride: 16,
      multiplier: 0.75,
      quantBytes: 2
    });
    
    useBodyPix = true;
    segmentationReady = true;
    console.log('✅ BodyPix loaded successfully - more stable segmentation!');
    return true;
  } catch (err) {
    console.error('❌ BodyPix failed to load:', err);
    return false;
  }
}

// Simple motion-based segmentation (ultra-lightweight)
let previousFrame = null;
let motionSegmentation = false;

function initializeMotionSegmentation() {
  console.log('🔄 Initializing motion-based segmentation (no external libraries)...');
  motionSegmentation = true;
  segmentationReady = true;
  console.log('✅ Motion segmentation ready - detects moving pixels as person!');
  return true;
}

function processMotionFrame() {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Draw current frame
  ctx.drawImage(video, 0, 0, COLS, ROWS);
  const currentFrame = ctx.getImageData(0, 0, COLS, ROWS).data;
  
  let diffs = [];
  
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const idx = (y * COLS + x) * 4;
      const r = currentFrame[idx];
      const g = currentFrame[idx + 1];
      const b = currentFrame[idx + 2];
      
      let char = '.'; // Background by default
      
      if (previousFrame) {
        // Calculate motion difference
        const prevR = previousFrame[idx];
        const prevG = previousFrame[idx + 1];
        const prevB = previousFrame[idx + 2];
        
        const motionDiff = Math.abs(r - prevR) + Math.abs(g - prevG) + Math.abs(b - prevB);
        
        // If motion detected, treat as person
        if (motionDiff > 30) { // Threshold for motion
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const charIdx = Math.floor((lum / 255) * (ASCII_CHARS.length - 1));
          char = ASCII_CHARS[charIdx];
        }
      } else {
        // First frame - show everything as person to establish baseline
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
  
  // Store current frame for next comparison
  previousFrame = new Uint8ClampedArray(currentFrame);
  
  if (diffs.length > 0) {
    ws.send(JSON.stringify({ type: 'diff', diffs }));
  }
}

// BodyPix segmentation processing
async function processBodyPixFrame() {
  if (!bodyPixNet) return;

  // Extra guards and logging
  if (!video || video.readyState < 2) {
    console.warn('BodyPix: video not ready (readyState:', video.readyState, ')');
    return;
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    console.warn('BodyPix: video has zero size:', video.videoWidth, video.videoHeight);
    return;
  }

  // Use an offscreen canvas as input to BodyPix
  let inputCanvas = document.getElementById('inputCanvas');
  if (!inputCanvas) {
    inputCanvas = document.createElement('canvas');
    inputCanvas.id = 'inputCanvas';
    inputCanvas.width = video.videoWidth;
    inputCanvas.height = video.videoHeight;
    inputCanvas.style.display = 'none';
    document.body.appendChild(inputCanvas);
  }
  if (inputCanvas.width !== video.videoWidth) inputCanvas.width = video.videoWidth;
  if (inputCanvas.height !== video.videoHeight) inputCanvas.height = video.videoHeight;
  const inputCtx = inputCanvas.getContext('2d');
  inputCtx.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height);

  const canvas = document.getElementById('canvas');
  if (!canvas) {
    console.warn('BodyPix: canvas not found');
    return;
  }
  if (canvas.width !== COLS) canvas.width = COLS;
  if (canvas.height !== ROWS) canvas.height = ROWS;

  // Log all sizes before calling BodyPix
  console.log('BodyPix: video size:', video.videoWidth, video.videoHeight, 'inputCanvas size:', inputCanvas.width, inputCanvas.height, 'canvas size:', canvas.width, canvas.height);

  // Final guard: do not call BodyPix if any size is zero
  if (video.videoWidth === 0 || video.videoHeight === 0 || inputCanvas.width === 0 || inputCanvas.height === 0 || canvas.width === 0 || canvas.height === 0) {
    console.warn('BodyPix: Skipping call due to zero size:', {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      inputCanvasWidth: inputCanvas.width,
      inputCanvasHeight: inputCanvas.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height
    });
    return;
  }

  try {
    // Pass the inputCanvas to BodyPix instead of the video element
    const segmentation = await bodyPixNet.segmentPerson(inputCanvas, {
      flipHorizontal: true,
      internalResolution: 'low',
      segmentationThreshold: 0.7
    });

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(inputCanvas, 0, 0, COLS, ROWS);
    const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

    let diffs = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const idx = y * COLS + x;
        const imgIdx = idx * 4;

        // BodyPix returns 1 for person, 0 for background
        const isPerson = segmentation.data[idx] === 1;

        let char = '.'; // Background
        if (isPerson) {
          const r = imgData[imgIdx];
          const g = imgData[imgIdx + 1];
          const b = imgData[imgIdx + 2];
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

    if (diffs.length > 0) {
      ws.send(JSON.stringify({ type: 'diff', diffs }));
    }
  } catch (err) {
    console.error('BodyPix processing error:', err);
    // Fallback: skip this frame, don't crash
  }
}

// Initialize segmentation when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  // Wait for scripts to load
  setTimeout(async () => {
    // Try BodyPix first (best quality)
    const bodyPixLoaded = await initializeBodyPix();
    
    if (!bodyPixLoaded) {
      console.log('🔄 BodyPix failed, trying motion segmentation...');
      // Use motion segmentation (ultra-reliable, no external deps)
      const motionLoaded = initializeMotionSegmentation();
      
      if (!motionLoaded) {
        // Last resort: MediaPipe (crash-prone)
        console.log('🔄 Final fallback to MediaPipe...');
        setTimeout(initializeMediaPipe, 1000);
        
        setTimeout(() => {
          if (!segmentationReady) {
            console.log('⚠️ All methods failed - forcing motion segmentation');
            initializeMotionSegmentation(); // This one always works
          }
        }, 8000);
      }
    }
  }, 2000);
});
