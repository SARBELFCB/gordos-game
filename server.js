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

// ── ADMIN ─────────────────────────────────────────────────────────
const ADMIN_NAME = 'sarbelotefcb'; // nombre con acceso admin

// ── PALABRAS ─────────────────────────────────────────────────────
const PALABRAS_DEFAULT = [
  'perro','gato','delfín','elefante','pingüino','cocodrilo',
  'pizza','hamburguesa','sushi','arepa','chocolate','helado',
  'playa','montaña','aeropuerto','hospital','biblioteca','estadio',
  'tijeras','telescopio','paraguas','linterna','guitarra','reloj',
  'fútbol','baloncesto','natación','tenis','boxeo','ciclismo',
  'volcán','cohete','submarino','castillo','espada','brújula'
];

// ── USUARIOS ──────────────────────────────────────────────────────
const users = {};        // { userId: { name, level, xp, wins_civil, wins_imp, banned, createdAt } }
const bannedIds = new Set();
const pendingCodes = {}; // { key: { name, code, expires } }
const nameIndex = {};    // { normalizedName: userId } — evita duplicados

function xpForLevel(level) { return Math.floor(100 * Math.pow(1.4, level - 1)); }
function genCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function normName(n) { return n.trim().toLowerCase(); }

// ── ANTI-BOT: pedir código ────────────────────────────────────────
app.post('/api/request-code', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) return res.json({ ok: false, error: 'short' });
  const norm = normName(name);
  if (nameIndex[norm]) return res.json({ ok: false, error: 'taken' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const key = crypto.randomBytes(8).toString('hex');
  pendingCodes[key] = { name: name.trim(), code, expires: Date.now() + 5 * 60 * 1000 };
  console.log(`[VERIFY] ${name}: ${code}`);
  res.json({ ok: true, key, _demo_code: code });
});

app.post('/api/verify', (req, res) => {
  const { key, code } = req.body;
  const pending = pendingCodes[key];
  if (!pending || Date.now() > pending.expires) { delete pendingCodes[key]; return res.json({ ok: false, error: 'expired' }); }
  if (pending.code !== code.trim()) return res.json({ ok: false, error: 'wrong' });
  const norm = normName(pending.name);
  if (nameIndex[norm]) { delete pendingCodes[key]; return res.json({ ok: false, error: 'taken' }); }
  const userId = 'u_' + crypto.randomBytes(10).toString('hex');
  users[userId] = { name: pending.name, level: 1, xp: 0, wins_civil: 0, wins_imp: 0, banned: false, createdAt: Date.now() };
  nameIndex[norm] = userId;
  delete pendingCodes[key];
  res.json({ ok: true, userId, name: pending.name, isAdmin: normName(pending.name) === normName(ADMIN_NAME) });
});

app.get('/api/profile/:userId', (req, res) => {
  const u = users[req.params.userId];
  if (!u) return res.json({ ok: false });
  res.json({ ok: true, ...u, isAdmin: normName(u.name) === normName(ADMIN_NAME) });
});

app.get('/api/ranking', (req, res) => {
  const ranking = Object.entries(users)
    .filter(([, u]) => !u.banned)
    .map(([id, u]) => ({ id, name: u.name, level: u.level, xp: u.xp, wins_civil: u.wins_civil || 0, wins_imp: u.wins_imp || 0 }))
    .sort((a, b) => b.level !== a.level ? b.level - a.level : b.xp - a.xp)
    .slice(0, 20);
  res.json(ranking);
});

// ── TRADUCCIÓN ────────────────────────────────────────────────────
async function translateText(text, from, to) {
  if (from === to || !text.trim()) return { text, translated: false };
  try {
    const res = await fetch('https://libretranslate.com/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: from, target: to, format: 'text' }),
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) { const d = await res.json(); if (d.translatedText) return { text: d.translatedText, translated: true }; }
  } catch {}
  return { text, translated: false };
}

// ── ROOMS ─────────────────────────────────────────────────────────
const rooms = {};
const allClients = new Map(); // ws → userId (for global announcements)

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function broadcastAll(code, type, payload) {
  const room = rooms[code]; if (!room) return;
  for (const [wsConn] of room.wsMap) send(wsConn, type, payload);
}

function broadcastGlobal(type, payload) {
  for (const [ws] of allClients) send(ws, type, payload);
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
  return ids.filter(id => room.roles[id] === 'impostor').length >= ids.filter(id => room.roles[id] === 'civil').length;
}

