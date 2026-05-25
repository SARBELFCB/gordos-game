const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── PALABRAS ─────────────────────────────────────────────────────
const PALABRAS_DEFAULT = [
  'perro','gato','delfín','elefante','pingüino','cocodrilo',
  'pizza','hamburguesa','sushi','arepa','chocolate','helado',
  'playa','montaña','aeropuerto','hospital','biblioteca','estadio',
  'tijeras','telescopio','paraguas','linterna','guitarra','reloj',
  'fútbol','baloncesto','natación','tenis','boxeo','ciclismo',
  'volcán','cohete','submarino','castillo','espada','brújula'
];

// ── USUARIOS (en memoria — en producción usar DB) ─────────────────
const users = {}; // { userId: { name, level, xp, createdAt } }
const pendingCodes = {}; // { code: { name, expires } }

function xpForLevel(level) { return Math.floor(100 * Math.pow(1.4, level - 1)); }
function genCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function genVerifyCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

// ── ANTI-BOT: generar código de verificación ──────────────────────
app.post('/api/request-code', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) return res.json({ ok: false, error: 'Nombre muy corto' });
  const code = genVerifyCode();
  const key = crypto.randomBytes(8).toString('hex');
  pendingCodes[key] = { name: name.trim(), code, expires: Date.now() + 5 * 60 * 1000 };
  // En producción enviarías el código por email/SMS
  // Aquí lo devolvemos en consola (para demo lo enviamos en respuesta oculta)
  console.log(`[VERIFY] ${name}: ${code}`);
  res.json({ ok: true, key, _demo_code: code }); // en prod quitar _demo_code
});

app.post('/api/verify', (req, res) => {
  const { key, code } = req.body;
  const pending = pendingCodes[key];
  if (!pending) return res.json({ ok: false, error: 'Código expirado' });
  if (Date.now() > pending.expires) { delete pendingCodes[key]; return res.json({ ok: false, error: 'Código expirado' }); }
  if (pending.code !== code.trim()) return res.json({ ok: false, error: 'Código incorrecto' });
  const userId = 'u_' + crypto.randomBytes(10).toString('hex');
  users[userId] = { name: pending.name, level: 1, xp: 0, createdAt: Date.now() };
  delete pendingCodes[key];
  res.json({ ok: true, userId, name: pending.name });
});

app.get('/api/ranking', (req, res) => {
  const ranking = Object.entries(users)
    .map(([id, u]) => ({ id, name: u.name, level: u.level, xp: u.xp }))
    .sort((a, b) => b.level !== a.level ? b.level - a.level : b.xp - a.xp)
    .slice(0, 20);
  res.json(ranking);
});

// ── TRADUCCIÓN ────────────────────────────────────────────────────
async function translateText(text, from, to) {
  if (from === to || !text.trim()) return { text, translated: false };
  try {
    const res = await fetch('https://libretranslate.com/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: from, target: to, format: 'text' }),
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.translatedText) return { text: data.translatedText, translated: true };
    }
  } catch {}
  return { text, translated: false };
}

// ── ROOMS ─────────────────────────────────────────────────────────
const rooms = {};

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function broadcastAll(code, type, payload) {
  const room = rooms[code];
  if (!room) return;
  for (const [wsConn] of room.wsMap) send(wsConn, type, payload);
}

function getRoomPublic(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players))
    players[id] = { name: p.name, avatar: p.avatar, level: p.level || 1, xp: p.xp || 0, lang: p.lang || 'es' };
  return { code: room.code, host: room.host, maxPlayers: room.maxPlayers,
    numImpostors: room.numImpostors, status: room.status, players,
    currentTurn: room.currentTurn, turnOrder: room.turnOrder, chat: room.chat };
}

function checkImpostorWin(room) {
  const ids = Object.keys(room.players);
  const imps = ids.filter(id => room.roles[id] === 'impostor').length;
  const civs = ids.filter(id => room.roles[id] === 'civil').length;
  return imps >= civs;
}

