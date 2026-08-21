// Đuổi Niên Thú (Nien Monster Chase) — a fourth backup game alongside UNO,
// Exploding Kittens, and Go. Same "casual side activity" contract as those
// three: its own Socket.IO namespace, no leaderboard, no admin open/close
// gating (see server.js).
//
// Unlike the turn-based games, this is a real-time shared arena: players
// move continuously and throw firecrackers to scare a server-controlled
// Niên Thú into dropping gifts. This is the MVP slice of the full GDD
// (public/midautumnevent.md) — Phases 1+2 (core loop + networking) only.
// The pre-game stat loadout (Phase 3) is deliberately deferred; every
// player/bot uses the same fixed movement speed / firecracker stats for
// now. Bots ARE included (added early, ahead of the GDD's Phase 3) purely
// to make multiplayer testable without needing several real people — their
// AI is a simple "chase the nearest useful thing" heuristic, not the GDD's
// eventual A* pathfinding (there are no obstacles in this arena yet for
// pathfinding to matter).

const TICK_MS = 80; // ~12.5 updates/sec — plenty smooth for a LAN event, low bandwidth.
const MAX_PLAYERS = 8;
const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi', '🤖 Bot Dũng', '🤖 Bot Giang', '🤖 Bot Hà'];

const PLAYER_SPEED = 160; // px/sec
const PLAYER_RADIUS = 16;
const PICKUP_RADIUS = 26;

const MONSTER_RADIUS = 24;
const MONSTER_WANDER_SPEED = 45;
const MONSTER_FLEE_SPEED = 190;
const MONSTER_FLEE_MS = 2200;
const MONSTER_RESPAWN_DELAY_MS = 60000; // matches the GDD's "every 60 seconds"

const FIRECRACKER_RANGE = 190; // max distance from the thrower a target point may be — same for every type in this pass

// Flat penalty (independent of firecracker type) for holding a burned-out
// firecracker too long without throwing it: it goes off in the player's
// hands and stuns them (can't move) for this long.
const SELF_DETONATE_STUN_MS = 3000;

// Pre-game loadout catalog: each player spends a shared point budget on a
// mix of these before the chase starts. Radius/fear/cost are tuned so a
// Large firecracker roughly trades 2.5x the cost of a Small one for ~3x the
// AoE area and ~3x the fear damage — a real but not overwhelming edge.
//
// Throwing one is a 3-phase action (all times in seconds):
//   1. timeToBurn — lighting it. The thrower is ROOTED (cannot move) for
//      this whole phase, human or bot alike.
//   2. timeBeforeExplosion — once burned out, it's "armed": lit and ready,
//      sitting in the thrower's hand. They're free to move during this
//      window while aiming, and must click a target to actually throw it
//      (an immediate, instant-resolving release — no further delay) before
//      this window runs out. Let it run out and it goes off in their
//      hands instead: no damage to the Niên Thú, just the flat
//      SELF_DETONATE_STUN_MS stun above.
//   3. nextBurnTime — cooldown, counted from the moment the firecracker
//      actually leaves their hand (thrown OR self-detonated), before they
//      can start lighting another one (any type).
const FIRECRACKER_TYPES = {
  small: { key: 'small', label: 'Pháo tép', emoji: '🧨', radius: 50, fear: 12, cost: 5, timeToBurn: 1, timeBeforeExplosion: 2, nextBurnTime: 0.5 },
  medium: { key: 'medium', label: 'Pháo chuột', emoji: '🎆', radius: 75, fear: 20, cost: 10, timeToBurn: 2, timeBeforeExplosion: 3, nextBurnTime: 1 },
  large: { key: 'large', label: 'Pháo cối', emoji: '💣', radius: 110, fear: 35, cost: 25, timeToBurn: 5, timeBeforeExplosion: 5, nextBurnTime: 3 },
};
const FIRECRACKER_KEYS = Object.keys(FIRECRACKER_TYPES);
const DEFAULT_LOADOUT_BUDGET = 100; // matches the GDD's own example budget
const LOADOUT_BUDGET_OPTIONS = [50, 100, 150, 200]; // presets the room host can pick from at creation

