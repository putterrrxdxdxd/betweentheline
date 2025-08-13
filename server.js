const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');

const COLS = 500;
const ROWS = 200;
const EMPTY = '.';
const STAR = '★';

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname)));
const server = app.listen(PORT, () => {
  console.log(`HTTP/WS server running on http://localhost:${PORT}`);
});

// WebSocket server on the same port (enable compression)
const wss = new WebSocket.Server({ server, perMessageDeflate: true });

// Shared collaborative grid
let sharedGrid = Array.from({ length: ROWS }, () => EMPTY.repeat(COLS));
// Set of persistent star positions
let stars = new Set();
// Track which user last wrote to each cell
let cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
// Track each user's last region (offset and size)
let userRegions = new Map();

// Overlap text pool: words and short phrases from Thai and Khmer passages
let overlapPassages = [
  `ประเทศไทยรวมเลือดเนื้อชาติเชื้อไทย เป็นประชารัฐ ไผทของไทยทุกส่วน อยู่ดำรงคงไว้ได้ทั้งมวล ด้วยไทยล้วนหมาย รักสามัคคี ไทยนี้รักสงบ แต่ถึงรบไม่ขลาด เอกราชจะไม่ให้ใครข่มขี่ สละเลือดทุกหยาดเป็นชาติพลี เถลิงประเทศชาติไทยทวีมีชัย ชโย`,
  `សូមពួកទេព្តា រក្សាមហាក្សត្រយើង ឱ្យបានរុងរឿង ដោយជ័យមង្គលសិរីសួស្តី យើងខ្ញុំព្រះអង្គ សូមជ្រកក្រោមម្លប់ព្រះបារមី នៃព្រះនរបតីវង្ស ក្សត្រាដែលសាងប្រាសាទថ្ម គ្រប់គ្រងដែនខ្មែរ បុរាណថ្កើងថ្កាន ។`,
  `ប្រាសាទសិលា កំបាំងកណ្តាលព្រៃ គួរឱ្យស្រមៃ នឹកដល់យសស័ក្តិមហានគរ ជាតិខ្មែរដូចថ្ម គង់វង្សនៅល្អរឹងប៉ឹងជំហរ យើងសង្ឃឹមពរ ភ័ព្វព្រេងសំណាងរបស់កម្ពុជា មហារដ្ឋកើតមាន យូរអង្វែងហើយ ។ គ្រប់វត្តអារាម ឮតែសូរស័ព្ទធម៌ សូត្រដោយអំណរ រំឭកគុណពុទ្ធសាសនា ចូរយើងជាអ្នក ជឿជាក់ស្មោះស្ម័គ្រតាមបែបដូនតា គង់តែទេវតា នឹងជួយជ្រោមជ្រែងផ្គត់ផ្គង់ប្រយោជន៍ឱ្យ ដល់ប្រទេសខ្មែរ ជាមហានគរ ។`
];
function getOverlapWords() {
  // Split passages into words and short phrases (2-4 words)
  const words = [];
  for (const passage of overlapPassages) {
    const tokens = passage.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      words.push(tokens[i]);
      if (i + 1 < tokens.length) words.push(tokens[i] + ' ' + tokens[i + 1]);
      if (i + 2 < tokens.length) words.push(tokens[i] + ' ' + tokens[i + 1] + ' ' + tokens[i + 2]);
      if (i + 3 < tokens.length) words.push(tokens[i] + ' ' + tokens[i + 1] + ' ' + tokens[i + 2] + ' ' + tokens[i + 3]);
    }
  }
  return words;
}
let overlapWords = getOverlapWords();
let overlapPool = [
  'ประเทศไทย', 'รวมเลือดเนื้อ', 'ชาติเชื้อไทย', 'เป็นประชารัฐ', 'សូមពួកទេព្តា', 'រក្សាមហាក្សត្រយើង', 'ប្រាសាទសិលា', 'កំបាំងកណ្តាលព្រៃ', 'ជាតិខ្មែរដូចថ្ម', 'គង់វង្សនៅល្អ', 'ជឿជាក់ស្មោះស្ម័គ្រតាមបែបដូនតា'
];
function randomOverlapText() {
  if (overlapPool.length === 0) return '★';
  return overlapPool[Math.floor(Math.random() * overlapPool.length)];
}

function gridKey(x, y) {
  return `${x},${y}`;
}

function erasePreviousRegion(grid, owners, prev, userId) {
  if (!prev) return;
  let newGrid = grid.map(row => row.split(''));
  for (let y = 0; y < prev.height; y++) {
    for (let x = 0; x < prev.width; x++) {
      const gx = prev.x + x;
      const gy = prev.y + y;
      if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
        if (owners[gy][gx] === userId && newGrid[gy][gx] !== STAR) {
          newGrid[gy][gx] = EMPTY;
          owners[gy][gx] = null;
        }
      }
    }
  }
  return newGrid.map(row => row.join(''));
}

