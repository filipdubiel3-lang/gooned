const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

// ── Passwords ─────────────────────────────────────────────────────
let SITE_PASSWORD = process.env.SITE_PASSWORD || 'goonroom';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.post('/api/check-password', (req, res) => {
  res.json({ ok: req.body.password === SITE_PASSWORD });
});
app.post('/api/change-password', (req, res) => {
  if (req.body.adminPassword !== ADMIN_PASSWORD) return res.json({ ok: false, msg: 'Wrong admin password' });
  if (!req.body.newPassword || req.body.newPassword.length < 3) return res.json({ ok: false, msg: 'Password too short' });
  SITE_PASSWORD = req.body.newPassword;
  res.json({ ok: true });
});

// ── Game definitions ──────────────────────────────────────────────
const GAMES = {
  wordle:      { name: 'Wordle',         icon: '🟩', minPlayers: 1, maxPlayers: 8 },
  connect4:    { name: 'Connect 4',      icon: '🔴', minPlayers: 2, maxPlayers: 2 },
  uno:         { name: 'UNO',            icon: '🃏', minPlayers: 2, maxPlayers: 8 },
  contexto:    { name: 'Contexto',       icon: '🧠', minPlayers: 1, maxPlayers: 8 },
  twoTruths:   { name: 'Two Truths',     icon: '🤔', minPlayers: 2, maxPlayers: 8 },
  wouldYou:    { name: 'Would You Rather',icon: '😬', minPlayers: 2, maxPlayers: 8 },
  connections: { name: 'Connections',    icon: '🔗', minPlayers: 1, maxPlayers: 8 },
  imposter:    { name: 'Imposter',       icon: '🕵️', minPlayers: 3, maxPlayers: 10 },
  guessWho:    { name: 'Guess Who',      icon: '👤', minPlayers: 2, maxPlayers: 8 },
  trivia:      { name: 'Trivia',         icon: '❓', minPlayers: 1, maxPlayers: 8 },
};

// ── State ─────────────────────────────────────────────────────────
const rooms = {}; // roomId -> room
const players = {}; // socketId -> player

function genId(len = 6) {
  return Math.random().toString(36).toUpperCase().slice(2, 2 + len);
}

