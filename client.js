// client.js

const COLS = 160;
const ROWS = 60;

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

// --- Worker setup ---
const worker = new Worker('worker.js');

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
};

navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
  .then(stream => { 
    video.srcObject = stream;
  })
  .catch(err => console.error('Camera error', err));

// --- Send frames to worker ---
function loop() {
  if (!typingMode && videoReady && video.videoWidth > 0 && video.videoHeight > 0) {
    try {
      createImageBitmap(video).then(bitmap => {
        worker.postMessage({ type: 'frame', bitmap }, [bitmap]);
      }).catch(err => {
        // Silently ignore createImageBitmap errors when video isn't ready
      });
    } catch (err) {
      // Silently ignore errors when video isn't ready
    }
  }
  requestAnimationFrame(loop);
}
loop();

// --- Receive diffs from worker ---
worker.onmessage = (e) => {
  const { diffs } = e.data;
  if (diffs && diffs.length) {
    ws.send(JSON.stringify({ type: 'diff', diffs }));
  }
};