const FEAR_MILESTONES = [25, 50, 75, 100];

function totalLoadoutCost(loadout) {
  if (!loadout) return 0;
  return FIRECRACKER_KEYS.reduce((sum, key) => sum + (loadout[key] || 0) * FIRECRACKER_TYPES[key].cost, 0);
}

function emptyLoadout() {
  return { small: 0, medium: 0, large: 0 };
}

// Used when a player (human or bot) never visited the shop before Start is
// clicked, so nobody ever begins a match with zero usable firecrackers.
// Humans get the simplest possible spend (all-in on the cheapest type);
// bots get a randomized mix so their AI actually exercises every type
// across enough test games.
function autoFillLoadout(budget, { randomized = false } = {}) {
  const loadout = emptyLoadout();
  if (!randomized) {
    loadout.small = Math.floor(budget / FIRECRACKER_TYPES.small.cost);
    return loadout;
  }
  let remaining = budget;
  let guard = 0; // safety valve — budgets are small enough this never realistically triggers
  while (remaining > 0 && guard < 1000) {
    guard += 1;
    const affordable = FIRECRACKER_KEYS.filter((key) => FIRECRACKER_TYPES[key].cost <= remaining);
    if (!affordable.length) break;
    const key = affordable[Math.floor(Math.random() * affordable.length)];
    loadout[key] += 1;
    remaining -= FIRECRACKER_TYPES[key].cost;
  }
  return loadout;
}

// Once the last piece of loot for the game has been dropped, players get a
// short scramble window to grab whatever's still on the ground before the
// game ends — a small addition on top of the GDD's literal "game ends when
// all loot is dropped" so the ending doesn't feel like it's cut off mid-grab.
const FINAL_CALL_MS = 8000;
// Safety net: if bad luck means the loot pool never gets fully dropped,
// don't let a room run forever.
const MAX_GAME_DURATION_MS = 6 * 60 * 1000;

const LOOT_TYPES = [
  { type: 'starLantern', label: 'Star Lantern', emoji: '⭐', value: 10, weight: 3 },
  { type: 'mooncake', label: 'Mooncake', emoji: '🥮', value: 20, weight: 1 },
  { type: 'redCandle', label: 'Red Candle', emoji: '🕯️', value: 5, weight: 3 },
];
const LOOT_WEIGHT_TOTAL = LOOT_TYPES.reduce((sum, t) => sum + t.weight, 0);