// ── Socket ────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // JOIN
  socket.on('user:join', ({ username, avatar }) => {
    players[socket.id] = { id: socket.id, username, avatar, roomId: null, score: 0, ready: false };
    socket.emit('user:joined', { id: socket.id });
    socket.emit('lobby:games', GAMES);
  });

  // CREATE ROOM
  socket.on('room:create', ({ gameId, settings }) => {
    const p = players[socket.id];
    if (!p) return;
    const roomId = genId(5);
    rooms[roomId] = {
      id: roomId,
      gameId,
      hostId: socket.id,
      players: [p],
      state: 'lobby',
      settings: settings || {},
      gameState: {},
    };
    p.roomId = roomId;
    socket.join(roomId);
    socket.emit('room:created', { roomId, gameInfo: GAMES[gameId] });
    io.to(roomId).emit('room:update', rooms[roomId]);
    io.to(roomId).emit('room:chat', { system: true, msg: `${p.avatar} ${p.username} created the room` });
  });

  // JOIN ROOM
  socket.on('room:join', ({ roomId }) => {
    const p = players[socket.id];
    const room = rooms[roomId];
    if (!p) return;
    if (!room) return socket.emit('room:error', { msg: 'Room not found' });
    if (room.state !== 'lobby') return socket.emit('room:error', { msg: 'Game already started' });
    if (room.players.length >= GAMES[room.gameId].maxPlayers) return socket.emit('room:error', { msg: 'Room is full' });
    if (room.players.find(x => x.id === socket.id)) return socket.emit('room:error', { msg: 'Already in room' });
    room.players.push(p);
    p.roomId = roomId;
    socket.join(roomId);
    socket.emit('room:joined', { roomId, gameInfo: GAMES[room.gameId] });
    io.to(roomId).emit('room:update', room);
    io.to(roomId).emit('room:chat', { system: true, msg: `${p.avatar} ${p.username} joined` });
  });

  // LEAVE
  socket.on('game:leave', () => leaveRoom(socket));

  // CHAT
  socket.on('room:chat', ({ msg }) => {
    const p = players[socket.id];
    if (!p || !p.roomId) return;
    io.to(p.roomId).emit('room:chat', { playerId: socket.id, username: p.username, avatar: p.avatar, msg });
  });

  // START GAME
  socket.on('game:start', () => {
    const p = players[socket.id];
    if (!p) return;
    const room = rooms[p.roomId];
    if (!room || room.hostId !== socket.id) return;
    room.state = 'playing';
    room.players.forEach(pl => { pl.score = 0; });
    switch (room.gameId) {
      case 'wordle':      startWordle(room); break;
      case 'connect4':    startConnect4(room); break;
      case 'uno':         startUno(room); break;
      case 'contexto':    startContexto(room); break;
      case 'twoTruths':   startTwoTruths(room); break;
      case 'wouldYou':    startWouldYou(room); break;
      case 'connections': startConnections(room); break;
      case 'imposter':    startImposter(room); break;
      case 'guessWho':    startGuessWho(room); break;
      case 'trivia':      startTrivia(room); break;
    }
  });

  // RESTART
  socket.on('game:restart', () => {
    const p = players[socket.id];
    if (!p) return;
    const room = rooms[p.roomId];
    if (!room || room.hostId !== socket.id) return;
    room.state = 'lobby';
    room.gameState = {};
    room.players.forEach(pl => { pl.score = 0; pl.ready = false; });
    io.to(room.id).emit('game:restarted');
    io.to(room.id).emit('room:update', room);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    leaveRoom(socket);
    delete players[socket.id];
  });

  // ── GAME EVENTS ──────────────────────────────────────────────────

  // WORDLE
  socket.on('wordle:guess', ({ guess }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'wordle') return;
    const gs = room.gameState;
    const word = gs.word;
    if (!word) return;
    guess = guess.toUpperCase();
    if (guess.length !== 5) return socket.emit('game:error', { msg: 'Must be 5 letters' });
    const result = scoreWordle(guess, word);
    const playerState = gs.players[socket.id] || { guesses: 0, finished: false };
    playerState.guesses++;
    const won = result.every(r => r === 'correct');
    const finished = won || playerState.guesses >= gs.maxGuesses;
    playerState.finished = finished;
    gs.players[socket.id] = playerState;
    if (won) {
      const pts = Math.max(10, 60 - (playerState.guesses - 1) * 10);
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += pts;
    }
    io.to(room.id).emit('wordle:guess', { playerId: socket.id, guess, result, finished, won });
    if (finished) io.to(room.id).emit('room:update', room);
    const allDone = room.players.every(pl => gs.players[pl.id]?.finished);
    if (allDone) endGame(room);
  });

  // CONNECT4
  socket.on('connect4:drop', ({ col }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'connect4') return;
    const gs = room.gameState;
    if (gs.currentPlayer !== socket.id) return socket.emit('game:error', { msg: "Not your turn" });
    const board = gs.board;
    let row = -1;
    for (let r = 5; r >= 0; r--) { if (!board[r][col]) { row = r; break; } }
    if (row === -1) return socket.emit('game:error', { msg: 'Column full' });
    const piece = gs.pieces[socket.id];
    board[row][col] = piece;
    const won = checkConnect4Win(board, row, col, piece);
    const draw = !won && board[0].every(c => c);
    const nextPlayer = won || draw ? null : room.players.find(x => x.id !== socket.id)?.id;
    gs.currentPlayer = nextPlayer;
    if (won) {
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += 50;
    }
    io.to(room.id).emit('connect4:update', { board, currentPlayer: nextPlayer, lastMove: { row, col, piece } });
    if (won || draw) {
      const winner = won ? room.players.find(x => x.id === socket.id) : null;
      io.to(room.id).emit('game:over', {
        scores: Object.fromEntries(room.players.map(pl => [pl.id, pl.score])),
        winnerName: winner ? `${winner.avatar} ${winner.username}` : null,
        message: draw ? "It's a draw!" : null,
      });
    }
  });

  // UNO
  socket.on('uno:play', ({ cardIndex, chosenColor }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'uno') return;
    const gs = room.gameState;
    if (gs.currentPlayer !== socket.id) return socket.emit('game:error', { msg: "Not your turn" });
    const hand = gs.hands[socket.id];
    const card = hand[cardIndex];
    if (!card) return;
    if (!canPlayUno(card, gs.topCard, gs.currentColor)) return socket.emit('game:error', { msg: "Can't play that card" });
    hand.splice(cardIndex, 1);
    gs.topCard = card;
    gs.currentColor = chosenColor || card.color;
    if (card.value === '+2') {
      const next = getNextUnoPlayer(room, gs);
      const nextHand = gs.hands[next];
      for (let i = 0; i < 2; i++) nextHand.push(drawUnoCard(gs));
      gs.skip = true;
    }
    if (card.value === '+4') {
      const next = getNextUnoPlayer(room, gs);
      const nextHand = gs.hands[next];
      for (let i = 0; i < 4; i++) nextHand.push(drawUnoCard(gs));
      gs.skip = true;
      gs.currentColor = chosenColor || 'red';
    }
    if (card.value === 'skip') gs.skip = true;
    if (card.value === 'reverse') gs.direction *= -1;
    if (hand.length === 0) {
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += 100;
      broadcastUnoState(room, gs);
      return endGame(room);
    }
    advanceUnoTurn(room, gs);
    broadcastUnoState(room, gs);
  });

  socket.on('uno:draw', () => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'uno') return;
    const gs = room.gameState;
    if (gs.currentPlayer !== socket.id) return socket.emit('game:error', { msg: "Not your turn" });
    gs.hands[socket.id].push(drawUnoCard(gs));
    advanceUnoTurn(room, gs);
    broadcastUnoState(room, gs);
  });

  // TRIVIA
  socket.on('trivia:answer', ({ answer }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'trivia') return;
    const gs = room.gameState;
    const q = gs.questions[gs.currentQ];
    if (!q || gs.answered[socket.id]) return;
    gs.answered[socket.id] = true;
    const correct = answer === q.answer;
    if (correct) {
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += 10;
    }
    socket.emit('trivia:result', { correct, answer: q.answer });
    io.to(room.id).emit('room:update', room);
    const allAnswered = room.players.every(pl => gs.answered[pl.id]);
    if (allAnswered) {
      gs.currentQ++;
      gs.answered = {};
      if (gs.currentQ >= gs.questions.length) {
        setTimeout(() => endGame(room), 1500);
      } else {
        setTimeout(() => {
          io.to(room.id).emit('trivia:question', { question: gs.questions[gs.currentQ], index: gs.currentQ, total: gs.questions.length });
        }, 2000);
      }
    }
  });

  // TWO TRUTHS
  socket.on('twoTruths:submit', ({ statements }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'twoTruths') return;
    const gs = room.gameState;
    gs.submissions[socket.id] = statements;
    io.to(room.id).emit('twoTruths:submitted', { playerId: socket.id });
    const allIn = room.players.every(pl => gs.submissions[pl.id]);
    if (allIn) nextTwoTruthsRound(room, gs);
  });

  socket.on('twoTruths:vote', ({ lieIndex }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'twoTruths') return;
    const gs = room.gameState;
    if (gs.currentSubject === socket.id) return;
    if (gs.votes[socket.id] !== undefined) return;
    gs.votes[socket.id] = lieIndex;
    io.to(room.id).emit('twoTruths:voted', { playerId: socket.id });
    const voters = room.players.filter(pl => pl.id !== gs.currentSubject);
    if (voters.every(pl => gs.votes[pl.id] !== undefined)) {
      revealTwoTruths(room, gs);
    }
  });

  // WOULD YOU RATHER
  socket.on('wouldYou:vote', ({ choice }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'wouldYou') return;
    const gs = room.gameState;
    if (gs.votes[socket.id] !== undefined) return;
    gs.votes[socket.id] = choice;
    io.to(room.id).emit('wouldYou:voted', { playerId: socket.id, count: Object.keys(gs.votes).length, total: room.players.length });
    if (Object.keys(gs.votes).length >= room.players.length) {
      revealWouldYou(room, gs);
    }
  });

  socket.on('wouldYou:next', () => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.hostId !== socket.id) return;
    nextWouldYou(room);
  });

  // IMPOSTER
  socket.on('imposter:vote', ({ targetId }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'imposter') return;
    const gs = room.gameState;
    if (gs.votes[socket.id]) return;
    gs.votes[socket.id] = targetId;
    io.to(room.id).emit('imposter:voted', { playerId: socket.id, count: Object.keys(gs.votes).length, total: room.players.length });
    if (Object.keys(gs.votes).length >= room.players.length) {
      revealImposter(room, gs);
    }
  });

  // GUESS WHO
  socket.on('guessWho:guess', ({ targetId }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'guessWho') return;
    const gs = room.gameState;
    const correct = targetId === gs.target;
    if (correct) {
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += 30;
    }
    io.to(room.id).emit('guessWho:result', { playerId: socket.id, correct, targetId: gs.target });
    io.to(room.id).emit('room:update', room);
    setTimeout(() => endGame(room), 2000);
  });

  // CONNECTIONS
  socket.on('connections:submit', ({ group }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'connections') return;
    const gs = room.gameState;
    const playerState = gs.players[socket.id] || { solved: [], mistakes: 0 };
    const match = gs.groups.find(g => !playerState.solved.includes(g.category) &&
      g.words.every(w => group.includes(w)) && group.every(w => g.words.includes(w)));
    if (match) {
      playerState.solved.push(match.category);
      const pts = ({ yellow: 10, green: 20, blue: 30, purple: 40 })[match.color] || 10;
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += pts;
      socket.emit('connections:correct', { category: match.category, color: match.color, words: match.words, solved: playerState.solved });
      if (playerState.solved.length === gs.groups.length) {
        socket.emit('connections:won');
        playerState.finished = true;
        io.to(room.id).emit('room:update', room);
      }
    } else {
      playerState.mistakes++;
      socket.emit('connections:wrong', { mistakes: playerState.mistakes });
      if (playerState.mistakes >= 4) {
        playerState.finished = true;
        socket.emit('connections:lost', { groups: gs.groups });
      }
    }
    gs.players[socket.id] = playerState;
    const allDone = room.players.every(pl => gs.players[pl.id]?.finished);
    if (allDone) endGame(room);
  });

  // CONTEXTO
  socket.on('contexto:guess', ({ word }) => {
    const p = players[socket.id];
    const room = rooms[p?.roomId];
    if (!room || room.gameId !== 'contexto') return;
    const gs = room.gameState;
    const playerState = gs.players[socket.id] || { guesses: 0, finished: false, history: [] };
    word = word.toLowerCase().trim();
    const rank = gs.rankMap[word];
    if (rank === undefined) { socket.emit('contexto:result', { word, rank: null, msg: 'Word not in vocabulary' }); return; }
    playerState.guesses++;
    playerState.history.push({ word, rank });
    playerState.history.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    const won = rank === 0;
    if (won) {
      playerState.finished = true;
      const pl = room.players.find(x => x.id === socket.id);
      if (pl) pl.score += Math.max(10, 100 - playerState.guesses);
    }
    gs.players[socket.id] = playerState;
    socket.emit('contexto:result', { word, rank, won, guesses: playerState.guesses, history: playerState.history.slice(0, 10) });
    if (won) {
      io.to(room.id).emit('room:update', room);
      const allDone = room.players.every(pl => gs.players[pl.id]?.finished);
      if (allDone) endGame(room);
    }
  });
});

