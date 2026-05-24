const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir index.html desde la raíz del proyecto
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── PALABRAS DEFAULT ─────────────────────────────────────────────
const PALABRAS_DEFAULT = [
  'perro','gato','delfín','elefante','pingüino','cocodrilo',
  'pizza','hamburguesa','sushi','arepa','chocolate','helado',
  'playa','montaña','aeropuerto','hospital','biblioteca','estadio',
  'tijeras','telescopio','paraguas','linterna','guitarra','reloj',
  'fútbol','baloncesto','natación','tenis','boxeo','ciclismo',
  'volcán','cohete','submarino','castillo','espada','brújula'
];

const rooms = {};

function genCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function broadcastAll(code, type, payload) {
  const room = rooms[code];
  if (!room) return;
  for (const [wsConn] of room.wsMap) {
    send(wsConn, type, payload);
  }
}

function getRoomPublic(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    players[id] = { name: p.name, avatar: p.avatar };
  }
  return {
    code: room.code, host: room.host,
    maxPlayers: room.maxPlayers, numImpostors: room.numImpostors,
    status: room.status, players,
    currentTurn: room.currentTurn, turnOrder: room.turnOrder,
    chat: room.chat,
  };
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload: p } = msg;

    switch (type) {

      case 'CREATE_ROOM': {
        const code = genCode();
        rooms[code] = {
          code, host: p.id,
          maxPlayers: p.maxPlayers || 6,
          numImpostors: p.numImpostors || 1,
          palabras: (p.palabras && p.palabras.length >= 2) ? p.palabras : PALABRAS_DEFAULT,
          status: 'waiting',
          players: { [p.id]: { name: p.name, avatar: p.avatar } },
          wsMap: new Map([[ws, { id: p.id }]]),
          chat: [], turnOrder: [], currentTurn: 0,
          roles: {}, palabra: '',
          voteProposal: { active: false, si: [], no: [] },
          voteActive: false, votes: {}, voteTimer: null,
        };
        ws._roomCode = code;
        ws._playerId = p.id;
        send(ws, 'ROOM_CREATED', { code, room: getRoomPublic(rooms[code]) });
        break;
      }

      case 'JOIN_ROOM': {
        const room = rooms[p.code];
        if (!room) { send(ws, 'ERROR', 'Partida no encontrada'); return; }
        if (room.status !== 'waiting') { send(ws, 'ERROR', 'La partida ya inició'); return; }
        if (Object.keys(room.players).length >= room.maxPlayers) { send(ws, 'ERROR', 'Partida llena'); return; }
        room.players[p.id] = { name: p.name, avatar: p.avatar };
        room.wsMap.set(ws, { id: p.id });
        ws._roomCode = p.code;
        ws._playerId = p.id;
        send(ws, 'ROOM_JOINED', { code: p.code, room: getRoomPublic(room) });
        broadcastAll(p.code, 'ROOM_UPDATE', getRoomPublic(room));
        break;
      }

      case 'LIST_ROOMS': {
        const list = Object.values(rooms)
          .filter(r => r.status === 'waiting')
          .map(r => ({ code: r.code, playerCount: Object.keys(r.players).length, maxPlayers: r.maxPlayers }));
        send(ws, 'ROOMS_LIST', list);
        break;
      }

      case 'START_GAME': {
        const room = rooms[p.code];
        if (!room || room.host !== p.id) return;
        const players = Object.keys(room.players);
        if (players.length < 2) { send(ws, 'ERROR', 'Necesitas al menos 2 jugadores'); return; }
        const palabra = room.palabras[Math.floor(Math.random() * room.palabras.length)];
        const shuffled = [...players].sort(() => Math.random() - 0.5);
        room.roles = {};
        players.forEach(id => { room.roles[id] = shuffled.slice(0, room.numImpostors).includes(id) ? 'impostor' : 'civil'; });
        room.palabra = palabra;
        room.turnOrder = [...players].sort(() => Math.random() - 0.5);
        room.currentTurn = 0;
        room.chat = [];
        room.status = 'playing';
        room.voteProposal = { active: false, si: [], no: [] };
        room.voteActive = false;
        room.votes = {};
        for (const [wsConn, info] of room.wsMap) {
          const role = room.roles[info.id];
          send(wsConn, 'GAME_STARTED', {
            role, palabra: role === 'civil' ? palabra : null,
            room: getRoomPublic(room)
          });
        }
        break;
      }

      case 'CHAT_MSG': {
        const room = rooms[p.code];
        if (!room) return;
        const current = room.turnOrder[room.currentTurn % room.turnOrder.length];
        if (current !== p.id) { send(ws, 'ERROR', 'No es tu turno'); return; }
        const chatMsg = { id: p.id, name: room.players[p.id].name, text: p.text };
        room.chat.push(chatMsg);
        room.currentTurn++;
        broadcastAll(p.code, 'CHAT_UPDATE', { msg: chatMsg, currentTurn: room.currentTurn, turnOrder: room.turnOrder });
        break;
      }

      case 'PROPOSE_VOTE': {
        const room = rooms[p.code];
        if (!room || room.voteProposal.active || room.voteActive) return;
        room.voteProposal = { active: true, si: [p.id], no: [] };
        broadcastAll(p.code, 'VOTE_PROPOSED', { proposedBy: p.id, voteProposal: room.voteProposal, total: Object.keys(room.players).length });
        break;
      }

      case 'ANSWER_PROPOSAL': {
        const room = rooms[p.code];
        if (!room || !room.voteProposal.active) return;
        if (p.answer === 'si' && !room.voteProposal.si.includes(p.id)) room.voteProposal.si.push(p.id);
        if (p.answer === 'no' && !room.voteProposal.no.includes(p.id)) room.voteProposal.no.push(p.id);
        const total = Object.keys(room.players).length;
        const needed = Math.ceil(total / 2);
        broadcastAll(p.code, 'PROPOSAL_UPDATE', { voteProposal: room.voteProposal, needed });
        if (room.voteProposal.si.length >= needed) {
          room.voteProposal.active = false;
          room.voteActive = true;
          room.votes = {};
          broadcastAll(p.code, 'VOTING_START', { players: getRoomPublic(room).players });
          if (room.voteTimer) clearTimeout(room.voteTimer);
          room.voteTimer = setTimeout(() => { if (rooms[p.code]) endVoting(p.code); }, 12000);
        }
        break;
      }

      case 'CAST_VOTE': {
        const room = rooms[p.code];
        if (!room || !room.voteActive) return;
        room.votes[p.id] = p.target;
        const counts = {};
        Object.values(room.votes).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
        broadcastAll(p.code, 'VOTE_UPDATE', { counts });
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws._roomCode;
    const id = ws._playerId;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.wsMap.delete(ws);
    delete room.players[id];
    delete room.roles[id];
    if (Object.keys(room.players).length === 0) {
      if (room.voteTimer) clearTimeout(room.voteTimer);
      delete rooms[code];
      return;
    }
    if (room.host === id) room.host = Object.keys(room.players)[0];
    broadcastAll(code, 'ROOM_UPDATE', getRoomPublic(room));
  });
});

function endVoting(code) {
  const room = rooms[code];
  if (!room) return;
  room.voteActive = false;
  room.voteTimer = null;
  const counts = {};
  Object.values(room.votes).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  let maxV = 0, expelled = null;
  Object.entries(counts).forEach(([id, c]) => { if (c > maxV) { maxV = c; expelled = id; } });
  let result;
  if (!expelled) {
    result = { expelled: null, role: null, tie: true };
  } else {
    result = { expelled, expelledName: room.players[expelled]?.name, role: room.roles[expelled], tie: false };
    delete room.players[expelled];
    delete room.roles[expelled];
    room.turnOrder = room.turnOrder.filter(id => id !== expelled);
  }
  room.status = result.role === 'impostor' ? 'ended' : 'playing';
  room.currentTurn = 0;
  broadcastAll(code, 'VOTING_END', result);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Gordos Game corriendo en http://localhost:${PORT}`));