function pickLootType() {
  let roll = Math.random() * LOOT_WEIGHT_TOTAL;
  for (const t of LOOT_TYPES) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return LOOT_TYPES[0];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Map grows with the table so a full room doesn't feel cramped, but caps
// out so a huge crowd doesn't turn it into an empty walking simulator.
function computeMapSize(playerCount) {
  const size = clamp(520 + (playerCount - 1) * 140, 520, 1400);
  return { width: size, height: size };
}

// More players means more hands grabbing loot, so scale the total pool with
// the table size — otherwise a big room would exhaust it almost instantly.
function computeLootBudget(playerCount) {
  return Math.max(20, playerCount * 10);
}

class NienRoom {
  constructor(id, name, password, loadoutBudget) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.loadoutBudget = LOADOUT_BUDGET_OPTIONS.includes(Number(loadoutBudget)) ? Number(loadoutBudget) : DEFAULT_LOADOUT_BUDGET;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, x, y, dir, score, burning, armed, stunnedUntil, nextBurnAt, loadout, inventory }
    this.botCounter = 0;
    this.mapWidth = 0;
    this.mapHeight = 0;
    this.monster = null; // { x, y, fear, fleeDir, fleeUntil, wanderDir, milestonesHit }
    this.loot = []; // { id, type, label, emoji, value, x, y }
    this.lootRemaining = 0;
    this.lootCounter = 0;
    this.finalCallDeadline = null;
    this.startedAt = null;
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.tickTimer = null;
    this.monsterSpawnTimer = null;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  isEmpty() {
    return this.players.length === 0 || this.players.every((p) => !p.connected);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      playerCount: this.players.filter((p) => p.connected).length,
    };
  }

  startGame() {
    const n = this.players.length;
    const { width, height } = computeMapSize(n);
    this.mapWidth = width;
    this.mapHeight = height;
    this.players.forEach((p) => {
      p.x = PLAYER_RADIUS + Math.random() * (width - PLAYER_RADIUS * 2);
      p.y = PLAYER_RADIUS + Math.random() * (height - PLAYER_RADIUS * 2);
      p.dir = { x: 0, y: 0 };
      p.score = 0;
      p.burning = null;
      p.armed = null;
      p.stunnedUntil = 0;
      p.nextBurnAt = 0;
      // Anyone (human or bot) who never spent any points at the shop gets
      // an automatic loadout so nobody starts the match with zero
      // firecrackers just because they forgot to visit the shop.
      if (!p.loadout || totalLoadoutCost(p.loadout) === 0) {
        p.loadout = autoFillLoadout(this.loadoutBudget, { randomized: Boolean(p.isBot) });
      }
      p.inventory = { ...p.loadout };
    });
    this.loot = [];
    this.lootCounter = 0;
    this.lootRemaining = computeLootBudget(n);
    this.finalCallDeadline = null;
    this.monster = null;
    clearTimeout(this.monsterSpawnTimer);
    this.status = 'playing';
    this.startedAt = Date.now();
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.pushLog(`🎉 The chase begins on a ${width}x${height} map!`);
    this.spawnMonster();
  }

  spawnMonster() {
    this.monster = {
      x: MONSTER_RADIUS + Math.random() * (this.mapWidth - MONSTER_RADIUS * 2),
      y: MONSTER_RADIUS + Math.random() * (this.mapHeight - MONSTER_RADIUS * 2),
      fear: 0,
      fleeDir: null,
      fleeUntil: 0,
      wanderDir: null,
      milestonesHit: [],
    };
    this.pushLog('👹 The Niên Thú has appeared!');
  }

  scheduleMonsterSpawn() {
    clearTimeout(this.monsterSpawnTimer);
    this.monsterSpawnTimer = setTimeout(() => {
      this.monsterSpawnTimer = null;
      if (this.status === 'playing') this.spawnMonster();
    }, MONSTER_RESPAWN_DELAY_MS);
  }

  setPlayerInput(player, dx, dy) {
    const mag = Math.hypot(dx, dy);
    if (!Number.isFinite(mag) || mag === 0) {
      player.dir = { x: 0, y: 0 };
      return;
    }
    const scale = mag > 1 ? 1 / mag : 1;
    player.dir = { x: dx * scale, y: dy * scale };
  }

  // Pre-game shop: delta is +1/-1 per click. Rejects anything that would
  // go negative or blow the room's shared point budget, leaving the
  // player's loadout untouched on failure.
  adjustLoadout(player, type, delta) {
    const def = FIRECRACKER_TYPES[type];
    if (!def || !Number.isInteger(delta) || delta === 0) return { ok: false, error: 'invalid-request' };
    if (!player.loadout) player.loadout = emptyLoadout();
    const newCount = player.loadout[type] + delta;
    if (newCount < 0) return { ok: false, error: 'invalid-count' };
    const newLoadout = { ...player.loadout, [type]: newCount };
    if (totalLoadoutCost(newLoadout) > this.loadoutBudget) return { ok: false, error: 'budget-exceeded' };
    player.loadout = newLoadout;
    return { ok: true, loadout: newLoadout };
  }

  dropLoot(centerX, centerY, count) {
    for (let i = 0; i < count; i++) {
      if (this.lootRemaining <= 0) break;
      const t = pickLootType();
      const angle = Math.random() * Math.PI * 2;
      const dist = 20 + Math.random() * 60;
      const x = clamp(centerX + Math.cos(angle) * dist, 10, this.mapWidth - 10);
      const y = clamp(centerY + Math.sin(angle) * dist, 10, this.mapHeight - 10);
      this.lootCounter += 1;
      this.loot.push({ id: `loot_${this.lootCounter}`, type: t.type, label: t.label, emoji: t.emoji, value: t.value, x, y });
      this.lootRemaining -= 1;
    }
    if (this.lootRemaining <= 0 && !this.finalCallDeadline) {
      this.finalCallDeadline = Date.now() + FINAL_CALL_MS;
      this.pushLog(`🎐 All the loot has been released! ${FINAL_CALL_MS / 1000}s left to grab what's on the ground!`);
    }
  }

  scareMonster(explosionX, explosionY, fearAmount) {
    const m = this.monster;
    if (!m) return;
    m.fear = Math.min(100, m.fear + fearAmount);
    const dx = m.x - explosionX;
    const dy = m.y - explosionY;
    const dist = Math.hypot(dx, dy) || 1;
    m.fleeDir = { x: dx / dist, y: dy / dist };
    m.fleeUntil = Date.now() + MONSTER_FLEE_MS;
    this.pushLog(`😱 The Niên Thú's fear rose to ${m.fear}%!`);

    const crossed = FEAR_MILESTONES.filter((ms) => m.fear >= ms && !m.milestonesHit.includes(ms));
    crossed.forEach((ms) => {
      m.milestonesHit.push(ms);
      this.dropLoot(m.x, m.y, ms === 100 ? 3 : 1);
    });

    if (m.fear >= 100) {
      this.pushLog('🏃 The Niên Thú fled completely! It will return in 60 seconds.');
      this.monster = null;
      this.scheduleMonsterSpawn();
    }
  }

  // Starts LIGHTING a firecracker — no target yet, and nothing explodes by
  // itself. The player is rooted (see tick()'s movement loop, which skips
  // anyone with `burning` set) until timeToBurn elapses, at which point
  // resolveFirecrackers() arms it (see releaseFirecracker()). Ammo is
  // spent the moment the burn is accepted, not when it eventually
  // resolves (thrown or fizzled in-hand).
  startBurning(player, type) {
    const def = FIRECRACKER_TYPES[type];
    if (!def) return { ok: false, error: 'invalid-type' };
    if (player.burning || player.armed) return { ok: false, error: 'busy' };
    const now = Date.now();
    if (player.stunnedUntil && now < player.stunnedUntil) return { ok: false, error: 'stunned' };
    if (player.nextBurnAt && now < player.nextBurnAt) return { ok: false, error: 'cooldown' };
    if (!player.inventory || !player.inventory[type]) return { ok: false, error: 'out-of-ammo' };

    player.inventory[type] -= 1;
    player.burning = { type, burnEndsAt: now + def.timeToBurn * 1000 };
    this.pushLog(`🔥 ${player.name} is lighting a ${def.label}...`);
    return { ok: true };
  }

  // Actually throws an ARMED firecracker at a target — the payoff of the
  // burn/arm sequence above. Resolves immediately (no further delay):
  // the AoE check happens right now, against wherever the Niên Thú
  // currently is. Starts the nextBurnTime cooldown on success.
  releaseFirecracker(player, targetX, targetY) {
    if (!player.armed) return { ok: false, error: 'not-armed' };
    const { type } = player.armed;
    const def = FIRECRACKER_TYPES[type];

    const dx = targetX - player.x;
    const dy = targetY - player.y;
    const dist = Math.hypot(dx, dy);
    let tx = targetX;
    let ty = targetY;
    if (dist > FIRECRACKER_RANGE) {
      const ratio = FIRECRACKER_RANGE / dist;
      tx = player.x + dx * ratio;
      ty = player.y + dy * ratio;
    }
    tx = clamp(tx, 0, this.mapWidth);
    ty = clamp(ty, 0, this.mapHeight);

    player.armed = null;
    player.nextBurnAt = Date.now() + def.nextBurnTime * 1000;
    this.pushLog(`💥 ${player.name} threw a ${def.label}!`);

    let hitMonster = false;
    if (this.monster) {
      const d = Math.hypot(this.monster.x - tx, this.monster.y - ty);
      if (d <= def.radius + MONSTER_RADIUS) {
        hitMonster = true;
        this.scareMonster(tx, ty, def.fear);
      }
    }

    return { ok: true, explosion: { x: tx, y: ty, radius: def.radius, hitMonster, type } };
  }

  // Advances every player's firecracker state by whatever just happened
  // this tick: (1) a burn that just finished ARMS the firecracker —
  // lit and ready, sitting in the thrower's hand, who is free to move
  // again immediately while deciding where to throw; (2) an armed
  // firecracker whose throw window just ran out without being released
  // goes off in the thrower's own hands instead — no damage to the Niên
  // Thú, just the flat SELF_DETONATE_STUN_MS stun (and it still starts
  // the normal nextBurnTime cooldown). Returns { selfDetonations } for
  // the caller to broadcast as a 'nien:selfdetonate' event.
  resolveFirecrackers(now) {
    const selfDetonations = [];
    this.players.forEach((p) => {
      if (p.burning && now >= p.burning.burnEndsAt) {
        const def = FIRECRACKER_TYPES[p.burning.type];
        p.armed = { type: p.burning.type, readyUntil: now + def.timeBeforeExplosion * 1000 };
        p.burning = null;
        this.pushLog(`✨ ${p.name}'s ${def.label} is lit and ready to throw!`);
      } else if (p.armed && now >= p.armed.readyUntil) {
        const def = FIRECRACKER_TYPES[p.armed.type];
        p.armed = null;
        p.stunnedUntil = now + SELF_DETONATE_STUN_MS;
        p.nextBurnAt = now + def.nextBurnTime * 1000;
        this.pushLog(`💥 ${p.name} held the ${def.label} too long — it went off in their hands! Stunned!`);
        selfDetonations.push({ playerId: p.id, x: p.x, y: p.y });
      }
    });
    return { selfDetonations };
  }

  // Simple heuristic bot AI, run once per tick before the normal movement
  // step: chase the monster if one's alive, otherwise beeline for the
  // nearest loot on the ground, otherwise wander gently. This is
  // deliberately simpler than the GDD's eventual A* pathfinding — there
  // are no obstacles in this arena for pathfinding to route around, so a
  // straight-line target is equivalent. Bots throw firecrackers at the
  // monster whenever it's in range and off cooldown, exactly like a human
  // would via a click. Returns any explosions produced (for broadcasting).
  // Returns any explosions bots produced this tick by releasing an armed
  // firecracker (for the caller to broadcast as 'nien:boom', same as a
  // human's release).
  updateBotAI() {
    const now = Date.now();
    const explosions = [];
    this.players.forEach((p) => {
      if (!p.isBot || !p.connected) return;
      if (p.burning) return; // mid-light and rooted — nothing to decide
      if (p.stunnedUntil && now < p.stunnedUntil) return; // stunned, can't act or move

      let target = null;
      if (this.monster) {
        target = this.monster;
      } else if (this.loot.length) {
        target = this.loot.reduce((closest, item) => (
          !closest || distance(p, item) < distance(p, closest) ? item : closest
        ), null);
      }

      if (target) {
        this.setPlayerInput(p, target.x - p.x, target.y - p.y);
      } else {
        if (!p.botWanderDir || Math.random() < 0.03) {
          const angle = Math.random() * Math.PI * 2;
          p.botWanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        this.setPlayerInput(p, p.botWanderDir.x, p.botWanderDir.y);
      }

      if (p.armed) {
        // Holding a lit one — bots don't hesitate, they release the
        // instant the monster is in range rather than risk fizzling it.
        if (this.monster && distance(p, this.monster) <= FIRECRACKER_RANGE + MONSTER_RADIUS) {
          const result = this.releaseFirecracker(p, this.monster.x, this.monster.y);
          if (result.ok) explosions.push(result.explosion);
        }
        return;
      }

      if (this.monster) {
        const canBurn = !p.nextBurnAt || now >= p.nextBurnAt;
        // Prefer the strongest type still in stock — bots don't ration
        // ammo, they just use the best they have until it runs out.
        const chosenType = [...FIRECRACKER_KEYS]
          .sort((a, b) => FIRECRACKER_TYPES[b].fear - FIRECRACKER_TYPES[a].fear)
          .find((key) => p.inventory && p.inventory[key] > 0);
        if (chosenType && canBurn && distance(p, this.monster) <= FIRECRACKER_RANGE + MONSTER_RADIUS) {
          this.startBurning(p, chosenType);
        }
      }
    });
    return explosions;
  }

  // Advances the world by one tick's worth of time. Deliberately takes no
  // arguments and does no broadcasting — kept pure so tests can call it
  // directly without real timers or a live Socket.IO server. Returns any
  // explosions bots threw this tick, so the caller can broadcast 'nien:boom'
  // for them the same way a human's throw does.
  tick() {
    if (this.status !== 'playing') return { explosions: [], selfDetonations: [] };
    const dt = TICK_MS / 1000;
    const now = Date.now();

    const explosions = this.updateBotAI();

    this.players.forEach((p) => {
      if (!p.connected || !p.dir) return;
      if (p.burning) return; // rooted while lighting a firecracker
      if (p.stunnedUntil && now < p.stunnedUntil) return; // rooted after fizzling one in their hands
      p.x = clamp(p.x + p.dir.x * PLAYER_SPEED * dt, PLAYER_RADIUS, this.mapWidth - PLAYER_RADIUS);
      p.y = clamp(p.y + p.dir.y * PLAYER_SPEED * dt, PLAYER_RADIUS, this.mapHeight - PLAYER_RADIUS);
    });

    if (this.monster) {
      const m = this.monster;
      if (m.fleeUntil && now < m.fleeUntil) {
        m.x = clamp(m.x + m.fleeDir.x * MONSTER_FLEE_SPEED * dt, MONSTER_RADIUS, this.mapWidth - MONSTER_RADIUS);
        m.y = clamp(m.y + m.fleeDir.y * MONSTER_FLEE_SPEED * dt, MONSTER_RADIUS, this.mapHeight - MONSTER_RADIUS);
      } else {
        if (!m.wanderDir || Math.random() < 0.02) {
          const angle = Math.random() * Math.PI * 2;
          m.wanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        m.x = clamp(m.x + m.wanderDir.x * MONSTER_WANDER_SPEED * dt, MONSTER_RADIUS, this.mapWidth - MONSTER_RADIUS);
        m.y = clamp(m.y + m.wanderDir.y * MONSTER_WANDER_SPEED * dt, MONSTER_RADIUS, this.mapHeight - MONSTER_RADIUS);
      }
    }

    const { selfDetonations } = this.resolveFirecrackers(now);

    this.loot = this.loot.filter((item) => {
      const collector = this.players.find((p) => p.connected && distance(p, item) <= PICKUP_RADIUS);
      if (collector) {
        collector.score += item.value;
        this.pushLog(`${collector.name} collected a ${item.label} (+${item.value})!`);
        return false;
      }
      return true;
    });

    if (this.finalCallDeadline && now >= this.finalCallDeadline) {
      this.finishGame('🎐 All the loot has been claimed!');
      return { explosions, selfDetonations };
    }
    if (this.startedAt && now - this.startedAt >= MAX_GAME_DURATION_MS) {
      this.finishGame("⏰ Time's up!");
    }
    return { explosions, selfDetonations };
  }

  finishGame(reason) {
    this.status = 'finished';
    clearTimeout(this.monsterSpawnTimer);
    this.monsterSpawnTimer = null;
    const ranking = [...this.players].sort((a, b) => b.score - a.score);
    this.winnerId = ranking.length && ranking[0].score > 0 ? ranking[0].id : null;
    const winner = this.winnerId ? this.findPlayer(this.winnerId) : null;
    this.resultText = winner ? `${reason} ${winner.name} wins with ${winner.score} points!` : `${reason} No one scored — no winner.`;
    this.pushLog(this.resultText);
  }

  startTicking(nsp) {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      try {
        const { explosions, selfDetonations } = this.tick();
        this.broadcast(nsp);
        (explosions || []).forEach((ev) => this.broadcastEvent(nsp, 'nien:boom', ev));
        (selfDetonations || []).forEach((ev) => this.broadcastEvent(nsp, 'nien:selfdetonate', ev));
      } catch (err) {
        console.error(`[nien] tick failed in room ${this.id}:`, err);
      }
      if (this.status !== 'playing' && this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }, TICK_MS);
  }

  state(forPlayerId) {
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      loadoutBudget: this.loadoutBudget,
      firecrackerTypes: FIRECRACKER_TYPES,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        score: p.score,
        connected: p.connected,
        isBot: Boolean(p.isBot),
        loadout: p.loadout || emptyLoadout(),
        inventory: p.inventory || null,
        burning: p.burning ? { type: p.burning.type, burnEndsAt: p.burning.burnEndsAt } : null,
        armed: p.armed ? { type: p.armed.type, readyUntil: p.armed.readyUntil } : null,
        stunnedUntil: p.stunnedUntil || 0,
        nextBurnAt: p.nextBurnAt || 0,
      })),
      monster: this.monster ? { x: this.monster.x, y: this.monster.y, fear: this.monster.fear } : null,
      loot: this.loot.map((l) => ({ id: l.id, type: l.type, emoji: l.emoji, value: l.value, x: l.x, y: l.y })),
      lootRemaining: this.lootRemaining,
      finalCallDeadline: this.finalCallDeadline,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      yourId: forPlayerId || null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('nien:state', this.state(p.id));
    });
  }

  broadcastEvent(nsp, event, payload) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit(event, payload);
    });
  }
}

