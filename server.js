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

// Map client id to {ascii, offset: {x, y}}
let players = new Map();
let wsToId = new Map();
// Set of persistent star positions
let stars = new Set();

function gridKey(x, y) {
  return `${x},${y}`;
}

function combineGrids() {
  let grid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
  let cellCounts = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  // First pass: count how many players at each cell
  for (const { ascii, offset } of players.values()) {
    if (!ascii) continue;
    const ox = offset?.x || 0;
    const oy = offset?.y || 0;
    for (let y = 0; y < ascii.length; y++) {
      for (let x = 0; x < (ascii[y] ? ascii[y].length : 0); x++) {
        const gx = ox + x;
        const gy = oy + y;
        if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
          const ch = ascii[y][x] || EMPTY;
          if (ch !== EMPTY) cellCounts[gy][gx] += 1;
        }
      }
    }
  }
  // Mark new stars for overlaps
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (cellCounts[y][x] > 1) {
        stars.add(gridKey(x, y));
      }
    }
  }
  // Second pass: render grid, overlaying persistent stars
  for (const { ascii, offset } of players.values()) {
    if (!ascii) continue;
    const ox = offset?.x || 0;
    const oy = offset?.y || 0;
    for (let y = 0; y < ascii.length; y++) {
      for (let x = 0; x < (ascii[y] ? ascii[y].length : 0); x++) {
        const gx = ox + x;
        const gy = oy + y;
        if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) {
          const key = gridKey(gx, gy);
          if (stars.has(key)) {
            grid[gy][gx] = STAR;
          } else {
            const ch = ascii[y][x] || EMPTY;
            if (ch !== EMPTY) grid[gy][gx] = ch;
          }
        }
      }
    }
  }
  // Overlay all persistent stars (in case no player is currently on them)
  for (const key of stars) {
    const [x, y] = key.split(',').map(Number);
    if (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
      grid[y][x] = STAR;
    }
  }
  return grid.map(row => row.join(''));
}

function randomOffset() {
  return {
    x: Math.floor(Math.random() * (COLS - 160)),
    y: Math.floor(Math.random() * (ROWS - 60))
  };
}

wss.on('connection', (ws) => {
  const id = uuidv4();
  wsToId.set(ws, id);
  // Assign random offset
  players.set(id, { ascii: null, offset: randomOffset() });
  ws.send(JSON.stringify({ type: 'id', id }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (Array.isArray(data.ascii)) {
        const player = players.get(id) || { offset: randomOffset() };
        player.ascii = data.ascii;
        players.set(id, player);
      }
      if (data.offset && typeof data.offset.x === 'number' && typeof data.offset.y === 'number') {
        const player = players.get(id) || { ascii: null, offset: randomOffset() };
        player.offset = data.offset;
        players.set(id, player);
      }
      if (data.type === 'reset') {
        stars.clear();
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    players.delete(id);
    wsToId.delete(ws);
  });
});

setInterval(() => {
  const gridArr = combineGrids();
  const payload = JSON.stringify({ type: 'grid', grid: gridArr });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}, 1000 / 15);