function awardXP(room, playerId, amount) {
  const p = room.players[playerId];
  if (!p) return null;
  p.xp = (p.xp || 0) + amount;
  // Also update global user record
  if (p.userId && users[p.userId]) {
    users[p.userId].xp = (users[p.userId].xp || 0) + amount;
    users[p.userId].level = p.level || 1;
  }
  const old = p.level || 1;
  while (p.xp >= xpForLevel(p.level || 1)) {
    p.xp -= xpForLevel(p.level || 1);
    p.level = (p.level || 1) + 1;
    if (p.userId && users[p.userId]) users[p.userId].level = p.level;
  }
  if (p.userId && users[p.userId]) users[p.userId].xp = p.xp;
  return p.level > old ? p.level : null;
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload: p } = msg;

    switch (type) {
      case 'CREATE_ROOM': {
        const code = genCode();
        rooms[code] = {
          code, host: p.id, maxPlayers: p.maxPlayers || 6, numImpostors: p.numImpostors || 1,
          palabras: (p.palabras && p.palabras.length >= 2) ? p.palabras : PALABRAS_DEFAULT,
          status: 'waiting',
          players: { [p.id]: { name: p.name, avatar: p.avatar, level: p.level||1, xp: p.xp||0, lang: p.lang||'es', userId: p.userId } },
          wsMap: new Map([[ws, { id: p.id }]]),
          chat: [], turnOrder: [], currentTurn: 0, roles: {}, palabra: '',
          voteActive: false, votes: {}, voteTimer: null, discussionTimer: null, phase: 'waiting',
          allSpoke: false,
        };
        ws._roomCode = code; ws._playerId = p.id;
        send(ws, 'ROOM_CREATED', { code, room: getRoomPublic(rooms[code]) });
        break;
      }

      case 'JOIN_ROOM': {
        const room = rooms[p.code];
        if (!room) { send(ws, 'ERROR', 'Partida no encontrada'); return; }
        if (room.status !== 'waiting') { send(ws, 'ERROR', 'La partida ya inició'); return; }
        if (Object.keys(room.players).length >= room.maxPlayers) { send(ws, 'ERROR', 'Partida llena'); return; }
        room.players[p.id] = { name: p.name, avatar: p.avatar, level: p.level||1, xp: p.xp||0, lang: p.lang||'es', userId: p.userId };
        room.wsMap.set(ws, { id: p.id });
        ws._roomCode = p.code; ws._playerId = p.id;
        send(ws, 'ROOM_JOINED', { code: p.code, room: getRoomPublic(room) });
        broadcastAll(p.code, 'ROOM_UPDATE', getRoomPublic(room));
        break;
      }

      case 'LIST_ROOMS': {
        const list = Object.values(rooms).filter(r => r.status === 'waiting')
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
        const impostores = shuffled.slice(0, room.numImpostors);
        room.roles = {};
        players.forEach(id => { room.roles[id] = impostores.includes(id) ? 'impostor' : 'civil'; });
        room.palabra = palabra;
        room.turnOrder = [...players].sort(() => Math.random() - 0.5);
        room.currentTurn = 0; room.chat = []; room.status = 'playing';
        room.phase = 'chat'; room.voteActive = false; room.votes = {};
        room.spokeIds = new Set(); // track who has spoken this round
        for (const [wsConn, info] of room.wsMap) {
          const role = room.roles[info.id];
          send(wsConn, 'GAME_STARTED', { role, palabra: role === 'civil' ? palabra : null, room: getRoomPublic(room) });
        }
        break;
      }

      case 'CHAT_MSG': {
        const room = rooms[p.code];
        if (!room || room.phase === 'voting') return;
        if (room.phase === 'chat') {
          const current = room.turnOrder[room.currentTurn % room.turnOrder.length];
          if (current !== p.id) { send(ws, 'ERROR', 'No es tu turno'); return; }
        }
        const senderLang = room.players[p.id]?.lang || 'es';
        const baseMsg = { id: p.id, name: room.players[p.id].name, text: p.text, lang: senderLang, level: room.players[p.id]?.level || 1 };
        room.chat.push(baseMsg);
        if (!room.spokeIds) room.spokeIds = new Set();
        room.spokeIds.add(p.id);

        if (room.phase === 'chat') {
          room.currentTurn++;
          // Check if everyone spoke at least once
          const allPlayers = Object.keys(room.players);
          const allSpoke = allPlayers.every(id => room.spokeIds.has(id));
          if (allSpoke && room.currentTurn >= allPlayers.length) {
            // Broadcast all-spoke event before sending message
            broadcastAll(p.code, 'ALL_SPOKE', {});
          }
        }

        // Send with per-player translation
        for (const [wsConn, info] of room.wsMap) {
          const receiverLang = room.players[info.id]?.lang || 'es';
          if (receiverLang !== senderLang) {
            const tx = await translateText(p.text, senderLang, receiverLang);
            send(wsConn, 'CHAT_UPDATE', {
              msg: { ...baseMsg, text: tx.translated ? tx.text : p.text, translated: tx.translated, originalText: tx.translated ? p.text : undefined },
              currentTurn: room.currentTurn, turnOrder: room.turnOrder
            });
          } else {
            send(wsConn, 'CHAT_UPDATE', { msg: baseMsg, currentTurn: room.currentTurn, turnOrder: room.turnOrder });
          }
        }
        break;
      }

      case 'PROPOSE_VOTE': {
        const room = rooms[p.code];
        if (!room || room.voteActive || room.phase === 'discussion' || room.phase === 'voting') return;
        room.phase = 'discussion';
        room.spokeIds = new Set();
        broadcastAll(p.code, 'DISCUSSION_START', { proposedBy: p.id, duration: 60 });
        if (room.discussionTimer) clearTimeout(room.discussionTimer);
        room.discussionTimer = setTimeout(() => {
          if (!rooms[p.code]) return;
          rooms[p.code].voteActive = true;
          rooms[p.code].votes = {};
          rooms[p.code].phase = 'voting';
          broadcastAll(p.code, 'VOTING_START', { players: getRoomPublic(rooms[p.code]).players });
          rooms[p.code].voteTimer = setTimeout(() => { if (rooms[p.code]) endVoting(p.code); }, 12000);
        }, 60000);
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
    const code = ws._roomCode, id = ws._playerId;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.wsMap.delete(ws);
    delete room.players[id]; delete room.roles[id];
    room.turnOrder = (room.turnOrder || []).filter(i => i !== id);
    if (Object.keys(room.players).length === 0) {
      if (room.voteTimer) clearTimeout(room.voteTimer);
      if (room.discussionTimer) clearTimeout(room.discussionTimer);
      delete rooms[code]; return;
    }
    if (room.host === id) room.host = Object.keys(room.players)[0];
    broadcastAll(code, 'ROOM_UPDATE', getRoomPublic(room));
  });
});

