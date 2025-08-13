const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');

const COLS = 500;
const ROWS = 200;
const EMPTY = '.';

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname)));
const server = app.listen(PORT, () => {
  console.log(`HTTP/WS server running on http://localhost:${PORT}`);
});

// WebSocket server on the same port
const wss = new WebSocket.Server({ server });

// Shared collaborative grid
let sharedGrid = Array.from({ length: ROWS }, () => EMPTY.repeat(COLS));
// Locked cells created by overlaps (persist until reset): set of "x,y"
let lockedCells = new Set();
// Track which user last wrote to each cell
let cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
// Track each user's last region (offset and size)
let userRegions = new Map();
// Overlap text pool
let overlapPool = [
  'together', 'between the lines', 'hello', 'world', 'art', 'play', 'motion', 'trace', 'echo', 'merge'
];

function gridKey(x, y) {
  return `${x},${y}`;
}

function randomOverlapText() {
  if (!overlapPool || overlapPool.length === 0) return '*';
  return overlapPool[Math.floor(Math.random() * overlapPool.length)];
}

function broadcastGrid() {
  const payload = JSON.stringify({ type: 'grid', grid: sharedGrid });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastPool() {
  const payload = JSON.stringify({ type: 'pool', pool: overlapPool });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function eraseUserPreviousRegion(grid, owners, prev, userId) {
  if (!prev) return grid;
  let newGrid = grid.map(row => row.split(''));
  for (let y = 0; y < prev.height; y++) {
    for (let x = 0; x < prev.width; x++) {
      const gx = prev.x + x;
      const gy = prev.y + y;
      if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
        const key = gridKey(gx, gy);
        if (owners[gy][gx] === userId && !lockedCells.has(key)) {
          newGrid[gy][gx] = EMPTY;
          owners[gy][gx] = null;
        }
      }
    }
  }
  return newGrid.map(row => row.join(''));
}

function writeOverlapText(newGridArr, startX, y, text) {
  for (let k = 0; k < text.length; k++) {
    const gx = startX + k;
    if (gx >= COLS) break;
    const key = gridKey(gx, y);
    newGridArr[y][gx] = text[k];
    lockedCells.add(key);
    // Do not assign owner to locked text
  }
}

function updateGridRegion(grid, region, ox, oy, userId) {
  let newGrid = grid.map(row => row.split(''));
  // Erase previous region for this user (without touching locked text)
  const prev = userRegions.get(userId);
  if (prev) {
    sharedGrid = eraseUserPreviousRegion(sharedGrid, cellOwners, prev, userId);
    newGrid = sharedGrid.map(row => row.split(''));
  }
  // Draw new region
  for (let y = 0; y < region.length; y++) {
    for (let x = 0; x < region[y].length; x++) {
      const gx = ox + x;
      const gy = oy + y;
      if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
        const key = gridKey(gx, gy);
        const prevCh = newGrid[gy][gx];
        const prevOwner = cellOwners[gy][gx];
        const next = region[y][x];
        // Overlap between different users with non-empty chars, and cell not already locked
        if (
          prevCh !== EMPTY && next !== EMPTY && prevCh !== next && prevOwner && prevOwner !== userId && !lockedCells.has(key)
        ) {
          const text = randomOverlapText();
          writeOverlapText(newGrid, gx, gy, text);
          continue; // do not overwrite with next in this cell
        }
        // Normal write if not locked and next is non-empty
        if (next !== EMPTY && !lockedCells.has(key)) {
          newGrid[gy][gx] = next;
          cellOwners[gy][gx] = userId;
        }
      }
    }
  }
  // Update user's last region
  userRegions.set(userId, { x: ox, y: oy, width: region[0]?.length || 0, height: region.length });
  return newGrid.map(row => row.join(''));
}

wss.on('connection', (ws) => {
  const id = uuidv4();
  ws.send(JSON.stringify({ type: 'id', id }));
  // Send current grid and pool
  ws.send(JSON.stringify({ type: 'grid', grid: sharedGrid }));
  ws.send(JSON.stringify({ type: 'pool', pool: overlapPool }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'edit' && Array.isArray(data.grid)) {
        // Full grid edit (typing mode): apply without touching locked cells
        let buf = sharedGrid.map(row => row.split(''));
        for (let y = 0; y < ROWS; y++) {
          const rowIn = data.grid[y] || '';
          for (let x = 0; x < COLS; x++) {
            const key = gridKey(x, y);
            const incoming = rowIn[x] || EMPTY;
            if (lockedCells.has(key)) continue; // keep locked text
            const prevOwner = cellOwners[y][x];
            const prevCh = buf[y][x];
            if (
              prevCh !== EMPTY && incoming !== EMPTY && prevCh !== incoming && prevOwner && prevOwner !== id
            ) {
              const text = randomOverlapText();
              writeOverlapText(buf, x, y, text);
              continue;
            }
            buf[y][x] = incoming;
            if (incoming !== EMPTY) cellOwners[y][x] = id; else cellOwners[y][x] = null;
          }
        }
        sharedGrid = buf.map(r => r.join(''));
        broadcastGrid();
      }
      if (data.type === 'region' && Array.isArray(data.region) && typeof data.ox === 'number' && typeof data.oy === 'number') {
        // Region update (camera mode)
        sharedGrid = updateGridRegion(sharedGrid, data.region, data.ox, data.oy, id);
        broadcastGrid();
      }
      if (data.type === 'reset') {
        // Clear locked text and ownership
        let buf = sharedGrid.map(row => row.split(''));
        for (const key of lockedCells) {
          const [sx, sy] = key.split(',').map(Number);
          if (sx >= 0 && sx < COLS && sy >= 0 && sy < ROWS) {
            buf[sy][sx] = EMPTY;
            cellOwners[sy][sx] = null;
          }
        }
        sharedGrid = buf.map(r => r.join(''));
        lockedCells.clear();
        userRegions = new Map();
        broadcastGrid();
      }
      if (data.type === 'update_pool' && Array.isArray(data.pool)) {
        overlapPool = data.pool.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
        broadcastPool();
      }
      if (data.type === 'add_pool_text' && typeof data.text === 'string') {
        const t = data.text.trim();
        if (t) {
          overlapPool.push(t);
          broadcastPool();
        }
      }
    } catch (e) {}
  });
});
