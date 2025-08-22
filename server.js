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

// WebSocket server on the same port
const wss = new WebSocket.Server({ server });

// Shared collaborative grid
let sharedGrid = Array.from({ length: ROWS }, () => EMPTY.repeat(COLS));
// Set of persistent star positions
let stars = new Set();
// Track which user last wrote to each cell
let cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
// Track each user's last region (offset and size)
let userRegions = new Map();
let overlapPool = ['together', 'between the lines', 'merge'];
let lockedCells = new Set(); // Set of "x,y" keys for cells with overlap text

function gridKey(x, y) {
  return `${x},${y}`;
}

function randomOverlapText() {
  if (overlapPool.length === 0) return '*';
  return overlapPool[Math.floor(Math.random() * overlapPool.length)];
}

function writeOverlapText(grid, x, y) {
  const text = randomOverlapText();
  for (let i = 0; i < text.length && x + i < COLS; i++) {
    grid[y][x + i] = text[i];
    lockedCells.add(gridKey(x + i, y));
  }
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
        const key = gridKey(gx, gy);
        if (
          prev !== EMPTY && next !== EMPTY && prev !== next && prevOwner && prevOwner !== userId && !lockedCells.has(key)
        ) {
          writeOverlapText(newGrid, gx, gy);
        }
        if (next !== EMPTY) {
          newGrid[gy][gx] = next;
          cellOwners[gy][gx] = userId;
        }
      }
    }
  }
  // Update user's last region
  userRegions.set(userId, { x: ox, y: oy, width: region[0]?.length || 0, height: region.length });
  return [newGrid.map(row => row.join('')), stars];
}

function broadcastGrid() {
  const payload = JSON.stringify({ type: 'grid', grid: sharedGrid });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  const id = uuidv4();
  ws.send(JSON.stringify({ type: 'id', id }));
  ws.send(JSON.stringify({ type: 'grid', grid: sharedGrid }));
  ws.send(JSON.stringify({ type: 'pool', pool: overlapPool }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'add_pool_text' && typeof data.text === 'string' && data.text.trim()) {
        overlapPool.push(data.text.trim());
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'pool', pool: overlapPool }));
          }
        }
      }
      if (data.type === 'edit' && Array.isArray(data.grid)) {
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            const key = gridKey(x, y);
            if (
              sharedGrid[y][x] !== EMPTY && data.grid[y][x] !== EMPTY && sharedGrid[y][x] !== data.grid[y][x] &&
              cellOwners[y][x] && cellOwners[y][x] !== id && !lockedCells.has(key)
            ) {
              writeOverlapText(sharedGrid, x, y);
            }
            if (data.grid[y][x] !== EMPTY) {
              cellOwners[y][x] = id;
            }
          }
        }
        sharedGrid = data.grid.map(row => row); // No mapping to stars
        broadcastGrid();
      }
      if (data.type === 'region' && Array.isArray(data.region) && typeof data.ox === 'number' && typeof data.oy === 'number') {
        // Region update (camera mode)
        [sharedGrid, stars] = updateGridRegion(sharedGrid, data.region, data.ox, data.oy, id);
        broadcastGrid();
      }
      if (data.type === 'reset') {
        stars.clear();
        sharedGrid = sharedGrid.map(row => row.replace(/\u2605/g, EMPTY));
        cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        userRegions = new Map();
        lockedCells.clear();
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'pool', pool: overlapPool }));
          }
        }
        broadcastGrid();
      }
    } catch (e) {}
  });
});