function endVoting(code) {
  const room = rooms[code];
  if (!room) return;
  room.voteActive = false; room.voteTimer = null;
  const counts = {};
  Object.values(room.votes).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  let maxV = 0, expelled = null;
  Object.entries(counts).forEach(([id, c]) => { if (c > maxV) { maxV = c; expelled = id; } });
  const topCount = Object.values(counts).filter(c => c === maxV).length;
  const tie = topCount > 1 || !expelled;
  let result;
  if (tie || !expelled) {
    result = { expelled: null, role: null, tie: true, impostorWin: false };
    Object.keys(room.players).forEach(id => awardXP(room, id, 10));
  } else {
    const role = room.roles[expelled];
    result = { expelled, expelledName: room.players[expelled]?.name, role, tie: false };
    delete room.players[expelled]; delete room.roles[expelled];
    room.turnOrder = room.turnOrder.filter(id => id !== expelled);
    if (role === 'impostor') {
      Object.keys(room.players).forEach(id => {
        const lvlUp = awardXP(room, id, room.roles[id] === 'civil' ? 50 : 20);
        if (lvlUp) { const ws = [...room.wsMap.entries()].find(([,i]) => i.id === id)?.[0]; if (ws) send(ws, 'LEVEL_UP', { level: lvlUp }); }
      });
      result.impostorWin = false; room.status = 'ended';
    } else {
      Object.keys(room.players).forEach(id => awardXP(room, id, room.roles[id] === 'impostor' ? 30 : 10));
      if (checkImpostorWin(room)) {
        result.impostorWin = true; room.status = 'ended';
        Object.keys(room.players).forEach(id => {
          if (room.roles[id] === 'impostor') {
            const lvlUp = awardXP(room, id, 60);
            if (lvlUp) { const ws = [...room.wsMap.entries()].find(([,i]) => i.id === id)?.[0]; if (ws) send(ws, 'LEVEL_UP', { level: lvlUp }); }
          }
        });
      } else {
        result.impostorWin = false; room.status = 'playing';
        room.currentTurn = 0; room.phase = 'chat'; room.spokeIds = new Set();
      }
    }
  }
  result.playerStats = {};
  Object.entries(room.players).forEach(([id, p]) => { result.playerStats[id] = { level: p.level, xp: p.xp }; });
  broadcastAll(code, 'VOTING_END', result);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Gordos Game en http://localhost:${PORT}`));