// ── Helper: leave room ────────────────────────────────────────────
function leaveRoom(socket) {
  const p = players[socket.id];
  if (!p || !p.roomId) return;
  const room = rooms[p.roomId];
  if (!room) return;
  room.players = room.players.filter(x => x.id !== socket.id);
  socket.leave(p.roomId);
  io.to(p.roomId).emit('room:chat', { system: true, msg: `${p.avatar} ${p.username} left` });
  if (room.players.length === 0) { delete rooms[p.roomId]; }
  else {
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    io.to(p.roomId).emit('room:update', room);
  }
  p.roomId = null;
}

function endGame(room) {
  room.state = 'over';
  const scores = Object.fromEntries(room.players.map(p => [p.id, p.score]));
  const winner = room.players.reduce((a, b) => a.score > b.score ? a : b, room.players[0]);
  io.to(room.id).emit('game:over', { scores, winnerName: winner ? `${winner.avatar} ${winner.username}` : null });
}

// ── WORDLE ────────────────────────────────────────────────────────
const WORDLE_WORDS = [
  // A
  'ABBEY','ABHOR','ABIDE','ABLER','ABODE','ABORT','ABOUT','ABOVE','ABUSE','ABYSS',
  'ACHED','ACORN','ACRES','ACUTE','ADAGE','ADDED','ADEPT','ADMIT','ADOBE','ADORE',
  'ADULT','AFTER','AGAIN','AGATE','AGENT','AGREE','AHEAD','AISLE','ALARM','ALBUM',
  'ALGAE','ALIBI','ALIGN','ALIKE','ALIVE','ALLAY','ALLOT','ALLOW','ALLOY','ALOFT',
  'ALONE','ALONG','ALOOF','ALOUD','ALPHA','ALTAR','ALTER','AMAZE','AMBER','AMBLE',
  'AMEND','AMISS','AMONG','AMPLE','AMUSE','ANGEL','ANGER','ANGLE','ANKLE','ANNEX',
  'ANNOY','ANTIC','ANVIL','AORTA','APPLE','APPLY','APRON','APTLY','ARDOR','ARENA',
  'ARGUE','ARISE','AROSE','ARRAY','ARSON','ASIDE','ASSET','ASTER','ATONE','ATTIC',
  'AUDIO','AVERT','AVID','AVOID','AWAKE','AWARD','AWARE','AWFUL','AWOKE',
  // B
  'BADGE','BANDY','BARGE','BARON','BASIC','BASIS','BATCH','BATHE','BAYOU','BEEFY',
  'BEGIN','BEING','BELOW','BEVEL','BIRCH','BIRTH','BLADE','BLAND','BLANK','BLARE',
  'BLAST','BLAZE','BLEAK','BLEND','BLESS','BLIMP','BLIND','BLINK','BLISS','BLOAT',
  'BLOCK','BLOOD','BLOWN','BLUFF','BLUNT','BLURB','BLURT','BLUSH','BONEY','BONUS',
  'BOOZE','BOXER','BRAVE','BRAWN','BRAZE','BREAD','BREAK','BREED','BRIBE','BRIDE',
  'BRINE','BRISK','BROAD','BROIL','BROOK','BROTH','BROWN','BRUNT','BRUSH','BUDDY',
  'BUILD','BUILT','BULGE','BUNCH','BURLY','BURST','BUYER',
  // C
  'CABIN','CAMEL','CAMEO','CAROL','CARRY','CEDAR','CHAOS','CHARM','CHASE','CHEAP',
  'CHEER','CHESS','CHEST','CHIEF','CHILD','CHINA','CHOIR','CHUNK','CIVIC','CIVIL',
  'CLAIM','CLASH','CLASS','CLAW','CLEAN','CLEAR','CLEFT','CLICK','CLIFF','CLIMB',
  'CLING','CLOAK','CLOCK','CLONE','CLOSE','CLOUD','CLOUT','CLOWN','CLUMP','COACH',
  'COAST','COBRA','COMET','COMMA','COMET','COMIC','CORAL','COUCH','COULD','COUNT',
  'COURT','COVER','COVET','CRACK','CRAFT','CRANE','CRANK','CRATE','CRAWL','CRAVE',
  'CREAK','CREAM','CREST','CRIME','CRISP','CROOK','CROSS','CROWD','CROWN','CRUMB',
  'CRUSH','CRUST','CRYPT','CUBIC','CURLY','CYBER',
  // D
  'DAILY','DAISY','DANCE','DENIM','DEPOT','DEPTH','DERBY','DIGIT','DIRTY','DISCO',
  'DITCH','DITTY','DIZZY','DOGMA','DOING','DOPEY','DOUBT','DOUGH','DOWRY','DRAFT',
  'DRAIN','DRAKE','DRAMA','DRAPE','DRAWL','DREAD','DRIFT','DRINK','DRIVE','DROOL',
  'DROOP','DROVE','DROWN','DRUID','DRYER','DUCHY','DUSKY','DUSTY','DWARF','DWELL',
  'DYING',
  // E
  'EAGER','EAGLE','EARLY','EARTH','EIGHT','EJECT','ELITE','EMBER','EMPTY','ENDED',
  'ENJOY','ENTER','EQUAL','ESSAY','EVERY','EXACT','EXERT','EXILE','EXIST','EXPEL',
  'EXTRA',
  // F
  'FABLE','FACET','FAITH','FANCY','FATAL','FAULT','FEAST','FEIGN','FENCE','FERAL',
  'FERRY','FIBER','FIFTH','FIFTY','FIGHT','FINAL','FIRST','FIXED','FJORD','FLAME',
  'FLAIR','FLANK','FLASH','FLASK','FLECK','FLESH','FLICK','FLINCH','FLOAT','FLOCK',
  'FLOOD','FLOOR','FLOUR','FLUFF','FLUNK','FLUTE','FOCUS','FOGGY','FORCE','FORGE',
  'FORTY','FOYER','FRAIL','FRAME','FRANK','FRAUD','FRESH','FROND','FRONT','FROST',
  'FROZE','FRUGAL','FUNKY','FUNNY','FUTURE',
  // G
  'GAUZE','GHOST','GIDDY','GIVEN','GIZMO','GLAND','GLEAM','GLEAN','GLIDE','GLOOM',
  'GLOAT','GLOSS','GLOVE','GLYPH','GOUGE','GRACE','GRADE','GRAFT','GRAIN','GRANT',
  'GRASP','GRASS','GRATE','GRAVE','GRAZE','GREED','GREET','GRIEF','GRIND','GROAN',
  'GROPE','GROVE','GROWL','GRUEL','GRUFF','GRUMP','GRUNGE','GUARD','GUAVA','GUESS',
  'GUILD','GUISE','GUSTO','GUSTY',
  // H
  'HABIT','HALVE','HANDY','HARSH','HASTY','HAUNT','HAVEN','HEDGE','HEIST','HENCE',
  'HINGE','HIPPO','HOIST','HOLLY','HOMER','HONEY','HONOR','HORNET','HOTEL','HOUND',
  'HOVER','HUNCH','HURRY','HUSKY','HYENA',
  // I
  'ICING','IDEAL','IDIOM','IDIOT','IRATE','IRONY',
  // J
  'JAUNT','JELLY','JEWEL','JIFFY','JOUST','JUDGE','JUICE','JUICY','JUMBO','JUNTO',
  // K
  'KAYAK','KEBAB','KNEEL','KNIFE','KNOCK','KNOLL','KNOT','KNAVE',
  // L
  'LANCE','LANKY','LASER','LATCH','LATER','LATTE','LAUNCH','LEAKY','LEARN','LEDGE',
  'LEMON','LEVEL','LIGHT','LIMIT','LINEN','LIVER','LOGIC','LOFTY','LOUSY','LOVER',
  'LOWER','LUCID','LUCKY','LUNAR','LUNCH','LUNGE','LUSTY',
  // M
  'MAGIC','MANOR','MAPLE','MARCH','MATCH','MAXIM','MAYOR','MELON','MERCY','MERGE',
  'MERIT','METAL','METER','MIGHT','MIRTH','MISER','MOIST','MONEY','MONTH','MOODY',
  'MOOSE','MORAL','MOSSY','MOTIF','MOUND','MOURN','MOUSE','MUDDY','MULCH','MURAL',
  'MIRTH','MUSTY','MUDDY','MYRRH',
  // N
  'NAIVE','NASTY','NAVAL','NERVE','NEEDY','NIFTY','NIGHT','NOBLE','NOISE','NORTH',
  'NOTCH','NYMPH',
  // O
  'OCCUR','OCEAN','OLIVE','ONSET','OPTIC','ORBIT','ORDER','OTHER','OTTER','OUGHT',
  'OUTER','OVARY','OVOID',
  // P
  'PAINT','PANIC','PAPAL','PEARL','PENAL','PERCH','PESKY','PHASE','PIANO','PILOT',
  'PINCH','PIRATE','PITCH','PIXEL','PIZZA','PLACE','PLAID','PLAIN','PLANE','PLANK',
  'PLANT','PLAZA','PLEAD','PLUCK','PLUMB','PLUME','PLUMP','PLUNK','PLUSH','POINT',
  'POKER','POLAR','POPPY','POTTY','POUCH','POULT','POUND','POWER','PRANK','PRESS',
  'PRIDE','PRIME','PRIMP','PRIOR','PRISM','PROBE','PRONE','PRONG','PROSE','PROUD',
  'PROWL','PRUDE','PRUNE','PSALM','PUDGY','PULSE','PUNCH','PUPIL','PURSE','PUSHY',
  // Q
  'QUALM','QUERY','QUEST','QUEUE','QUIRK','QUOTA','QUOTE',
  // R
  'RADIX','RALLY','RANCH','RANGE','RAPID','RAVEN','REACH','REALM','REBEL','REIGN',
  'RELAX','RELIC','REPAY','REPEL','REPEL','RESIN','REVEL','RIDER','RIDGE','RIFLE',
  'RIGID','RISKY','RIVAL','RIVER','RIVET','ROAST','ROBIN','ROBOT','ROCKY','ROUGE',
  'ROUGH','ROUND','ROUSE','ROWDY','ROOST','RUGBY','RULER',
  // S
  'SADLY','SAINT','SALVE','SANDY','SANITY','SAUCE','SCALD','SCALE','SCALP','SCAMP',
  'SCANT','SCARE','SCORN','SCORE','SCOUT','SCOWL','SCRAM','SCREW','SCRUB','SEIZE',
  'SENSE','SERVE','SEVEN','SHADE','SHAFT','SHAKE','SHAKY','SHAME','SHAPE','SHARK',
  'SHARP','SHEER','SHEET','SHELF','SHELL','SHIFT','SHINE','SHIRE','SHIRT','SHOCK',
  'SHORT','SHOUT','SHOVE','SHOWY','SHRUG','SIGHT','SILLY','SINCE','SIXTH','SIXTY',
  'SKILL','SKULL','SKUNK','SLACK','SLAIN','SLANG','SLANT','SLASH','SLATE','SLAVE',
  'SLEEK','SLEET','SLICE','SLIDE','SLIME','SLING','SLOSH','SLOTH','SLUMP','SLUNG',
  'SMACK','SMEAR','SMELL','SMILE','SMIRK','SMITE','SMOCK','SMOKE','SMUDGE','SNACK',
  'SNARE','SNEAK','SNIFF','SNORE','SNORT','SNOUT','SOLVE','SOMBER','SONIC','SORRY',
  'SOUTH','SPARE','SPARK','SPEAK','SPEAR','SPECK','SPEED','SPEND','SPICE','SPILL',
  'SPINE','SPOKE','SPOOK','SPOON','SPORE','SPORT','SPOUT','SPRAY','SPREE','SPRIG',
  'SQUAB','SQUAT','SQUID','STACK','STAIN','STALE','STALL','STAMP','STAND','STARE',
  'START','STASH','STAVE','STEAK','STEAL','STEAM','STEEL','STEEP','STERN','STICK',
  'STIFF','STILL','STILT','STING','STINK','STIR','STOCK','STOKE','STOMP','STONE',
  'STOOD','STORM','STORY','STOVE','STRAP','STRAW','STRAY','STRIP','STROP','STRUT',
  'STYLE','SUSHI','SWAMP','SWEAR','SWEAT','SWEEP','SWEET','SWIFT','SWILL','SWING',
  'SWIPE','SWIRL','SWOON','SWOOP',
  // T
  'TABBY','TABLE','TACKY','TAFFY','TAUNT','TAWNY','TEETH','TEMPO','TENSE','TEPID',
  'THANE','THANK','THEME','THICK','THINK','THORN','THREE','THREW','THROB','THROW',
  'THUMB','THUMP','TIARA','TIDAL','TIGER','TIMED','TIPSY','TITAN','TODAY','TOKEN',
  'TONIC','TOPAZ','TORCH','TOTAL','TOUCH','TOUGH','TOXIC','TRACE','TRACK','TRADE',
  'TRAIL','TRAIN','TRAMP','TRASH','TRAWL','TREAD','TREAT','TREK','TREND','TRIAD',
  'TRIAL','TRICK','TRIED','TRITE','TROUT','TRUCE','TRUMP','TRUNK','TRUSS','TRUTH',
  'TULIP','TUNER','TUNIC','TWEAK','TWICE','TWIST','TYING',
  // U
  'ULTRA','UNCLE','UNDER','UNFIT','UNIFY','UNION','UNKID','UNLIT','UNTIL','UNZIP',
  'UPPER','UPSET','URBAN','USHER',
  // V
  'VAGUE','VALID','VALOR','VALVE','VAPOR','VAULT','VENAL','VERSE','VICAR','VIGOR',
  'VIPER','VIRAL','VIRUS','VISOR','VITAL','VIVID','VOCAL','VOGUE','VOICE','VOILA',
  'VOMIT','VOTER',
  // W
  'WALTZ','WARTY','WATCH','WEARY','WEDGE','WEEDY','WEIGH','WEIRD','WHELP','WHIFF',
  'WHINE','WHIRL','WHISK','WHOLE','WIDER','WINDY','WITCH','WORLD','WORMY','WORRY',
  'WORTH','WOULD','WOUND','WRATH','WREAK','WRECK','WRING','WRIST','WRITE','WRONG',
  // Y
  'YACHT','YIELD','YOUNG','YOUTH','YUMMY',
  // Z
  'ZESTY','ZIPPY','ZONAL',
];
function startWordle(room) {
  const word = WORDLE_WORDS[Math.floor(Math.random() * WORDLE_WORDS.length)];
  const maxGuesses = 6;
  room.gameState = { word, maxGuesses, players: {} };
  room.players.forEach(p => { room.gameState.players[p.id] = { guesses: 0, finished: false }; });
  io.to(room.id).emit('game:start', { gameId: 'wordle', maxGuesses });
}
function scoreWordle(guess, word) {
  const result = Array(5).fill('absent');
  const wordArr = word.split('');
  const used = Array(5).fill(false);
  for (let i = 0; i < 5; i++) { if (guess[i] === wordArr[i]) { result[i] = 'correct'; used[i] = true; } }
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'correct') continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guess[i] === wordArr[j]) { result[i] = 'present'; used[j] = true; break; }
    }
  }
  return result;
}

