const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── ESTADO DEL SERVIDOR ──────────────────────────────────────────
const rooms = {};   // code → room
const clients = {}; // ws → { id, code }

const PALABRAS_DEFAULT = [
  'perro','gato','delfín','elefante','pingüino','cocodrilo',
  'pizza','hamburguesa','sushi','arepa','chocolate','helado',
  'playa','montaña','aeropuerto','hospital','biblioteca','estadio',
  'tijeras','telescopio','paraguas','linterna','guitarra','reloj',
  'fútbol','baloncesto','natación','tenis','boxeo','ciclismo',
  'volcán','cohete','submarino','castillo','espada','brújula'
];

function genCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function broadcast(code, msg, excludeId = null) {
  const room = rooms[code];
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const [ws, info] of Object.entries(room.wsMap || {})) {
    if (info.id !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastAll(code, msg) {
  broadcast(code, msg, null);
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getRoomPublic(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    players[id] = { name: p.name, avatar: p.avatar };
  }
  return {
    code: room.code,
    host: room.host,
    maxPlayers: room.maxPlayers,
    numImpostors: room.numImpostors,
    status: room.status,
    players,
    currentTurn: room.currentTurn,
    turnOrder: room.turnOrder,
    chat: room.chat,
    voteProposal: room.voteProposal,
    votes: room.votes,
    voteActive: room.voteActive,
  };
}

// ── WEBSOCKET ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.set ? null : null; // no-op, use room.wsMap

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;

    switch (type) {

      // ── CREAR SALA ──────────────────────────────────────────
      case 'CREATE_ROOM': {
        const { id, name, avatar, maxPlayers, numImpostors, palabras } = payload;
        const code = genCode();
        rooms[code] = {
          code,
          host: id,
          maxPlayers: maxPlayers || 6,
          numImpostors: numImpostors || 1,
          palabras: (palabras && palabras.length) ? palabras : PALABRAS_DEFAULT,
          status: 'waiting',
          players: { [id]: { name, avatar } },
          wsMap: { [ws]: { id } },
          chat: [],
          turnOrder: [],
          currentTurn: 0,
          voteProposal: { active: false, si: [], no: [] },
          voteActive: false,
          votes: {},
          roles: {},
          palabra: '',
          voteTimer: null,
        };
        // store ws reference
        rooms[code].wsMap = new Map([[ws, { id }]]);
        ws._roomCode = code;
        ws._playerId = id;
        send(ws, { type: 'ROOM_CREATED', payload: { code, room: getRoomPublic(rooms[code]) } });
        break;
      }

      // ── UNIRSE A SALA ───────────────────────────────────────
      case 'JOIN_ROOM': {
        const { id, name, avatar, code } = payload;
        const room = rooms[code];
        if (!room) { send(ws, { type: 'ERROR', payload: 'Partida no encontrada' }); return; }
        if (room.status !== 'waiting') { send(ws, { type: 'ERROR', payload: 'La partida ya inició' }); return; }
        const pCount = Object.keys(room.players).length;
        if (pCount >= room.maxPlayers) { send(ws, { type: 'ERROR', payload: 'Partida llena' }); return; }

        room.players[id] = { name, avatar };
        room.wsMap.set(ws, { id });
        ws._roomCode = code;
        ws._playerId = id;

        send(ws, { type: 'ROOM_JOINED', payload: { code, room: getRoomPublic(room) } });
        broadcastAll(code, { type: 'ROOM_UPDATE', payload: getRoomPublic(room) });
        break;
      }

      // ── LISTAR SALAS ────────────────────────────────────────
      case 'LIST_ROOMS': {
        const list = Object.values(rooms)
          .filter(r => r.status === 'waiting')
          .map(r => ({
            code: r.code,
            playerCount: Object.keys(r.players).length,
            maxPlayers: r.maxPlayers,
          }));
        send(ws, { type: 'ROOMS_LIST', payload: list });
        break;
      }

      // ── INICIAR PARTIDA ─────────────────────────────────────
      case 'START_GAME': {
        const { id, code } = payload;
        const room = rooms[code];
        if (!room || room.host !== id) return;
        const players = Object.keys(room.players);
        if (players.length < 2) { send(ws, { type: 'ERROR', payload: 'Necesitas al menos 2 jugadores' }); return; }

        const palabra = room.palabras[Math.floor(Math.random() * room.palabras.length)];
        const shuffled = players.slice().sort(() => Math.random() - 0.5);
        const impostores = shuffled.slice(0, room.numImpostors);
        room.roles = {};
        players.forEach(pid => { room.roles[pid] = impostores.includes(pid) ? 'impostor' : 'civil'; });
        room.palabra = palabra;
        room.turnOrder = players.slice().sort(() => Math.random() - 0.5);
        room.currentTurn = 0;
        room.chat = [];
        room.status = 'playing';
        room.voteProposal = { active: false, si: [], no: [] };
        room.voteActive = false;
        room.votes = {};

        // Enviar rol individual a cada jugador
        for (const [wsConn, info] of room.wsMap) {
          const pid = info.id;
          const role = room.roles[pid];
          send(wsConn, {
            type: 'GAME_STARTED',
            payload: {
              role,
              palabra: role === 'civil' ? room.palabra : null,
              turnOrder: room.turnOrder,
              room: getRoomPublic(room),
            }
          });
        }
        break;
      }

      // ── CHAT ────────────────────────────────────────────────
      case 'CHAT_MSG': {
        const { id, code, text } = payload;
        const room = rooms[code];
        if (!room) return;
        const current = room.turnOrder[room.currentTurn % room.turnOrder.length];
        if (current !== id) { send(ws, { type: 'ERROR', payload: 'No es tu turno' }); return; }
        const msg2 = { id, name: room.players[id].name, text };
        room.chat.push(msg2);
        room.currentTurn++;
        broadcastAll(code, { type: 'CHAT_UPDATE', payload: { msg: msg2, currentTurn: room.currentTurn, turnOrder: room.turnOrder } });
        break;
      }

      // ── PROPONER VOTACIÓN ───────────────────────────────────
      case 'PROPOSE_VOTE': {
        const { id, code } = payload;
        const room = rooms[code];
        if (!room || room.voteProposal.active || room.voteActive) return;
        room.voteProposal = { active: true, si: [id], no: [] };
        broadcastAll(code, { type: 'VOTE_PROPOSED', payload: { proposedBy: id, voteProposal: room.voteProposal, total: Object.keys(room.players).length } });
        break;
      }

      // ── RESPONDER PROPUESTA ─────────────────────────────────
      case 'ANSWER_PROPOSAL': {
        const { id, code, answer } = payload;
        const room = rooms[code];
        if (!room || !room.voteProposal.active) return;
        if (answer === 'si' && !room.voteProposal.si.includes(id)) room.voteProposal.si.push(id);
        if (answer === 'no' && !room.voteProposal.no.includes(id)) room.voteProposal.no.push(id);

        const total = Object.keys(room.players).length;
        const needed = Math.ceil(total / 2);
        broadcastAll(code, { type: 'PROPOSAL_UPDATE', payload: { voteProposal: room.voteProposal, needed } });

        if (room.voteProposal.si.length >= needed) {
          room.voteProposal.active = false;
          room.voteActive = true;
          room.votes = {};
          broadcastAll(code, { type: 'VOTING_START', payload: { players: getRoomPublic(room).players } });

          // Timer 12s
          if (room.voteTimer) clearTimeout(room.voteTimer);
          room.voteTimer = setTimeout(() => {
            if (rooms[code]) endVoting(code);
          }, 12000);
        }
        break;
      }

      // ── EMITIR VOTO ─────────────────────────────────────────
      case 'CAST_VOTE': {
        const { id, code, target } = payload;
        const room = rooms[code];
        if (!room || !room.voteActive) return;
        room.votes[id] = target;
        // Contar para mostrar en vivo
        const counts = {};
        Object.values(room.votes).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
        broadcastAll(code, { type: 'VOTE_UPDATE', payload: { votes: room.votes, counts } });
        break;
      }

      default: break;
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
    // Limpiar sala vacía
    if (Object.keys(room.players).length === 0) {
      if (room.voteTimer) clearTimeout(room.voteTimer);
      delete rooms[code];
      return;
    }
    // Si el host se fue, pasar host al siguiente
    if (room.host === id) {
      room.host = Object.keys(room.players)[0];
    }
    broadcastAll(code, { type: 'ROOM_UPDATE', payload: getRoomPublic(room) });
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
    const role = room.roles[expelled];
    result = { expelled, expelledName: room.players[expelled]?.name, role, tie: false };
    delete room.players[expelled];
    delete room.roles[expelled];
    room.turnOrder = room.turnOrder.filter(id => id !== expelled);
  }
  broadcastAll(code, { type: 'VOTING_END', payload: result });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Gordos Game corriendo en http://localhost:${PORT}`));