function updateGridRegion(grid, region, ox, oy, userId) {
  let newStars = new Set(stars);
  let newGrid = grid.map(row => row.split(''));
  // Erase previous region for this user
  const prev = userRegions.get(userId);
  if (prev) {
    for (let y = 0; y < prev.height; y++) {
      for (let x = 0; x < prev.width; x++) {
        const gx = prev.x + x;
        const gy = prev.y + y;
        if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
          if (cellOwners[gy][gx] === userId && newGrid[gy][gx] !== STAR) {
            newGrid[gy][gx] = EMPTY;
            cellOwners[gy][gx] = null;
          }
        }
      }
    }
  }
  // Draw new region
  for (let y = 0; y < region.length; y++) {
    for (let x = 0; x < region[y].length; x++) {
      const gx = ox + x;
      const gy = oy + y;
      if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
        const prev = newGrid[gy][gx];
        const prevOwner = cellOwners[gy][gx];
        const next = region[y][x];
        if (
          prev !== EMPTY && next !== EMPTY && prev !== next && prevOwner && prevOwner !== userId
        ) {
          // Insert random overlap text horizontally
          const overlapText = randomOverlapText();
          for (let k = 0; k < overlapText.length && gx + k < COLS; k++) {
            newGrid[gy][gx + k] = overlapText[k];
            stars.add(gridKey(gx + k, gy));
          }
        }
        if (next !== EMPTY) {
          newGrid[gy][gx] = newStars.has(gridKey(gx, gy)) ? newGrid[gy][gx] : next;
          cellOwners[gy][gx] = userId;
        }
      }
    }
  }
  // Update user's last region
  userRegions.set(userId, { x: ox, y: oy, width: region[0]?.length || 0, height: region.length });
  return [newGrid.map(row => row.join('')), newStars];
}

function getColorMap() {
  // Build a color map: 'r' for camera, 'b' for overlap, '' for normal
  let colorMap = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
  // Mark overlap cells
  for (const key of stars) {
    const [x, y] = key.split(',').map(Number);
    if (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
      colorMap[y][x] = 'b';
    }
  }
  // Mark camera regions (by cellOwners)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (cellOwners[y][x] && colorMap[y][x] !== 'b') {
        colorMap[y][x] = 'r';
      }
    }
  }
  return colorMap.map(row => row.join(''));
}

function broadcastGridNow() {
  const newColorMap = getColorMap();
  if (!global.lastBroadcastGrid || !global.lastBroadcastColorMap) {
    // First time: send full
    const payload = JSON.stringify({ type: 'grid', grid: sharedGrid, colorMap: newColorMap });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
    global.lastBroadcastGrid = sharedGrid.map(r => r);
    global.lastBroadcastColorMap = newColorMap.map(r => r);
    return;
  }
  const gridPatches = computePatches(global.lastBroadcastGrid, sharedGrid);
  const colorPatches = computePatches(global.lastBroadcastColorMap, newColorMap);
  if (gridPatches.length === 0 && colorPatches.length === 0) return;
  const payload = JSON.stringify({ type: 'patch', gridPatches, colorPatches });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
  global.lastBroadcastGrid = sharedGrid.map(r => r);
  global.lastBroadcastColorMap = newColorMap.map(r => r);
}

function computePatches(oldArr, newArr) {
  const patches = [];
  for (let y = 0; y < ROWS; y++) {
    const oldRow = oldArr[y] || '';
    const newRow = newArr[y] || '';
    if (oldRow === newRow) continue;
    let x = 0;
    while (x < COLS) {
      if (oldRow[x] !== newRow[x]) {
        let start = x;
        let seg = '';
        while (x < COLS && oldRow[x] !== newRow[x]) {
          seg += newRow[x];
          x++;
        }
        patches.push({ y, x: start, text: seg });
      } else {
        x++;
      }
    }
  }
  return patches;
}

let broadcastDirty = false;
function scheduleBroadcast() { broadcastDirty = true; }
setInterval(() => {
  if (broadcastDirty) {
    broadcastDirty = false;
    broadcastGridNow();
  }
}, 1000 / 10); // 10 FPS max

wss.on('connection', (ws) => {
  const id = uuidv4();
  ws.send(JSON.stringify({ type: 'id', id }));
  ws.send(JSON.stringify({ type: 'grid', grid: sharedGrid, colorMap: getColorMap() }));
  ws.send(JSON.stringify({ type: 'pool', pool: overlapPool }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'update_pool' && Array.isArray(data.pool)) {
        overlapPool = data.pool.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'pool', pool: overlapPool }));
          }
        }
      }
      if (data.type === 'add_article' && typeof data.text === 'string' && data.text.trim()) {
        overlapPassages.push(data.text.trim());
        overlapWords = getOverlapWords();
      }
      if (data.type === 'edit' && Array.isArray(data.grid)) {
        // Full grid edit (typing mode) - retained for compatibility
        let newStars = new Set(stars);
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            if (
              sharedGrid[y][x] !== EMPTY && data.grid[y][x] !== EMPTY && sharedGrid[y][x] !== data.grid[y][x] &&
              cellOwners[y][x] && cellOwners[y][x] !== id
            ) {
              newStars.add(gridKey(x, y));
            }
            if (data.grid[y][x] !== EMPTY) {
              cellOwners[y][x] = id;
            }
          }
        }
        sharedGrid = data.grid.map((row, y) =>
          row.split('').map((ch, x) => newStars.has(gridKey(x, y)) ? ch : ch).join('')
        );
        stars = newStars;
        scheduleBroadcast();
      }
      if (data.type === 'region' && Array.isArray(data.region) && typeof data.ox === 'number' && typeof data.oy === 'number') {
        [sharedGrid, stars] = updateGridRegion(sharedGrid, data.region, data.ox, data.oy, id);
        scheduleBroadcast();
      }
      if (data.type === 'reset') {
        stars.clear();
        sharedGrid = sharedGrid.map(row => row.replace(/★/g, EMPTY));
        cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        userRegions = new Map();
        scheduleBroadcast();
      }
    } catch (e) {}
  });
});