// ── CONNECT4 ──────────────────────────────────────────────────────
function startConnect4(room) {
  const board = Array.from({ length: 6 }, () => Array(7).fill(null));
  const [p1, p2] = room.players;
  const pieces = { [p1.id]: 'red', [p2.id]: 'yellow' };
  room.gameState = { board, pieces, currentPlayer: p1.id };
  io.to(room.id).emit('game:start', { gameId: 'connect4', board, currentPlayer: p1.id, pieces });
}
function checkConnect4Win(board, row, col, piece) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let d = 1; d <= 3; d++) { const r = row+dr*d, c = col+dc*d; if (r<0||r>5||c<0||c>6||board[r][c]!==piece) break; count++; }
    for (let d = 1; d <= 3; d++) { const r = row-dr*d, c = col-dc*d; if (r<0||r>5||c<0||c>6||board[r][c]!==piece) break; count++; }
    if (count >= 4) return true;
  }
  return false;
}

// ── UNO ───────────────────────────────────────────────────────────
const UNO_COLORS = ['red','green','blue','yellow'];
const UNO_VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','+2'];
function buildUnoDeck() {
  const deck = [];
  UNO_COLORS.forEach(c => { UNO_VALUES.forEach(v => { deck.push({color:c,value:v}); if (v !== '0') deck.push({color:c,value:v}); }); });
  for (let i = 0; i < 4; i++) { deck.push({color:'wild',value:'wild'}); deck.push({color:'wild',value:'+4'}); }
  return deck.sort(() => Math.random() - 0.5);
}
function drawUnoCard(gs) { if (gs.deck.length === 0) gs.deck = gs.discard.splice(0, gs.discard.length - 1).sort(() => Math.random() - 0.5); return gs.deck.pop(); }
function canPlayUno(card, top, color) { return card.color === 'wild' || card.color === color || card.value === top.value; }
function getNextUnoPlayer(room, gs) {
  const ids = room.players.map(p => p.id);
  const idx = ids.indexOf(gs.currentPlayer);
  return ids[(idx + gs.direction + ids.length) % ids.length];
}
function advanceUnoTurn(room, gs) {
  gs.currentPlayer = getNextUnoPlayer(room, gs);
  if (gs.skip) { gs.currentPlayer = getNextUnoPlayer(room, gs); gs.skip = false; }
}
function broadcastUnoState(room, gs) {
  room.players.forEach(p => {
    io.to(p.id).emit('uno:state', {
      hand: gs.hands[p.id],
      topCard: gs.topCard,
      currentColor: gs.currentColor,
      currentPlayer: gs.currentPlayer,
      handSizes: Object.fromEntries(room.players.map(pl => [pl.id, gs.hands[pl.id].length])),
    });
  });
}
function startUno(room) {
  const deck = buildUnoDeck();
  const hands = {};
  room.players.forEach(p => { hands[p.id] = deck.splice(0, 7); });
  let topCard = deck.pop();
  while (topCard.color === 'wild') { deck.unshift(topCard); topCard = deck.pop(); }
  room.gameState = { deck, discard: [], hands, topCard, currentColor: topCard.color, currentPlayer: room.players[0].id, direction: 1, skip: false };
  io.to(room.id).emit('game:start', { gameId: 'uno' });
  broadcastUnoState(room, room.gameState);
}