function awardXP(room, playerId, amount) {
  const p = room.players[playerId]; if (!p) return null;
  p.xp = (p.xp || 0) + amount;
  if (p.userId && users[p.userId]) { users[p.userId].xp = (users[p.userId].xp || 0) + amount; }
  const old = p.level || 1;
  while (p.xp >= xpForLevel(p.level || 1)) {
    p.xp -= xpForLevel(p.level || 1); p.level = (p.level || 1) + 1;
    if (p.userId && users[p.userId]) { users[p.userId].xp = p.xp; users[p.userId].level = p.level; }
  }
  if (p.userId && users[p.userId]) users[p.userId].xp = p.xp;
  return p.level > old ? p.level : null;
}

wss.on('connection', (ws) => {
  allClients.set(ws, null);

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload: p } = msg;

    switch (type) {

      case 'REGISTER_CLIENT': {
        // Registrar userId con este ws para broadcasts
        allClients.set(ws, p.userId);
        ws._userId = p.userId;
        // Check ban
        if (p.userId && users[p.userId] && users[p.userId].banned) {
          send(ws, 'BANNED', {});
        }
        break;
      }

      case 'ADMIN_BAN': {
        const adminUser = users[p.adminId];
        if (!adminUser || normName(adminUser.name) !== normName(ADMIN_NAME)) return;
        const target = users[p.targetId];
        if (!target) return;
        target.banned = true;
        bannedIds.add(p.targetId);
        // Notify all ws of that user
        for (const [wsConn, uid] of allClients) {
          if (uid === p.targetId) send(wsConn, 'BANNED', { reason: p.reason || '' });
        }
        break;
      }

      case 'ADMIN_UNBAN': {
        const adminUser = users[p.adminId];
        if (!adminUser || normName(adminUser.name) !== normName(ADMIN_NAME)) return;
        if (users[p.targetId]) { users[p.targetId].banned = false; bannedIds.delete(p.targetId); }
        break;
      }

      case 'GLOBAL_ANNOUNCEMENT': {
        const adminUser = users[p.adminId];
        if (!adminUser || normName(adminUser.name) !== normName(ADMIN_NAME)) return;
        broadcastGlobal('ANNOUNCEMENT', { text: p.text, from: adminUser.name });
        break;
      }

      case 'CREATE_ROOM': {
        if (p.userId && bannedIds.has(p.userId)) { send(ws, 'ERROR', 'banned'); return; }
        const code = genCode();
        rooms[code] = {
          code, host: p.id, maxPlayers: p.maxPlayers || 6, numImpostors: p.numImpostors || 1,
          palabras: (p.palabras && p.palabras.length >= 2) ? p.palabras : PALABRAS_DEFAULT,
          status: 'waiting',
          players: { [p.id]: { name: p.name, avatar: p.avatar, level: p.level||1, xp: p.xp||0, lang: p.lang||'es', userId: p.userId } },
          wsMap: new Map([[ws, { id: p.id }]]),
          chat: [], turnOrder: [], currentTurn: 0, roles: {}, palabra: '',
          voteActive: false, votes: {}, voteTimer: null, discussionTimer: null,
          phase: 'waiting', spokeIds: new Set(),
        };
        ws._roomCode = code; ws._playerId = p.id;
        send(ws, 'ROOM_CREATED', { code, room: getRoomPublic(rooms[code]) });
        break;
      }

      case 'JOIN_ROOM': {
        if (p.userId && bannedIds.has(p.userId)) { send(ws, 'ERROR', 'banned'); return; }
        const room = rooms[p.code];
        if (!room) { send(ws, 'ERROR', 'not_found'); return; }
        if (room.status !== 'waiting') { send(ws, 'ERROR', 'started'); return; }
        if (Object.keys(room.players).length >= room.maxPlayers) { send(ws, 'ERROR', 'full'); return; }
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
        if (players.length < 2) { send(ws, 'ERROR', 'need_2'); return; }
        const palabra = room.palabras[Math.floor(Math.random() * room.palabras.length)];
        const shuffled = [...players].sort(() => Math.random() - 0.5);
        const impostores = shuffled.slice(0, room.numImpostors);
        room.roles = {};
        players.forEach(id => { room.roles[id] = impostores.includes(id) ? 'impostor' : 'civil'; });
        room.palabra = palabra;
        room.turnOrder = [...players].sort(() => Math.random() - 0.5);
        room.currentTurn = 0; room.chat = []; room.status = 'playing';
        room.phase = 'chat'; room.voteActive = false; room.votes = {};
        room.spokeIds = new Set();
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
          if (current !== p.id) { send(ws, 'ERROR', 'not_your_turn'); return; }
        }
        const senderLang = room.players[p.id]?.lang || 'es';
        const baseMsg = { id: p.id, name: room.players[p.id].name, text: p.text, lang: senderLang, level: room.players[p.id]?.level || 1 };
        room.chat.push(baseMsg);
        if (!room.spokeIds) room.spokeIds = new Set();
        room.spokeIds.add(p.id);
        if (room.phase === 'chat') {
          room.currentTurn++;
          const allPlayers = Object.keys(room.players);
          const allSpoke = allPlayers.every(id => room.spokeIds.has(id));
          if (allSpoke) broadcastAll(p.code, 'ALL_SPOKE', {});
        }
        for (const [wsConn, info] of room.wsMap) {
          const recvLang = room.players[info.id]?.lang || 'es';
          if (recvLang !== senderLang) {
            const tx = await translateText(p.text, senderLang, recvLang);
            send(wsConn, 'CHAT_UPDATE', { msg: { ...baseMsg, text: tx.text, translated: tx.translated, originalText: tx.translated ? p.text : undefined }, currentTurn: room.currentTurn, turnOrder: room.turnOrder });
          } else {
            send(wsConn, 'CHAT_UPDATE', { msg: baseMsg, currentTurn: room.currentTurn, turnOrder: room.turnOrder });
          }
        }
        break;
      }

      case 'PROPOSE_VOTE': {
        const room = rooms[p.code];
        if (!room || room.voteActive || room.phase === 'discussion' || room.phase === 'voting') return;
        room.phase = 'discussion'; room.spokeIds = new Set();
        broadcastAll(p.code, 'DISCUSSION_START', { proposedBy: p.id, duration: 60 });
        if (room.discussionTimer) clearTimeout(room.discussionTimer);
        room.discussionTimer = setTimeout(() => {
          if (!rooms[p.code]) return;
          const r = rooms[p.code];
          r.voteActive = true; r.votes = {}; r.phase = 'voting';
          const pub = getRoomPublic(r);
          broadcastAll(p.code, 'VOTING_START', { players: pub.players });
          r.voteTimer = setTimeout(() => { if (rooms[p.code]) endVoting(p.code); }, 12000);
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
        // Auto-end if everyone voted
        if (Object.keys(room.votes).length >= Object.keys(room.players).length) {
          if (room.voteTimer) clearTimeout(room.voteTimer);
          endVoting(p.code);
        }
        break;
      }

      case 'GET_USERS_LIST': {
        // Admin only
        const adminUser = users[p.adminId];
        if (!adminUser || normName(adminUser.name) !== normName(ADMIN_NAME)) return;
        const list = Object.entries(users).map(([id, u]) => ({ id, name: u.name, level: u.level, banned: u.banned }));
        send(ws, 'USERS_LIST', list);
        break;
      }
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);
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
  const room = rooms[code]; if (!room) return;
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
    const expelledUserId = room.players[expelled]?.userId;
    delete room.players[expelled]; delete room.roles[expelled];
    room.turnOrder = room.turnOrder.filter(id => id !== expelled);
    if (role === 'impostor') {
      Object.keys(room.players).forEach(id => {
        const lvlUp = awardXP(room, id, room.roles[id] === 'civil' ? 50 : 20);
        if (lvlUp) { const w = [...room.wsMap.entries()].find(([,i]) => i.id === id)?.[0]; if (w) send(w, 'LEVEL_UP', { level: lvlUp }); }
        if (room.roles[id] === 'civil' && room.players[id]?.userId && users[room.players[id].userId]) users[room.players[id].userId].wins_civil = (users[room.players[id].userId].wins_civil || 0) + 1;
      });
      result.impostorWin = false; room.status = 'ended';
    } else {
      Object.keys(room.players).forEach(id => awardXP(room, id, room.roles[id] === 'impostor' ? 30 : 10));
      if (checkImpostorWin(room)) {
        result.impostorWin = true; room.status = 'ended';
        Object.keys(room.players).forEach(id => {
          if (room.roles[id] === 'impostor') {
            const lvlUp = awardXP(room, id, 60);
            if (lvlUp) { const w = [...room.wsMap.entries()].find(([,i]) => i.id === id)?.[0]; if (w) send(w, 'LEVEL_UP', { level: lvlUp }); }
            if (room.players[id]?.userId && users[room.players[id].userId]) users[room.players[id].userId].wins_imp = (users[room.players[id].userId].wins_imp || 0) + 1;
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
