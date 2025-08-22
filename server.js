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

// Shared collaborative grid as 2D array
let sharedGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
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
          if (cellOwners[gy][gx] === userId && newGrid[gy][gx] !== STAR && !lockedCells.has(gridKey(gx, gy))) {
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
        // Prevent overwriting locked cells
        if (next !== EMPTY && !lockedCells.has(key)) {
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
  const payload = JSON.stringify({ type: 'grid', grid: sharedGrid.map(row => row.join('')) });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function unpackDiffs(buffer) {
  const count = buffer.readUInt16LE(0);
  const diffs = [];
  for (let i = 0; i < count; i++) {
    const x = buffer.readUInt16LE(2 + i * 5);
    const y = buffer.readUInt16LE(4 + i * 5);
    const char = String.fromCharCode(buffer.readUInt8(6 + i * 5));
    diffs.push({ x, y, char });
  }
  return diffs;
}
function packDiffs(diffs) {
  const buffer = Buffer.alloc(2 + diffs.length * 5);
  buffer.writeUInt16LE(diffs.length, 0);
  for (let i = 0; i < diffs.length; i++) {
    buffer.writeUInt16LE(diffs[i].x, 2 + i * 5);
    buffer.writeUInt16LE(diffs[i].y, 4 + i * 5);
    buffer.writeUInt8(diffs[i].char.charCodeAt(0), 6 + i * 5);
  }
  return buffer;
}

wss.on('connection', (ws) => {
  const id = uuidv4();
  ws.send(JSON.stringify({ type: 'id', id }));
  ws.send(JSON.stringify({ type: 'grid', grid: sharedGrid.map(row => row.join('')) }));
  ws.send(JSON.stringify({ type: 'pool', pool: overlapPool }));
  ws.on('message', (msg, isBinary) => {
    try {
      if (isBinary) {
        // Binary diff message
        const diffs = unpackDiffs(msg);
        let diffsToSend = [];
        for (const { x, y, char } of diffs) {
          if (
            x >= 0 && x < COLS && y >= 0 && y < ROWS &&
            typeof char === 'string' && char.length === 1 && !lockedCells.has(gridKey(x, y))
          ) {
            if (char !== EMPTY) {
              // Overlap logic for body pixels only
              if (
                sharedGrid[y][x] !== EMPTY && sharedGrid[y][x] !== char &&
                cellOwners[y][x] && cellOwners[y][x] !== id && !lockedCells.has(gridKey(x, y))
              ) {
                writeOverlapText(sharedGrid, x, y);
                const text = randomOverlapText();
                for (let i = 0; i < text.length && x + i < COLS; i++) {
                  sharedGrid[y][x + i] = text[i];
                  lockedCells.add(gridKey(x + i, y));
                  diffsToSend.push({ x: x + i, y, char: text[i] });
                }
                continue;
              }
              sharedGrid[y][x] = char;
              cellOwners[y][x] = id;
              diffsToSend.push({ x, y, char });
            } else {
              // Erase cell, but don't set cellOwners, and don't erase locked cells
              if (!lockedCells.has(gridKey(x, y))) {
                sharedGrid[y][x] = EMPTY;
                cellOwners[y][x] = null;
                diffsToSend.push({ x, y, char });
              }
            }
          }
        }
        if (diffsToSend.length > 0) {
          const outBuf = packDiffs(diffsToSend);
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(outBuf, { binary: true });
            }
          }
        }
      } else {
        // JSON message
        const data = JSON.parse(msg);
        if (data.type === 'add_pool_text' && typeof data.text === 'string' && data.text.trim()) {
          overlapPool.push(data.text.trim());
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'pool', pool: overlapPool }));
            }
          }
        }
        if (data.type === 'delete_pool_text' && typeof data.text === 'string') {
          overlapPool = overlapPool.filter(t => t !== data.text);
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'pool', pool: overlapPool }));
            }
          }
        }
        if (data.type === 'region' && Array.isArray(data.region) && typeof data.ox === 'number' && typeof data.oy === 'number') {
          [sharedGrid, stars] = updateGridRegion(sharedGrid, data.region, data.ox, data.oy, id);
          broadcastGrid();
        }
        if (data.type === 'reset') {
          stars.clear();
          sharedGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
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
      }
    } catch (e) { console.error(e); }
  });
});