// ── TRIVIA ────────────────────────────────────────────────────────
const TRIVIA_QUESTIONS = [
  { q: 'What is the capital of France?', options: ['London','Berlin','Paris','Madrid'], answer: 'Paris' },
  { q: 'How many sides does a hexagon have?', options: ['5','6','7','8'], answer: '6' },
  { q: 'What planet is closest to the sun?', options: ['Venus','Earth','Mars','Mercury'], answer: 'Mercury' },
  { q: 'Who painted the Mona Lisa?', options: ['Picasso','Da Vinci','Rembrandt','Monet'], answer: 'Da Vinci' },
  { q: 'What is 12 × 12?', options: ['132','144','124','148'], answer: '144' },
  { q: 'Which ocean is the largest?', options: ['Atlantic','Indian','Arctic','Pacific'], answer: 'Pacific' },
  { q: 'What gas do plants absorb?', options: ['Oxygen','Nitrogen','CO2','Hydrogen'], answer: 'CO2' },
  { q: 'How many continents are there?', options: ['5','6','7','8'], answer: '7' },
  { q: 'What is the fastest land animal?', options: ['Lion','Cheetah','Horse','Leopard'], answer: 'Cheetah' },
  { q: 'What year did WW2 end?', options: ['1943','1944','1945','1946'], answer: '1945' },
  { q: 'What is H2O?', options: ['Salt','Sugar','Water','Acid'], answer: 'Water' },
  { q: 'How many bones in the human body?', options: ['196','206','216','226'], answer: '206' },
  { q: 'Which element has symbol Au?', options: ['Silver','Copper','Gold','Iron'], answer: 'Gold' },
  { q: 'What is the smallest prime number?', options: ['0','1','2','3'], answer: '2' },
  { q: 'What language is spoken in Brazil?', options: ['Spanish','French','English','Portuguese'], answer: 'Portuguese' },
];
function startTrivia(room) {
  const questions = [...TRIVIA_QUESTIONS].sort(() => Math.random() - 0.5).slice(0, 8).map(q => ({ question: q.q, options: q.options.sort(() => Math.random() - 0.5), answer: q.answer }));
  room.gameState = { questions, currentQ: 0, answered: {}, players: {} };
  io.to(room.id).emit('game:start', { gameId: 'trivia' });
  io.to(room.id).emit('trivia:question', { question: questions[0], index: 0, total: questions.length });
}

