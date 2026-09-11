// ═══════════════════════════════════════════════════════════════════
// UZAY SAVAŞI — 2 Kişilik Online Prototip Sunucusu
// ═══════════════════════════════════════════════════════════════════
// Bu sunucu SADECE şunu yapar:
//   1) Oda kurma (4 haneli kod üretir)
//   2) Odaya katılma (en fazla 2 kişi)
//   3) Bir oyuncunun pozisyon/durum verisini diğerine anında iletme (relay)
//   4) Bağlantı kopunca odayı temizleme
//
// Düşman/skor/mod senkronu YOK — bu prototip sadece "iki cihaz birbirini
// görüp hareket edebiliyor mu" sorusunu cevaplamak için.
//
// ÇALIŞTIRMA:
//   npm install
//   npm start
//   (varsayılan port: process.env.PORT || 8080)
//
// BARINDIRMA:
//   Bu bir "her zaman açık" Node.js sürecidir — Netlify'da ÇALIŞMAZ
//   (Netlify sadece statik dosya + kısa ömürlü fonksiyon sunar).
//   Önerilen: Railway.app, Render.com veya Fly.io (hepsinin ücretsiz
//   katmanı var, "npm start" ile Node.js süreci çalıştırırlar).
// ═══════════════════════════════════════════════════════════════════

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ── Basit bir HTTP sunucusu (sağlık kontrolü için) + üzerine WebSocket bindiriyoruz ──
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Uzay Savaşı Multiplayer Sunucusu çalışıyor.\n');
});

const wss = new WebSocketServer({ server: httpServer });

// odalar: { [roomCode]: { players: Map<ws, {id, name}>, createdAt } }
const rooms = new Map();

function makeRoomCode() {
  // 4 haneli, harf karışıklığı olmayan (0/O, 1/I gibi) kod
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcastToRoom(roomCode, senderWs, type, data) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [clientWs] of room.players) {
    if (clientWs !== senderWs) send(clientWs, type, data);
  }
}

function otherPlayer(room, ws) {
  for (const [clientWs, info] of room.players) {
    if (clientWs !== ws) return { ws: clientWs, info };
  }
  return null;
}

wss.on('connection', (ws) => {
  ws.playerId = Math.random().toString(36).slice(2, 10);
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // ── ODA KUR ──
    if (msg.type === 'createRoom') {
      const code = makeRoomCode();
      rooms.set(code, { players: new Map(), createdAt: Date.now() });
      const room = rooms.get(code);
      room.players.set(ws, { id: ws.playerId, name: (msg.name || 'Komutan').slice(0, 16) });
      ws.roomCode = code;
      send(ws, 'roomCreated', { roomCode: code, playerId: ws.playerId, isHost: true });
      return;
    }

    // ── ODAYA KATIL ──
    if (msg.type === 'joinRoom') {
      const code = (msg.roomCode || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, 'joinError', { reason: 'notfound', message: 'Oda bulunamadı.' }); return; }
      if (room.players.size >= 2) { send(ws, 'joinError', { reason: 'full', message: 'Oda dolu (en fazla 2 oyuncu).' }); return; }

      const existing = otherPlayer(room, ws); // katılmadan önceki tek oyuncu (host)
      room.players.set(ws, { id: ws.playerId, name: (msg.name || 'Komutan').slice(0, 16) });
      ws.roomCode = code;

      send(ws, 'roomJoined', {
        roomCode: code,
        playerId: ws.playerId,
        isHost: false,
        otherPlayer: existing ? existing.info : null,
      });
      if (existing) {
        send(existing.ws, 'peerJoined', { peer: { id: ws.playerId, name: (msg.name || 'Komutan').slice(0, 16) } });
      }
      return;
    }

    // ── POZİSYON / DURUM GÜNCELLEMESİ (relay — sunucu işlemez, sadece iletir) ──
    if (msg.type === 'state') {
      if (!ws.roomCode) return;
      broadcastToRoom(ws.roomCode, ws, 'peerState', {
        playerId: ws.playerId,
        x: msg.x, y: msg.y, rot: msg.rot,
        shooting: !!msg.shooting,
        shipType: msg.shipType || null,
        hp: msg.hp,
        t: Date.now(), // sunucu zaman damgası — client interpolasyonda kullanabilir
      });
      return;
    }

    // ── DÜŞMAN LİSTESİ SENKRONU (relay — GÜNCELLEME 35, sadece host gönderir, sunucu içeriği doğrulamaz) ──
    if (msg.type === 'enemySync') {
      if (!ws.roomCode) return;
      broadcastToRoom(ws.roomCode, ws, 'peerEnemySync', {
        playerId: ws.playerId,
        enemies: msg.enemies,
        t: Date.now(),
      });
      return;
    }

    // ── OYUN BAŞLADI (relay — GÜNCELLEME 36, host "başlat" tuşuna basınca client'a haber verir) ──
    if (msg.type === 'gameStart') {
      if (!ws.roomCode) return;
      broadcastToRoom(ws.roomCode, ws, 'peerGameStart', {
        playerId: ws.playerId,
      });
      return;
    }

    // ── OYUNDAN AYRIL (odada kal, sadece oyun ekranından çık) ──
    if (msg.type === 'leaveRoom') {
      cleanupPlayer(ws);
      return;
    }
  });

  ws.on('close', () => {
    cleanupPlayer(ws);
  });
});

function cleanupPlayer(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) { ws.roomCode = null; return; }
  room.players.delete(ws);
  const remaining = otherPlayer(room, ws); // ws zaten silindi, bu kalan tek kişiyi bulur
  if (remaining) {
    send(remaining.ws, 'peerLeft', { playerId: ws.playerId });
  }
  if (room.players.size === 0) {
    rooms.delete(ws.roomCode);
  }
  ws.roomCode = null;
}

// Boş kalan eski odaları periyodik temizle (1 saatten eski, boş odalar)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && now - room.createdAt > 3600_000) {
      rooms.delete(code);
    }
  }
}, 5 * 60_000);

httpServer.listen(PORT, () => {
  console.log('Uzay Savaşı Multiplayer Sunucusu ' + PORT + ' portunda çalışıyor.');
}); 