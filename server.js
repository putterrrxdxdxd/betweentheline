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
        // Overlap detection: mark stars where two or more edits differ from EMPTY
        let newStars = new Set(stars);
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            if (sharedGrid[y][x] !== EMPTY && data.grid[y][x] !== EMPTY && sharedGrid[y][x] !== data.grid[y][x]) {
              newStars.add(gridKey(x, y));
            }
          }
        }
        // Update grid
        sharedGrid = data.grid.map((row, y) =>
          row.split('').map((ch, x) => newStars.has(gridKey(x, y)) ? STAR : ch).join('')
        );
        stars = newStars;
        broadcastGrid();
      }
      if (data.type === 'reset') {
        stars.clear();
        // Remove all stars from grid
        sharedGrid = sharedGrid.map(row => row.replace(/★/g, EMPTY));
        broadcastGrid();
      }
    } catch (e) {}
  });
});