// ── TWO TRUTHS ────────────────────────────────────────────────────
function startTwoTruths(room) {
  room.gameState = { submissions: {}, currentSubject: null, votes: {}, round: 0 };
  io.to(room.id).emit('game:start', { gameId: 'twoTruths' });
  io.to(room.id).emit('twoTruths:submit-phase', { msg: 'Write 2 truths and 1 lie about yourself!' });
}
function nextTwoTruthsRound(room, gs) {
  const subjects = room.players.map(p => p.id);
  if (gs.round >= subjects.length) return endGame(room);
  gs.currentSubject = subjects[gs.round];
  gs.votes = {};
  const subject = room.players.find(p => p.id === gs.currentSubject);
  const statements = gs.submissions[gs.currentSubject];
  const shuffled = [...statements].sort(() => Math.random() - 0.5);
  gs.shuffledStatements = shuffled;
  io.to(room.id).emit('twoTruths:round', { subject: { id: subject.id, username: subject.username, avatar: subject.avatar }, statements: shuffled });
}
function revealTwoTruths(room, gs) {
  const original = gs.submissions[gs.currentSubject];
  const lieIndex = original.findIndex(s => s.isLie);
  const shuffledLieIndex = gs.shuffledStatements.indexOf(original[lieIndex]);
  const correctVoters = [];
  Object.entries(gs.votes).forEach(([pid, vote]) => {
    if (vote === shuffledLieIndex) {
      correctVoters.push(pid);
      const pl = room.players.find(x => x.id === pid);
      if (pl) pl.score += 20;
    }
  });
  io.to(room.id).emit('twoTruths:reveal', { lieIndex: shuffledLieIndex, correctVoters, votes: gs.votes });
  io.to(room.id).emit('room:update', room);
  gs.round++;
  setTimeout(() => nextTwoTruthsRound(room, gs), 4000);
}

// ── WOULD YOU RATHER ──────────────────────────────────────────────
const WOULD_YOU_QUESTIONS = [
  ['Be able to fly', 'Be invisible'],
  ['Always be too hot', 'Always be too cold'],
  ['Have unlimited money', 'Have unlimited time'],
  ['Live in the past', 'Live in the future'],
  ['Be famous', 'Be the best at what you do'],
  ['Lose all your memories', 'Never make new memories'],
  ['Only eat sweet food', 'Only eat salty food'],
  ['Never use social media again', 'Never watch TV or movies again'],
  ['Be able to talk to animals', 'Speak every human language'],
  ['Have no phone', 'Have no computer'],
];
function startWouldYou(room) {
  const questions = [...WOULD_YOU_QUESTIONS].sort(() => Math.random() - 0.5);
  room.gameState = { questions, current: 0, votes: {} };
  io.to(room.id).emit('game:start', { gameId: 'wouldYou' });
  sendWouldYouQuestion(room);
}
function sendWouldYouQuestion(room) {
  const gs = room.gameState;
  if (gs.current >= gs.questions.length) return endGame(room);
  const q = gs.questions[gs.current];
  gs.votes = {};
  io.to(room.id).emit('wouldYou:question', { optionA: q[0], optionB: q[1], index: gs.current, total: gs.questions.length });
}
function revealWouldYou(room, gs) {
  const votes = gs.votes;
  const aVotes = Object.values(votes).filter(v => v === 'A').length;
  const bVotes = Object.values(votes).filter(v => v === 'B').length;
  io.to(room.id).emit('wouldYou:reveal', { votes, aVotes, bVotes });
}
function nextWouldYou(room) {
  room.gameState.current++;
  if (room.gameState.current >= room.gameState.questions.length) return endGame(room);
  sendWouldYouQuestion(room);
}

// ── IMPOSTER ──────────────────────────────────────────────────────
const IMPOSTER_WORDS = [
  ['Pizza','🍕'],['Beach','🏖️'],['School','🏫'],['Guitar','🎸'],['Soccer','⚽'],
  ['Cinema','🎬'],['Library','📚'],['Hospital','🏥'],['Airport','✈️'],['Jungle','🌿'],
];
function startImposter(room) {
  const [word, icon] = IMPOSTER_WORDS[Math.floor(Math.random() * IMPOSTER_WORDS.length)];
  const imposter = room.players[Math.floor(Math.random() * room.players.length)];
  room.gameState = { word, imposter: imposter.id, votes: {} };
  room.players.forEach(p => {
    io.to(p.id).emit('game:start', { gameId: 'imposter' });
    io.to(p.id).emit('imposter:role', p.id === imposter.id
      ? { isImposter: true, msg: "You are the imposter! Don't get caught." }
      : { isImposter: false, word, icon });
  });
  io.to(room.id).emit('imposter:discuss', { players: room.players.map(p => ({ id: p.id, username: p.username, avatar: p.avatar })) });
}
function revealImposter(room, gs) {
  const tally = {};
  Object.values(gs.votes).forEach(v => { tally[v] = (tally[v] || 0) + 1; });
  const mostVoted = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
  const caught = mostVoted === gs.imposter;
  if (caught) {
    room.players.filter(p => p.id !== gs.imposter).forEach(p => { p.score += 30; });
  } else {
    const imp = room.players.find(p => p.id === gs.imposter);
    if (imp) imp.score += 50;
  }
  const imposterPlayer = room.players.find(p => p.id === gs.imposter);
  io.to(room.id).emit('imposter:reveal', { imposter: gs.imposter, imposterName: imposterPlayer ? `${imposterPlayer.avatar} ${imposterPlayer.username}` : '?', word: gs.word, caught, votes: gs.votes });
  io.to(room.id).emit('room:update', room);
  setTimeout(() => endGame(room), 3000);
}

