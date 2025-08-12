const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const COLS = 500;
const ROWS = 200;
const EMPTY = '.';

// Map client id to {ascii, offset: {x, y}}
let players = new Map();
let wsToId = new Map();

function combineGrids() {
  let grid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
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
          if (ch !== EMPTY) grid[gy][gx] = ch;
        }
      }
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

const wss = new WebSocket.Server({ port: 9000 });
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

console.log('WebSocket server running on ws://localhost:9000');
