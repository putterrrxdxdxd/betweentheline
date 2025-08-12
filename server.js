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

function gridKey(x, y) {
  return `${x},${y}`;
}

function updateGridRegion(grid, region, ox, oy) {
  let newStars = new Set(stars);
  let newGrid = grid.map(row => row.split(''));
  for (let y = 0; y < region.length; y++) {
    for (let x = 0; x < region[y].length; x++) {
      const gx = ox + x;
      const gy = oy + y;
      if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
        const prev = newGrid[gy][gx];
        const next = region[y][x];
        if (prev !== EMPTY && next !== EMPTY && prev !== next) {
          newStars.add(gridKey(gx, gy));
        }
        newGrid[gy][gx] = newStars.has(gridKey(gx, gy)) ? STAR : next;
      }
    }
  }
  return [newGrid.map(row => row.join('')), newStars];
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
  // Send current grid
  ws.send(JSON.stringify({ type: 'grid', grid: sharedGrid }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'edit' && Array.isArray(data.grid)) {
        // Full grid edit (typing mode)
        let newStars = new Set(stars);
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            if (sharedGrid[y][x] !== EMPTY && data.grid[y][x] !== EMPTY && sharedGrid[y][x] !== data.grid[y][x]) {
              newStars.add(gridKey(x, y));
            }
          }
        }
        sharedGrid = data.grid.map((row, y) =>
          row.split('').map((ch, x) => newStars.has(gridKey(x, y)) ? STAR : ch).join('')
        );
        stars = newStars;
        broadcastGrid();
      }
      if (data.type === 'region' && Array.isArray(data.region) && typeof data.ox === 'number' && typeof data.oy === 'number') {
        // Region update (camera mode)
        [sharedGrid, stars] = updateGridRegion(sharedGrid, data.region, data.ox, data.oy);
        broadcastGrid();
      }
      if (data.type === 'reset') {
        stars.clear();
        sharedGrid = sharedGrid.map(row => row.replace(/★/g, EMPTY));
        broadcastGrid();
      }
    } catch (e) {}
  });
});