// ── GUESS WHO ─────────────────────────────────────────────────────
function startGuessWho(room) {
  const target = room.players[Math.floor(Math.random() * room.players.length)];
  room.gameState = { target: target.id };
  const clues = [`Their name starts with "${target.username[0].toUpperCase()}"`, `They have the avatar ${target.avatar}`, `Their name has ${target.username.length} letters`];
  io.to(room.id).emit('game:start', { gameId: 'guessWho' });
  io.to(room.id).emit('guessWho:start', { clues, players: room.players.map(p => ({ id: p.id, username: p.username, avatar: p.avatar })) });
}

// ── CONNECTIONS ───────────────────────────────────────────────────
const CONNECTIONS_PUZZLES = [
  { // Tricky: all 4 words can follow "OVER" — or have double meanings
    groups: [
      { category: 'Things that can be "PITCH ___"', color: 'yellow', words: ['BLACK','DARK','PERFECT','FORK'] },
      { category: 'Famous Michaels', color: 'green', words: ['JORDAN','SCOTT','MYERS','PHELPS'] },
      { category: '___ STONE (one word)', color: 'blue', words: ['SAND','LIME','COBBLE','KEY'] },
      { category: 'Things with rings', color: 'purple', words: ['SATURN','TREE','BOXER','PHONE'] },
    ]
  },
  { // Words that are all types of something surprising
    groups: [
      { category: 'Shades of blue', color: 'yellow', words: ['COBALT','TEAL','NAVY','CERULEAN'] },
      { category: 'Things you can "throw"', color: 'green', words: ['PARTY','PUNCH','SHADE','FIT'] },
      { category: 'Famous Drakes', color: 'blue', words: ['RAPPER','DUCK','MALLARD','SIR FRANCIS'] },
      { category: '___ BERRY', color: 'purple', words: ['BLACK','GOOSE','STRAW','BLUE'] },
    ]
  },
  { // Pop culture + wordplay
    groups: [
      { category: 'Things with "FIRE" in them', color: 'yellow', words: ['FIGHTER','PLACE','WORK','SIDE'] },
      { category: 'Words that mean "cool" (slang)', color: 'green', words: ['FIRE','LIT','GOAT','SIC'] },
      { category: 'Harry Potter spells', color: 'blue', words: ['LUMOS','EXPECTO','ALOHOMORA','WINGARDIUM'] },
      { category: 'Famous Johns', color: 'purple', words: ['LENNON','WICK','MULANEY','CENA'] },
    ]
  },
  { // Science + wordplay
    groups: [
      { category: 'Elements on the periodic table', color: 'yellow', words: ['GOLD','IRON','LEAD','TIN'] },
      { category: 'Also a type of wave', color: 'green', words: ['HEAT','CRIME','BRAIN','SHOCK'] },
      { category: 'Things that "orbit"', color: 'blue', words: ['MOON','ELECTRON','SATELLITE','COMET'] },
      { category: '___ BOARD', color: 'purple', words: ['CARD','SKATE','SURF','KEY'] },
    ]
  },
  { // Food tricky category
    groups: [
      { category: 'Things in a taco', color: 'yellow', words: ['SHELL','BEEF','LIME','CHEESE'] },
      { category: 'Computer ___', color: 'green', words: ['VIRUS','MOUSE','DESKTOP','CRASH'] },
      { category: 'NBA teams (no city)', color: 'blue', words: ['HEAT','BULLS','MAGIC','JAZZ'] },
      { category: 'Words that rhyme with GHOST', color: 'purple', words: ['MOST','TOAST','COAST','ROAST'] },
    ]
  },
  { // Deceptive — all 4 look like they could belong together
    groups: [
      { category: 'Things you can "crack"', color: 'yellow', words: ['CODE','JOKE','SAFE','KNUCKLE'] },
      { category: 'Types of music', color: 'green', words: ['ROCK','SOUL','POP','METAL'] },
      { category: 'Also a type of wrestling move', color: 'blue', words: ['SLAM','LOCK','CHOKE','DRIVER'] },
      { category: 'Famous Willows', color: 'purple', words: ['TREE','ROSENBERG','SMITH','WEEPING'] },
    ]
  },
];
function startConnections(room) {
  const puzzle = CONNECTIONS_PUZZLES[Math.floor(Math.random() * CONNECTIONS_PUZZLES.length)];
  const allWords = puzzle.groups.flatMap(g => g.words).sort(() => Math.random() - 0.5);
  room.gameState = { groups: puzzle.groups, words: allWords, players: {} };
  room.players.forEach(p => { room.gameState.players[p.id] = { solved: [], mistakes: 0, finished: false }; });
  io.to(room.id).emit('game:start', { gameId: 'connections', words: allWords });
}

