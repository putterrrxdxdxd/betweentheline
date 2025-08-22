const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');

const COLS = 160;
const ROWS = 60;
const EMPTY = '.';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

// Handle favicon request
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP/WS server running on http://0.0.0.0:${PORT}`);
});

const wss = new WebSocket.Server({ server });

// Grid in 2D array
let sharedGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
let overlapPool = ['together', 'between the lines', 'merge'];

// Track cell ownership and locked cells
let cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
let lockedCells = new Set(); // Set of "x,y" keys for cells with overlap text

function gridKey(x, y) {
  return `${x},${y}`;
}

function randomOverlapText() {
  if (!overlapPool || overlapPool.length === 0) return '*';
  return overlapPool[Math.floor(Math.random() * overlapPool.length)];
}

function writeOverlapText(startX, y, text) {
  const textDiffs = [];
  for (let k = 0; k < text.length; k++) {
    const gx = startX + k;
    if (gx >= COLS) break;
    const key = gridKey(gx, y);
    sharedGrid[y][gx] = text[k];
    lockedCells.add(key);
    cellOwners[y][gx] = null; // Overlap text has no owner
    textDiffs.push({ x: gx, y, char: text[k] });
  }
  return textDiffs;
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  const id = uuidv4();
  ws.send(JSON.stringify({ type: 'id', id }));
  ws.send(JSON.stringify({ type: 'grid', grid: sharedGrid.map(r => r.join('')) }));
  ws.send(JSON.stringify({ type: 'pool', pool: overlapPool }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'edit' && Array.isArray(data.grid)) {
        // Full grid edit (typing mode) - detect overlaps
        let allDiffs = [];
        for (let y = 0; y < ROWS; y++) {
          const rowIn = data.grid[y] || '';
          for (let x = 0; x < COLS; x++) {
            const key = gridKey(x, y);
            if (lockedCells.has(key)) continue; // Skip locked cells
            
            const incoming = rowIn[x] || EMPTY;
            const prevChar = sharedGrid[y][x];
            const prevOwner = cellOwners[y][x];
            
            // Check for overlap: different user writing non-empty over another user's non-empty
            if (prevChar !== EMPTY && incoming !== EMPTY && prevChar !== incoming && 
                prevOwner && prevOwner !== id) {
              // Overlap detected! Insert text from pool
              const text = randomOverlapText();
              const textDiffs = writeOverlapText(x, y, text);
              allDiffs.push(...textDiffs);
              continue; // Don't process this cell normally
            }
            
            // Normal update
            if (sharedGrid[y][x] !== incoming) {
              sharedGrid[y][x] = incoming;
              cellOwners[y][x] = incoming !== EMPTY ? id : null;
              allDiffs.push({ x, y, char: incoming });
            }
          }
        }
        if (allDiffs.length > 0) {
          broadcast({ type: 'diff', diffs: allDiffs });
        }
      }

      if (data.type === 'diff' && Array.isArray(data.diffs)) {
        const allDiffs = [];
        for (const { x, y, char } of data.diffs) {
          if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
            const key = gridKey(x, y);
            if (lockedCells.has(key)) continue; // Skip locked cells
            
            const prevChar = sharedGrid[y][x];
            const prevOwner = cellOwners[y][x];
            
            // Check for overlap: different user writing non-empty over another user's non-empty
            if (prevChar !== EMPTY && char !== EMPTY && prevChar !== char && 
                prevOwner && prevOwner !== id) {
              // Overlap detected! Insert text from pool
              const text = randomOverlapText();
              const textDiffs = writeOverlapText(x, y, text);
              allDiffs.push(...textDiffs);
              continue; // Don't process this cell normally
            }
            
            // Normal update
            if (sharedGrid[y][x] !== char) {
              sharedGrid[y][x] = char;
              cellOwners[y][x] = char !== EMPTY ? id : null;
              allDiffs.push({ x, y, char });
            }
          }
        }
        if (allDiffs.length > 0) {
          broadcast({ type: 'diff', diffs: allDiffs });
        }
      }

      if (data.type === 'reset') {
        sharedGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
        cellOwners = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        lockedCells.clear();
        broadcast({ type: 'grid', grid: sharedGrid.map(r => r.join('')) });
      }

      if (data.type === 'add_pool_text' && typeof data.text === 'string') {
        const t = data.text.trim();
        if (t) {
          overlapPool.push(t);
          broadcast({ type: 'pool', pool: overlapPool });
        }
      }

    } catch (e) {
      console.error('Message error', e.message);
    }
  });
});
