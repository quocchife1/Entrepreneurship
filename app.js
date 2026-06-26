/* ============================================================================
   Blue Ocean — global state + game logic over Firebase Realtime Database.

   Vanilla ES6+, no bundler. Loaded as <script defer> on every surface AFTER the
   Firebase compat SDKs, so the global `firebase` object already exists.

   Surfaces talk to the game ONLY through `window.BlueOcean`:
     · BlueOcean.store  → raw read/write/subscribe (any surface)
     · BlueOcean.admin  → host-only state transitions & scoring
     · BlueOcean.team   → team-only actions (choose market, place bid)

   DATABASE SCHEMA
     state: { currentPhase, currentQuestion, activeMarket, winner, outcome,
              suddenDeathTeams: [idA, idB] }
     teams: { team1: { name, score, choice, bidAmount, timestamp }, … team4 }
   ========================================================================== */

"use strict";

/* 1 ── Firebase config ───────────────────────────────────────────────────────
   TODO(chi): paste your project config here. `databaseURL` is required for RTDB. */
const firebaseConfig = {
  apiKey: "AIzaSyB1Ro80kcqN0aslYjE_GoyX83rsQ6afmr0",
  authDomain: "khoinghiep-195e5.firebaseapp.com",
  databaseURL: "https://khoinghiep-195e5-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "khoinghiep-195e5",
  storageBucket: "khoinghiep-195e5.firebasestorage.app",
  messagingSenderId: "798906263634",
  appId: "1:798906263634:web:557b317293fb93130f178b",
  measurementId: "G-4V539HF2X4",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* 2 ── Constants ──────────────────────────────────────────────────────────────*/

/** Game lifecycle. The host drives transitions; clients + projector only react. */
const PHASES = Object.freeze({
  LOBBY: "PHASE_0", // chờ các đội kết nối
  ACCUMULATION: "PHASE_1", // tích luỹ điểm (quiz / thảo luận)
  BLUE_OCEAN: "PHASE_2", // chọn thị trường
  PHASE_3_CHECK: "PHASE_3_CHECK", // đánh giá: Top1 == Top2 ? → sudden death : victory
  SUDDEN_DEATH: "PHASE_3", // đấu giá mù giữa 2 đội dẫn đầu
  VICTORY: "PHASE_4", // công bố nhà vô địch
});

/** Four fixed teams. Colors are solid Tailwind classes (flat — no gradients). */
const TEAM_IDS = Object.freeze(["team1", "team2", "team3", "team4"]);
const TEAM_META = Object.freeze({
  team1: { label: "ĐỘI 1", bg: "bg-blue-600", text: "text-blue-400" },
  team2: { label: "ĐỘI 2", bg: "bg-emerald-600", text: "text-emerald-400" },
  team3: { label: "ĐỘI 3", bg: "bg-amber-500", text: "text-amber-400" },
  team4: { label: "ĐỘI 4", bg: "bg-rose-600", text: "text-rose-400" },
});

/** Blue Ocean markets — editable. `value` = reward when a team is ALONE in it.
   Rule: alone → full value (blue ocean); contested → value split equally (red ocean). */
const MARKETS = Object.freeze({
  A: { name: "THỊ TRƯỜNG A", value: 100 },
  B: { name: "THỊ TRƯỜNG B", value: 70 },
  C: { name: "THỊ TRƯỜNG C", value: 40 },
  D: { name: "THỊ TRƯỜNG D", value: 20 },
});

/* 3 ── Pure helpers ─────────────────────────────────────────────────────────*/

/** Teams object → array `[{ id, name, score, … }]` sorted by score (desc),
    id ascending as a stable secondary key. Missing scores count as 0. */
function rankTeams(teams) {
  return TEAM_IDS.filter((id) => teams && teams[id])
    .map((id) => ({ id, ...teams[id], score: Number(teams[id].score) || 0 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Group "vi-VN" number formatting for big money values. */
function formatNumber(value) {
  return new Intl.NumberFormat("vi-VN").format(Number(value) || 0);
}

/* 4 ── GameStore — raw IO + subscriptions ──────────────────────────────────────
   The single place that touches RTDB ref paths. Everything is async/await. */
class GameStore {
  constructor(database) {
    this.db = database;
    this.rootRef = database.ref("/");
    this.stateRef = database.ref("state");
    this.teamsRef = database.ref("teams");
  }

  /* ── Reads ── */
  async getState() {
    const snap = await this.stateRef.get();
    return snap.val() || {};
  }

  async getTeams() {
    const snap = await this.teamsRef.get();
    return snap.val() || {};
  }

  async getTeam(teamId) {
    const snap = await this.teamsRef.child(teamId).get();
    return snap.val() || null;
  }

  /* ── Writes ── */
  async patchState(patch) {
    return this.stateRef.update(patch);
  }

  async patchTeam(teamId, patch) {
    return this.teamsRef.child(teamId).update(patch);
  }

  /** Fresh game: lobby phase + four blank, unclaimed teams. `session` is a new
      token every reset — connected clients compare it and, when it changes, drop
      back to the team-selection screen (names become editable again). */
  async resetGame() {
    const teams = {};
    for (const id of TEAM_IDS) {
      teams[id] = {
        name: TEAM_META[id].label, // default label until a player claims + renames
        score: 0,
        choice: null,
        bidAmount: null,
        timestamp: null,
        answer: null,
        quizResult: null,
        ready: false, // no player has claimed this slot
        online: false, // nobody connected on it
        log: null, // wallet history
      };
    }
    return this.rootRef.update({
      state: {
        currentPhase: PHASES.LOBBY,
        currentQuestion: 0,
        activeMarket: null,
        winner: null,
        outcome: null,
        suddenDeathTeams: null,
        locked: false, // admin-controlled input lock (players can't tap when true)
        session: firebase.database.ServerValue.TIMESTAMP,
      },
      teams,
    });
  }

  /* ── Subscriptions (live UI) ── */
  onState(cb) {
    this.stateRef.on("value", (snap) => cb(snap.val() || {}));
  }

  onTeams(cb) {
    this.teamsRef.on("value", (snap) => cb(snap.val() || {}));
  }

  detach() {
    this.stateRef.off();
    this.teamsRef.off();
  }
}

/* 5 ── TeamController — team-only actions ──────────────────────────────────────*/
class TeamController {
  constructor(store) {
    this.store = store;
  }

  /**
   * Claim a team slot. Keeps any existing score/answer/choice intact (so a player
   * who accidentally closed the tab rejoins WITHOUT losing data), sets the name,
   * marks the slot online, and registers an onDisconnect that flips `online` back
   * to false the instant their connection drops — freeing the slot for re-entry.
   */
  async join(teamId, name) {
    if (!TEAM_IDS.includes(teamId)) throw new Error(`Unknown team: ${teamId}`);
    const onlineRef = this.store.teamsRef.child(teamId).child('online');
    await onlineRef.onDisconnect().set(false);
    return this.store.patchTeam(teamId, {
      name: name || TEAM_META[teamId].label,
      ready: true,
      online: true,
    });
  }

  /** Explicit leave (rarely needed — onDisconnect covers tab close). */
  async leave(teamId) {
    if (!TEAM_IDS.includes(teamId)) return;
    await this.store.teamsRef.child(teamId).child('online').onDisconnect().cancel();
    return this.store.patchTeam(teamId, { online: false });
  }

  /** PHASE_2: pick a Blue Ocean market. */
  async chooseMarket(teamId, marketId) {
    if (!TEAM_IDS.includes(teamId)) throw new Error(`Unknown team: ${teamId}`);
    if (!MARKETS[marketId]) throw new Error(`Unknown market: ${marketId}`);
    return this.store.patchTeam(teamId, { choice: marketId });
  }

  /** PHASE_3: blind bid. Stamps a server timestamp used as the final tie-breaker. */
  async placeBid(teamId, amount) {
    if (!TEAM_IDS.includes(teamId)) throw new Error(`Unknown team: ${teamId}`);
    return this.store.patchTeam(teamId, {
      bidAmount: Number(amount),
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    });
  }
}

/* 6 ── AdminController — host-only state transitions + scoring ──────────────────*/
class AdminController {
  constructor(store) {
    this.store = store;
  }

  /** Move the game to an explicit phase. Clears stale per-round inputs so a
      re-entered round always starts clean. */
  async changePhase(phase) {
    if (!Object.values(PHASES).includes(phase)) {
      throw new Error(`Unknown phase: ${phase}`);
    }

    if (phase === PHASES.BLUE_OCEAN) {
      const clear = {};
      TEAM_IDS.forEach((id) => {
        clear[`${id}/choice`] = null;
      });
      await this.store.teamsRef.update(clear);
    }

    if (phase === PHASES.SUDDEN_DEATH) {
      const clear = {};
      TEAM_IDS.forEach((id) => {
        clear[`${id}/bidAmount`] = null;
        clear[`${id}/timestamp`] = null;
      });
      await this.store.teamsRef.update(clear);
    }

    // Each new phase starts UNLOCKED — the host re-locks during the phase if needed.
    return this.store.patchState({ currentPhase: phase, locked: false });
  }

  /** Lock / unlock player input (quiz, market, bid). Host-controlled — players
      cannot dismiss it; used to stop accidental taps during the presentation. */
  async setLock(locked) {
    return this.store.patchState({ locked: !!locked });
  }

  /** Add (or subtract, with a negative `amount`) points atomically, and append a
      timestamped entry to the team's wallet history (shown live on their phone). */
  async updateScore(teamId, amount, note = 'Điều chỉnh') {
    if (!TEAM_IDS.includes(teamId)) throw new Error(`Unknown team: ${teamId}`);
    const delta = Number(amount);
    const ref = this.store.teamsRef.child(teamId).child('score');
    const result = await ref.transaction((current) => (Number(current) || 0) + delta);
    if (delta !== 0) {
      await this.store.teamsRef.child(teamId).child('log').push({
        amount: delta,
        note,
        at: firebase.database.ServerValue.TIMESTAMP,
      });
    }
    return result.snapshot.val();
  }

  /**
   * PHASE_2 → PHASE_3_CHECK. Applies Blue Ocean market rewards, then evaluates
   * the top two:
   *   · alone in a market   → full market value
   *   · contested market    → value split equally (floor)
   *   · Top1 score == Top2  → SUDDEN_DEATH between them
   *   · otherwise           → VICTORY for Top1
   *
   * @returns {Promise<{tie:boolean, ranked:Array, contenders?:string[], winner?:string}>}
   */
  async calculateBlueOceanResult() {
    const teams = await this.store.getTeams();

    // Group team ids by the market they chose.
    const byMarket = {};
    for (const id of TEAM_IDS) {
      const choice = teams[id] ? teams[id].choice : null;
      if (!choice) continue;
      if (!byMarket[choice]) byMarket[choice] = [];
      byMarket[choice].push(id);
    }

    // Apply rewards (kept in `teams` locally too, so ranking below sees fresh scores).
    const updates = {};
    for (const market of Object.keys(byMarket)) {
      const ids = byMarket[market];
      const value = MARKETS[market] ? MARKETS[market].value : 0;
      const reward = ids.length === 1 ? value : Math.floor(value / ids.length);
      const note = ids.length === 1
        ? `${MARKETS[market].name} · độc chiếm`
        : `${MARKETS[market].name} · chia ${ids.length}`;
      for (const id of ids) {
        const next = (Number(teams[id].score) || 0) + reward;
        updates[`${id}/score`] = next;
        updates[`${id}/log/${this.store.teamsRef.child(id).child('log').push().key}`] = {
          amount: reward,
          note,
          at: firebase.database.ServerValue.TIMESTAMP,
        };
        teams[id].score = next;
      }
    }
    if (Object.keys(updates).length) {
      await this.store.teamsRef.update(updates);
    }

    // PHASE_3_CHECK — compare the two highest scores.
    const ranked = rankTeams(teams);
    const first = ranked[0];
    const second = ranked[1];

    if (first && second && first.score === second.score) {
      // Tie at the top → sudden death. Start the blind round with cleared bids.
      await this.store.teamsRef.update({
        [`${first.id}/bidAmount`]: null,
        [`${first.id}/timestamp`]: null,
        [`${second.id}/bidAmount`]: null,
        [`${second.id}/timestamp`]: null,
      });
      await this.store.patchState({
        currentPhase: PHASES.SUDDEN_DEATH,
        suddenDeathTeams: [first.id, second.id],
        winner: null,
        outcome: null,
      });
      return { tie: true, contenders: [first.id, second.id], ranked };
    }

    await this.store.patchState({
      currentPhase: PHASES.VICTORY,
      winner: first ? first.id : null,
      outcome: "CLEAR_WINNER",
    });
    return { tie: false, winner: first ? first.id : null, ranked };
  }

  /**
   * PHASE_3 → PHASE_4. Resolves the blind bid between the two sudden-death teams.
   * Tie-breaker chain (as specified):
   *   1. Different bids        → higher bid wins.
   *   2. Equal bids            → BOTH contenders' scores drop to 0, and the team
   *                              currently in 3rd place becomes the winner.
   *   3. Strict tie persists   → (no clear 3rd place) decide between the two
   *                              contenders by earliest bid `timestamp`.
   *
   * @returns {Promise<{winnerId:string, outcome:string}>}
   */
  async resolveSuddenDeath() {
    const [state, teams] = await Promise.all([
      this.store.getState(),
      this.store.getTeams(),
    ]);

    const contenders =
      Array.isArray(state.suddenDeathTeams) &&
      state.suddenDeathTeams.length === 2
        ? state.suddenDeathTeams
        : rankTeams(teams)
            .slice(0, 2)
            .map((t) => t.id);

    const [idA, idB] = contenders;
    const teamA = teams[idA];
    const teamB = teams[idB];
    if (!teamA || !teamB) throw new Error("Sudden-death contenders not found.");

    const bidA = Number(teamA.bidAmount);
    const bidB = Number(teamB.bidAmount);
    if (
      teamA.bidAmount == null ||
      teamB.bidAmount == null ||
      Number.isNaN(bidA) ||
      Number.isNaN(bidB)
    ) {
      throw new Error("Both contenders must place a bid before resolving.");
    }

    let winnerId;
    let outcome;

    if (bidA !== bidB) {
      // 1. Higher bid wins outright.
      winnerId = bidA > bidB ? idA : idB;
      outcome = "HIGHER_BID";
    } else {
      // 2. Equal bids → both contenders bust to 0.
      await this.store.teamsRef.update({
        [`${idA}/score`]: 0,
        [`${idB}/score`]: 0,
      });
      teams[idA].score = 0;
      teams[idB].score = 0;

      // 3rd place = highest score among the remaining (non-contender) teams.
      const others = rankTeams(teams).filter(
        (t) => t.id !== idA && t.id !== idB,
      );
      const hasClearThird =
        others.length >= 1 &&
        (others.length === 1 || others[0].score !== others[1].score);

      if (hasClearThird) {
        winnerId = others[0].id;
        outcome = "EQUAL_BID_THIRD_PLACE";
      } else {
        // 3. Strict tie persists → earliest locked bid wins (decisiveness).
        winnerId =
          (Number(teamA.timestamp) || 0) <= (Number(teamB.timestamp) || 0)
            ? idA
            : idB;
        outcome = "EQUAL_BID_TIMESTAMP";
      }
    }

    await this.store.patchState({
      currentPhase: PHASES.VICTORY,
      winner: winnerId,
      outcome,
    });
    return { winnerId, outcome };
  }

  /**
   * PHASE_1 reveal. Ranks the teams that answered by their answer `timestamp`
   * (fastest first) and awards 30 / 20 / 10 / 5. If `correctKey` (A/B/C/D) is
   * given, ONLY teams that answered correctly are ranked & rewarded; the rest get
   * 0. Either way every team that answered gets a `quizResult` so their phone can
   * flash a correct / wrong animation. `correctKey = null` → everyone who answered
   * counts as correct, ranked purely by speed.
   *
   * @returns {Promise<{rewarded:string[], correctKey:?string}>}
   */
  async revealQuiz(correctKey = null) {
    const teams = await this.store.getTeams();
    const answered = TEAM_IDS.filter(
      (id) => teams[id] && teams[id].answer != null && teams[id].timestamp != null,
    );

    // Teams eligible for points, fastest first.
    const eligible = answered
      .filter((id) => !correctKey || teams[id].answer === correctKey)
      .sort((a, b) => Number(teams[a].timestamp) - Number(teams[b].timestamp));

    const points = [30, 20, 10, 5];

    // Award points + wallet log (updateScore handles both).
    for (let i = 0; i < eligible.length; i += 1) {
      const pts = points[i] || 0;
      if (pts > 0) await this.updateScore(eligible[i], pts, 'Kết quả đúng');
    }

    // Flag every answering team so their screen can react (✓ / ✗ + points), and
    // clear their answer/timestamp so the NEXT question starts fresh (the player's
    // phone re-opens the answer buttons once the result animation finishes).
    const results = {};
    const now = firebase.database.ServerValue.TIMESTAMP;
    for (const id of answered) {
      const isCorrect = correctKey ? teams[id].answer === correctKey : true;
      const rank = eligible.indexOf(id);
      results[`${id}/quizResult`] = {
        correct: isCorrect,
        points: isCorrect && rank > -1 ? (points[rank] || 0) : 0,
        at: now,
      };
      results[`${id}/answer`] = null;
      results[`${id}/timestamp`] = null;
      // Wrong answers earn nothing, so they get no updateScore log — push a
      // history line here so the player still sees "Kết quả sai".
      if (!isCorrect) {
        const k = this.store.teamsRef.child(id).child('log').push().key;
        results[`${id}/log/${k}`] = { amount: 0, note: 'Kết quả sai', at: now };
      }
    }
    if (Object.keys(results).length) await this.store.teamsRef.update(results);

    return { rewarded: eligible, correctKey };
  }
}

/** Format a RTDB millisecond timestamp as Vietnam (GMT+7) wall-clock time. */
function formatTimeVN(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(Number(ms)));
}

/* 7 ── Public API ─────────────────────────────────────────────────────────────*/
const store = new GameStore(db);
const admin = new AdminController(store);
const team = new TeamController(store);

window.BlueOcean = {
  // data + helpers
  db,
  PHASES,
  TEAM_IDS,
  TEAM_META,
  MARKETS,
  rankTeams,
  formatNumber,
  formatTimeVN,
  // controllers
  store,
  admin,
  team,
};