// ── CONTEXTO ──────────────────────────────────────────────────────
const CONTEXTO_TARGETS = [
  { word: 'ocean', similar: ['sea','water','wave','beach','fish','salt','deep','coral','tide','swim','coast','marine','blue','vast','current'] },
  { word: 'pizza', similar: ['cheese','dough','sauce','slice','topping','pepperoni','italian','bake','crust','oven','meal','food','dinner','round','mozzarella'] },
  { word: 'music', similar: ['song','beat','rhythm','melody','sound','note','band','sing','concert','guitar','drum','piano','lyrics','album','tune'] },
  { word: 'school', similar: ['learn','teacher','student','class','study','desk','book','homework','grade','pencil','math','test','chalk','lesson','education'] },
  { word: 'forest', similar: ['tree','wood','leaf','nature','wild','animal','bird','path','green','shade','bark','branch','moss','trail','deer'] },
];
// Big list of common English words so almost any guess is accepted
const COMMON_WORDS = [
  'the','a','is','in','on','at','to','of','and','or','but','with','for','from','by',
  'about','as','into','through','during','before','after','above','below','between',
  'out','off','over','under','again','further','then','once','here','there','when',
  'where','why','how','all','both','each','few','more','most','other','some','such',
  'no','not','only','same','so','than','too','very','just','because','if','while',
  'although','however','therefore','unless','until','even','also','back','new','old',
  'first','last','long','great','little','own','right','big','high','small','large',
  'next','early','young','hard','free','open','real','best','able','good','bad',
  'move','live','place','hold','turn','show','play','run','need','try','tell','ask',
  'seem','feel','become','leave','put','mean','keep','let','begin','work','show',
  'hear','play','might','well','also','back','many','way','look','make','like','time',
  'know','take','see','come','think','give','use','find','want','say','get','go',
  'man','woman','child','year','day','week','month','city','country','world','home',
  'house','room','hand','face','eye','head','body','heart','mind','life','side',
  'night','day','morning','afternoon','evening','sun','moon','star','sky','land',
  'water','fire','air','earth','ground','road','way','door','window','wall','floor',
  'tree','plant','flower','grass','rain','snow','wind','storm','cloud','light','dark',
  'color','red','blue','green','yellow','black','white','brown','pink','purple',
  'big','small','hot','cold','warm','cool','fast','slow','high','low','near','far',
  'up','down','left','right','front','back','inside','outside','top','bottom',
  'dog','cat','bird','fish','horse','cow','pig','sheep','lion','tiger','bear',
  'food','eat','drink','cook','taste','sweet','sour','salty','bitter','spicy',
  'happy','sad','angry','scared','surprised','calm','excited','tired','hungry',
  'beautiful','ugly','clean','dirty','quiet','loud','heavy','light','strong','weak',
  'rich','poor','full','empty','deep','shallow','thick','thin','wide','narrow',
  'car','bus','train','plane','boat','ship','bike','truck','road','street','bridge',
  'school','work','play','study','learn','teach','read','write','draw','build',
  'money','price','buy','sell','store','shop','market','bank','pay','cost',
  'family','friend','love','care','help','share','give','take','hold','touch',
  'music','song','dance','sing','listen','sound','noise','voice','speak','talk',
  'sport','game','ball','team','win','lose','score','goal','race','run','jump',
  'book','story','word','name','letter','number','math','science','history','art',
  'phone','computer','internet','screen','video','photo','camera','radio','TV',
  'cloth','wear','dress','shirt','pants','shoes','hat','coat','bag','box',
  'chair','table','bed','sofa','lamp','clock','mirror','cup','plate','spoon',
  'key','lock','open','close','push','pull','lift','carry','drop','throw','catch',
  'sick','healthy','doctor','medicine','hospital','pain','sleep','wake','rest',
  'king','queen','country','army','war','peace','law','rule','power','freedom',
  'church','god','pray','believe','spirit','soul','heaven','earth',
  'ocean','sea','river','lake','mountain','valley','forest','desert','island',
  'gold','silver','iron','stone','wood','glass','plastic','metal','paper','rope',
  'small','tiny','huge','giant','short','tall','young','old','new','ancient',
  'acid','atom','base','bond','cell','coal','core','disk','echo','edge',
  'face','fact','fall','farm','fast','fate','fear','feel','felt','file',
  'film','fire','firm','fish','fist','flag','flat','flew','flip','flow',
  'foam','fold','folk','fond','foot','ford','form','fort','foul','four',
  'fowl','free','from','fuel','full','fund','fuse','gain','gale','gaze',
  'gear','gift','girl','give','glad','glow','glue','goal','gone','gore',
  'gown','grab','gray','grew','grey','grim','grip','grit','grow','gulf',
  'gust','halt','hang','harm','have','hawk','help','here','hero','hide',
  'hill','hint','hire','hole','holy','hood','hook','hope','horn','host',
  'hour','hunt','hurt','idea','inch','iron','item','join','joke','jump',
  'keep','kick','kill','kind','king','kiss','knew','know','lack','laid',
  'lake','laid','lame','lamp','lane','lard','lark','lash','lass','laud',
  'lava','lean','leap','lend','lens','lest','lick','limb','line','link',
  'lion','list','load','loaf','loan','lobe','lock','loin','lore','loss',
  'loud','love','luck','lure','lurk','mace','mail','main','male','mall',
  'malt','mare','mark','mart','mast','mate','maze','meal','mean','meat',
  'melt','mesh','mice','milk','mill','mine','mint','moan','mode','molt',
  'monk','moor','mope','mort','moss','mote','moth','mule','murk','myth',
  'nail','name','need','nest','news','node','norm','note','noun','nude',
  'null','numb','omen','once','open','oral','orca','orb','oven','pact',
  'page','paid','pail','palm','pant','park','part','past','path','pave',
  'pawn','peak','peel','pelt','pick','pier','pile','pine','pipe','pith',
  'plod','plop','plot','plow','ploy','plug','poke','pole','poll','pond',
  'pore','port','pose','post','pour','prey','prig','prod','prop','prow',
  'pull','pump','pyre','rack','rage','raid','rail','rake','ramp','rang',
  'rank','rant','rash','rate','rave','read','rein','rely','rend','rent',
  'rest','rift','ring','rink','riot','rise','robe','role','roll','roof',
  'rook','root','rope','rout','rove','ruin','rule','rune','rush','rust',
  'saga','said','sail','sale','sand','sang','sank','save','scab','seal',
  'seam','seat','seed','seek','self','shed','shin','shop','shot','sick',
  'sign','silk','sing','sink','site','size','slab','sled','slew','slim',
  'slip','slot','slug','slur','smug','snap','snip','snow','soak','soar',
  'sock','soil','sold','sole','some','song','soul','soup','sour','span',
  'spec','spin','spit','spot','spur','stab','stag','stat','stem','step',
  'stop','stub','stud','stun','such','suit','sung','sunk','swap','swim',
  'sync','tale','tall','tame','tape','task','taxi','tear','teem','tell',
  'tend','term','test','text','than','that','them','then','they','thin',
  'this','thorn','tide','tied','tile','till','tilt','tire','toil','told',
  'toll','tomb','tone','took','tool','tore','torn','toss','tote','tour',
  'trap','trim','trip','trod','trot','tube','tuck','tuft','tug','tune',
  'turf','tusk','twig','type','upon','urge','used','user','vast','verb',
  'vest','veto','view','vile','vine','void','vote','wade','wage','wail',
  'wake','wane','warp','wart','wavy','weld','went','wept','what','when',
  'whom','wick','wild','wilt','wink','wire','wise','wish','wisp','with',
  'woke','wolf','womb','wore','worm','wove','wrap','wren','wring','yard',
  'yarn','yelp','yoke','your','zero','zone',
];

function buildContextoRankMap(target) {
  const map = { [target.word]: 0 };
  target.similar.forEach((w, i) => { map[w] = i + 1; });
  // Assign far-away ranks to all common words not already mapped
  let rank = target.similar.length + 1;
  COMMON_WORDS.forEach(w => {
    if (map[w] === undefined) { map[w] = rank++; }
  });
  return map;
}
function startContexto(room) {
  const target = CONTEXTO_TARGETS[Math.floor(Math.random() * CONTEXTO_TARGETS.length)];
  const rankMap = buildContextoRankMap(target);
  room.gameState = { target: target.word, rankMap, players: {} };
  room.players.forEach(p => { room.gameState.players[p.id] = { guesses: 0, finished: false, history: [] }; });
  io.to(room.id).emit('game:start', { gameId: 'contexto' });
}

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Goon Room running on http://localhost:${PORT}`));