function attachNien(io) {
  const nsp = io.of('/nien');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('nien:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearInterval(room.tickTimer);
      clearTimeout(room.monsterSpawnTimer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    socket.emit('nien:rooms', roomList());

    socket.on('nien:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('nien:createRoom', ({ roomName, password, playerId, name, loadoutBudget }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new NienRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, loadoutBudget);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, x: 0, y: 0, dir: { x: 0, y: 0 }, score: 0, burning: null, armed: null, stunnedUntil: 0, nextBurnAt: 0, loadout: emptyLoadout() });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('nien:joinRoom', ({ roomId, password, playerId, name }, callback) => {
      const room = rooms.get(roomId);
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-such-room' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      const existing = room.findPlayer(playerId);

      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        existing.name = clean;
      } else {
        if (String(password || '') !== room.password) { if (typeof callback === 'function') callback({ ok: false, error: 'wrong-password' }); return; }
        if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'game-in-progress' }); return; }
        if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, x: 0, y: 0, dir: { x: 0, y: 0 }, score: 0, burning: null, armed: null, stunnedUntil: 0, nextBurnAt: 0, loadout: emptyLoadout() });
        room.pushLog(`${clean} joined the room.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('nien:addBots', ({ count }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const n = Math.max(1, Math.min(3, Number(count) || 3));
      if (room.players.length + n > MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      for (let i = 0; i < n; i++) {
        const botName = BOT_NAMES[room.botCounter % BOT_NAMES.length];
        room.botCounter += 1;
        room.players.push({
          id: `bot_${room.id}_${room.botCounter}`, name: botName, connected: true, socketId: null, isBot: true,
          x: 0, y: 0, dir: { x: 0, y: 0 }, score: 0, burning: null, armed: null, stunnedUntil: 0, nextBurnAt: 0, loadout: emptyLoadout(),
        });
        room.pushLog(`${botName} joined the table.`);
      }
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('nien:buyFirecracker', ({ type, delta }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.adjustLoadout(player, type, Number(delta));
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('nien:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < 1) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.startGame();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.startTicking(nsp);
    });

    socket.on('nien:input', ({ dx, dy }) => {
      const room = myRoom();
      if (!room || room.status !== 'playing') return;
      const player = room.findPlayer(socket.playerId);
      if (!player) return;
      room.setPlayerInput(player, Number(dx) || 0, Number(dy) || 0);
    });

    socket.on('nien:startBurn', ({ type }, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'playing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-playing' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.startBurning(player, type);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('nien:release', ({ x, y }, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'playing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-playing' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.releaseFirecracker(player, Number(x) || 0, Number(y) || 0);
      if (typeof callback === 'function') callback(result.ok ? { ok: true } : result);
      if (result.ok) {
        room.broadcast(nsp);
        room.broadcastEvent(nsp, 'nien:boom', result.explosion);
      }
    });

    socket.on('nien:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'finished') { if (typeof callback === 'function') callback({ ok: false, error: 'not-finished' }); return; }
      room.status = 'waiting';
      room.winnerId = null;
      room.resultText = null;
      room.monster = null;
      room.loot = [];
      room.log = [];
      room.pushLog('Ready for another chase — click Start when everyone is in.');
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    function handleLeave() {
      const room = myRoom();
      if (!room) return;
      const player = room.findPlayer(socket.playerId);
      if (player) {
        if (room.status === 'waiting') {
          room.players = room.players.filter((p) => p.id !== socket.playerId);
          room.pushLog(`${player.name} left the room.`);
        } else if (player.socketId === socket.id) {
          player.connected = false;
          player.dir = { x: 0, y: 0 };
          room.pushLog(`${player.name} disconnected.`);
        }
        room.broadcast(nsp);
      }
      deleteRoomIfEmpty(room);
      broadcastRoomList();
      socket.roomId = null;
    }

    socket.on('nien:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachNien;
// Exposed purely for automated testing of the game-logic pieces without
// needing a live socket server.
module.exports.NienRoom = NienRoom;
module.exports.computeMapSize = computeMapSize;
module.exports.computeLootBudget = computeLootBudget;
module.exports.FEAR_MILESTONES = FEAR_MILESTONES;
module.exports.FIRECRACKER_RANGE = FIRECRACKER_RANGE;
module.exports.FIRECRACKER_TYPES = FIRECRACKER_TYPES;
module.exports.FIRECRACKER_KEYS = FIRECRACKER_KEYS;
module.exports.SELF_DETONATE_STUN_MS = SELF_DETONATE_STUN_MS;
module.exports.DEFAULT_LOADOUT_BUDGET = DEFAULT_LOADOUT_BUDGET;
module.exports.LOADOUT_BUDGET_OPTIONS = LOADOUT_BUDGET_OPTIONS;
module.exports.totalLoadoutCost = totalLoadoutCost;
module.exports.autoFillLoadout = autoFillLoadout;
module.exports.PLAYER_SPEED = PLAYER_SPEED;
module.exports.PICKUP_RADIUS = PICKUP_RADIUS;
module.exports.TICK_MS = TICK_MS;
module.exports.LOOT_TYPES = LOOT_TYPES;
