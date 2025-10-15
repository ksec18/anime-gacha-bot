// bot.js (draft + /ygo + /pokemon, 15 min cooldown)
import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, Colors, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Database from 'better-sqlite3';
import { request } from 'undici';

/* =========================
   CONFIG
========================= */
const COOLDOWN_SECONDS = 15 * 60; // 15 minutes

// Raretés : label, poids, couleur, pages AniList (popularité), badge
const RARITIES = [
  { k: 'C',   w: 60, color: Colors.Grey,        pages: [1, 10],   badge: '⬜' },
  { k: 'R',   w: 25, color: Colors.Blue,        pages: [11, 30],  badge: '🟦' },
  { k: 'EP',  w: 10, color: Colors.Purple,      pages: [31, 80],  badge: '🟪' },
  { k: 'LEG', w:  4, color: Colors.Gold,        pages: [81, 150], badge: '🟨' },
  { k: 'MYTH',w:  1, color: Colors.Red,         pages: [151, 300],badge: '🟥' },
];

// Pity system
const PITY_LEG_THRESHOLD  = 30;   // garanti LEG au plus tard
const PITY_MYTH_THRESHOLD = 100;  // garanti MYTH au plus tard

const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $$page, perPage: $$perPage) {
    characters(sort: FAVOURITES_DESC) {
      name { full }
      image { large }
      media(perPage: 1) { nodes { title { romaji english native } } }
    }
  }
}`.replaceAll('$$','');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* =========================
   DATABASE
========================= */
const db = new Database(process.env.DB_PATH || 'gacha.sqlite');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  did TEXT UNIQUE,
  name TEXT,
  pulls INTEGER DEFAULT 0,
  c INTEGER DEFAULT 0,
  r INTEGER DEFAULT 0,
  ep INTEGER DEFAULT 0,
  leg INTEGER DEFAULT 0,
  myth INTEGER DEFAULT 0,
  last_pull_ts REAL DEFAULT 0,
  pity_leg INTEGER DEFAULT 0,
  pity_myth INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  anime TEXT,
  image TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_unique ON cards(name, anime);

CREATE TABLE IF NOT EXISTS ownership (
  user_id INTEGER,
  card_id INTEGER,
  qty INTEGER DEFAULT 0,
  stars INTEGER DEFAULT 1,
  PRIMARY KEY(user_id, card_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  from_id TEXT,
  to_id TEXT,
  give_card_id INTEGER,
  take_card_id INTEGER,
  status TEXT DEFAULT 'PENDING',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS banners (
  name TEXT PRIMARY KEY,
  anime_filter TEXT,
  bonus_percent INTEGER
);
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

const q = {
  // users
  getUserByDid: db.prepare('SELECT * FROM users WHERE did=?'),
  insertUser: db.prepare('INSERT INTO users(did, name) VALUES(?, ?)'),
  updatePullTs: db.prepare('UPDATE users SET last_pull_ts=? WHERE id=?'),
  incStats: db.prepare('UPDATE users SET pulls=pulls+1, c=c+?, r=r+?, ep=ep+?, leg=leg+?, myth=myth+? WHERE id=?'),
  updatePityOnPull: db.prepare('UPDATE users SET pity_leg=?, pity_myth=? WHERE id=?'),

  // cards & ownership
  getCard: db.prepare('SELECT * FROM cards WHERE name=? AND anime=?'),
  insertCard: db.prepare('INSERT INTO cards(name,anime,image) VALUES(?,?,?)'),
  upsertOwnership: db.prepare(`
    INSERT INTO ownership(user_id, card_id, qty, stars) VALUES(?,?,1,1)
    ON CONFLICT(user_id, card_id) DO UPDATE SET qty=qty+1
  `),
  listInventory: db.prepare(`
    SELECT c.name, c.anime, c.image, o.qty, o.stars
    FROM ownership o JOIN cards c ON c.id=o.card_id
    WHERE o.user_id=?
    ORDER BY o.qty DESC, c.name ASC
    LIMIT 20
  `),
  getOwnershipByName: db.prepare(`
    SELECT o.*, c.id AS card_id, c.name, c.anime FROM ownership o
    JOIN cards c ON c.id = o.card_id
    WHERE o.user_id=? AND c.name=?
  `),
  updateOwnership: db.prepare('UPDATE ownership SET qty=?, stars=? WHERE user_id=? AND card_id=?'),
  deleteOwnershipZero: db.prepare('DELETE FROM ownership WHERE qty<=0'),

  // trades
  insertTrade: db.prepare('INSERT INTO trades(id, from_id, to_id, give_card_id, take_card_id, created_at) VALUES(?,?,?,?,?,?)'),
  getTrade: db.prepare('SELECT * FROM trades WHERE id=?'),
  setTradeStatus: db.prepare('UPDATE trades SET status=? WHERE id=?'),

  // banners & state
  upsertBanner: db.prepare(`
    INSERT INTO banners(name, anime_filter, bonus_percent) VALUES(?,?,?)
    ON CONFLICT(name) DO UPDATE SET anime_filter=excluded.anime_filter, bonus_percent=excluded.bonus_percent
  `),
  removeBanner: db.prepare('DELETE FROM banners WHERE name=?'),
  listBanners: db.prepare('SELECT * FROM banners ORDER BY name'),
  setActiveBanner: db.prepare(`INSERT INTO state(k, v) VALUES('active_banner', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`),
  getActiveBanner: db.prepare(`SELECT v FROM state WHERE k='active_banner'`),
  getBannerByName: db.prepare('SELECT * FROM banners WHERE name=?'),

  // autocomplete
  searchCardNames: db.prepare(`SELECT name FROM cards WHERE name LIKE ? ESCAPE '\\' GROUP BY name ORDER BY name LIMIT 25`)
};

/* =========================
   HELPERS
========================= */
function getOrCreateUser(member) {
  let u = q.getUserByDid.get(String(member.id));
  if (!u) {
    q.insertUser.run(String(member.id), member.displayName ?? member.user?.username ?? 'User');
    u = q.getUserByDid.get(String(member.id));
  }
  return u;
}
function canPull(user) {
  return (Date.now()/1000 - user.last_pull_ts) >= COOLDOWN_SECONDS;
}
function touchPull(user) { q.updatePullTs.run(Date.now()/1000, user.id); }

function rollRarity() {
  const total = RARITIES.reduce((s,r)=>s+r.w,0);
  let x = Math.random()*total;
  for (const r of RARITIES) { if ((x-=r.w) <= 0) return r; }
  return RARITIES[0];
}
function rollRarityWithPity(user) {
  if (user.pity_myth >= PITY_MYTH_THRESHOLD - 1) return RARITIES.find(r=>r.k==='MYTH');
  if (user.pity_leg  >= PITY_LEG_THRESHOLD  - 1) return RARITIES.find(r=>r.k==='LEG');
  return rollRarity();
}
function updatePityCounters(user, rarityKey) {
  let { pity_leg, pity_myth } = user;
  if (rarityKey === 'MYTH') { pity_leg = 0; pity_myth = 0; }
  else if (rarityKey === 'LEG') { pity_leg = 0; pity_myth = Math.min(pity_myth + 1, PITY_MYTH_THRESHOLD); }
  else { pity_leg = Math.min(pity_leg + 1, PITY_LEG_THRESHOLD); pity_myth = Math.min(pity_myth + 1, PITY_MYTH_THRESHOLD); }
  q.updatePityOnPull.run(pity_leg, pity_myth, user.id);
  user.pity_leg = pity_leg; user.pity_myth = pity_myth;
}

async function fetchRandomCharacter(pages) {
  const page = Math.floor(Math.random()*(pages[1]-pages[0]+1))+pages[0];
  const body = { query: ANILIST_QUERY, variables: { page, perPage: 50 } };
  const res = await request(ANILIST_URL, { method:'POST', body: JSON.stringify(body), headers: { 'content-type':'application/json' }});
  const data = await res.body.json();
  const list = data?.data?.Page?.characters ?? [];
  if (!list.length) return null;
  const ch = list[Math.floor(Math.random()*list.length)];
  const t = ch.media?.nodes?.[0]?.title ?? {};
  const anime = t.romaji || t.english || t.native || 'Unknown';
  return { name: ch.name.full, image: ch.image.large, anime };
}

function upsertCard(name, anime, image) {
  const found = q.getCard.get(name, anime);
  if (found) return found.id;
  const info = q.insertCard.run(name, anime, image);
  return info.lastInsertRowid;
}

function snowflake() { return String(Date.now()) + Math.floor(Math.random()*1e6); }

/* ===== Draft helpers (anime all) ===== */
async function rollOneCandidate(user, banner) {
  const rarity = rollRarityWithPity(user);
  let char = null;
  let attempts = 0;
  const bias = banner ? { list: banner.anime_filter.split(';').map(s=>s.trim().toLowerCase()), bonus: banner.bonus_percent } : null;

  do {
    char = await fetchRandomCharacter(rarity.pages);
    attempts++;
    if (!bias || !char) break;
    const isMatch = bias.list.some(a => char.anime.toLowerCase().includes(a));
    if (isMatch) break;
    const rerollChance = Math.max(0, Math.min(0.95, (bias.bonus_percent || 0)/100));
    if (Math.random() < rerollChance && attempts < 4) continue; else break;
  } while (attempts < 4);

  return char ? { rarity, char } : null;
}

/* ===== Yu-Gi-Oh! pool & rules ===== */
const YGO_POOL = [
  'Dark Magician','Blue-Eyes White Dragon','Red-Eyes Black Dragon','Summoned Skull',
  'Jinzo','Buster Blader','Celtic Guardian','Gaia the Fierce Knight',
  'Kuriboh','La Jinn the Mystical Genie','Beta The Magnet Warrior','Alpha The Magnet Warrior',
  'Gamma The Magnet Warrior','Harpie Lady','Time Wizard','Relinquished',
  'Obnoxious Celtic Guardian','Axe Raider','Vorcerader','Man-Eater Bug'
];
const YGO_STAT_RULES = {
  C:   { hp:[1200,1800], dmg:[300,600] },
  R:   { hp:[1800,2400], dmg:[600,1000] },
  EP:  { hp:[2400,3000], dmg:[1000,1400] },
  LEG: { hp:[3000,3800], dmg:[1400,1800] },
  MYTH:{ hp:[3800,4500], dmg:[1800,2400] }
};
function randInt(min, max) { return Math.floor(Math.random()*(max-min+1))+min; }
async function rollOneYGOCandidate(user) {
  const rarity = rollRarityWithPity(user);
  const name = YGO_POOL[Math.floor(Math.random()*YGO_POOL.length)];
  const rules = YGO_STAT_RULES[rarity.k];
  const hp = randInt(rules.hp[0], rules.hp[1]);
  const dmg = randInt(rules.dmg[0], rules.dmg[1]);
  return { rarity, char: { name, anime: 'Yu-Gi-Oh!', image: null }, stats: { hp, dmg } };
}

/* ===== Pokémon pool & rules ===== */
// type: 'normal' | 'mega' | 'ex'
// === Pokémon images (sprites officiels ou fanart) ===
// Tu peux mettre les URL des images de ton choix (par ex. Imgur, PokéAPI, etc.)
const POKEMON_IMAGES = {
  'Pikachu': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png',
  'Charizard': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/6.png',
  'Blastoise': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/9.png',
  'Venusaur': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/3.png',
  'Gengar': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/94.png',
  'Lucario': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/448.png',
  'Greninja': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/658.png',
  'Dragonite': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/149.png',
  'Tyranitar': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/248.png',
  'Gardevoir': 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/282.png',

  // Méga-évolutions (ici exemples custom, car PokéAPI n’a pas de sprites Mega)
  'Mega Charizard X': 'https://archives.bulbagarden.net/media/upload/0/05/006Charizard-Mega_X.png',
  'Mega Charizard Y': 'https://archives.bulbagarden.net/media/upload/9/95/006Charizard-Mega_Y.png',
  'Mega Blastoise': 'https://archives.bulbagarden.net/media/upload/0/02/009Blastoise-Mega.png',
  'Mega Venusaur': 'https://archives.bulbagarden.net/media/upload/3/3d/003Venusaur-Mega.png',
  'Mega Gengar': 'https://archives.bulbagarden.net/media/upload/e/e5/094Gengar-Mega.png',
  'Mega Lucario': 'https://archives.bulbagarden.net/media/upload/4/41/448Lucario-Mega.png',
  'Mega Gardevoir': 'https://archives.bulbagarden.net/media/upload/8/87/282Gardevoir-Mega.png',
  'Mega Salamence': 'https://archives.bulbagarden.net/media/upload/0/0a/373Salamence-Mega.png',
  'Mega Metagross': 'https://archives.bulbagarden.net/media/upload/5/5f/376Metagross-Mega.png',
  'Mega Rayquaza': 'https://archives.bulbagarden.net/media/upload/8/8e/384Rayquaza-Mega.png',

  // EX (cartes TCG — exemples)
  'Mewtwo EX': 'https://images.pokemontcg.io/bw3/54_hires.png',
  'Rayquaza EX': 'https://images.pokemontcg.io/xy6/60_hires.png',
  'Groudon EX': 'https://images.pokemontcg.io/xy5/85_hires.png',
  'Kyogre EX': 'https://images.pokemontcg.io/xy5/26_hires.png',
  'Garchomp EX': 'https://images.pokemontcg.io/bw8/45_hires.png',
  'Charizard EX': 'https://images.pokemontcg.io/xy2/12_hires.png'
};

const POKEMON_POOL = [
  { name: 'Pikachu', type: 'normal' },
  { name: 'Charizard', type: 'normal' },
  { name: 'Blastoise', type: 'normal' },
  { name: 'Venusaur', type: 'normal' },
  { name: 'Gengar', type: 'normal' },
  { name: 'Lucario', type: 'normal' },
  { name: 'Greninja', type: 'normal' },
  { name: 'Dragonite', type: 'normal' },
  { name: 'Tyranitar', type: 'normal' },
  { name: 'Gardevoir', type: 'normal' },

  // Mega evolutions
  { name: 'Mega Charizard X', type: 'mega' },
  { name: 'Mega Charizard Y', type: 'mega' },
  { name: 'Mega Blastoise', type: 'mega' },
  { name: 'Mega Venusaur', type: 'mega' },
  { name: 'Mega Gengar', type: 'mega' },
  { name: 'Mega Lucario', type: 'mega' },
  { name: 'Mega Gardevoir', type: 'mega' },
  { name: 'Mega Salamence', type: 'mega' },
  { name: 'Mega Metagross', type: 'mega' },
  { name: 'Mega Rayquaza', type: 'mega' },

  // EX (cartes type TCG style)
  { name: 'Mewtwo EX', type: 'ex' },
  { name: 'Rayquaza EX', type: 'ex' },
  { name: 'Groudon EX', type: 'ex' },
  { name: 'Kyogre EX', type: 'ex' },
  { name: 'Garchomp EX', type: 'ex' },
  { name: 'Charizard EX', type: 'ex' },
];

// Règles de stats par rareté, ajustées pour Pokémon
const PKM_STAT_RULES = {
  C:   { hp:[50,80],   dmg:[10,40] },
  R:   { hp:[80,120],  dmg:[40,80] },
  EP:  { hp:[120,180], dmg:[80,130] },
  LEG: { hp:[180,230], dmg:[130,180] },
  MYTH:{ hp:[230,300], dmg:[180,240] }
};

// Pondération des types par rareté (pour sortir des mega/ex surtout en hautes raretés)
const TYPE_WEIGHT_BY_RARITY = {
  C:   { normal: 1.0, mega: 0.0, ex: 0.0 },
  R:   { normal: 0.95, mega: 0.04, ex: 0.01 },
  EP:  { normal: 0.80, mega: 0.15, ex: 0.05 },
  LEG: { normal: 0.40, mega: 0.40, ex: 0.20 },
  MYTH:{ normal: 0.10, mega: 0.55, ex: 0.35 }
};

function weightedPick(weights) {
  const x = Math.random();
  let acc = 0;
  for (const [k, w] of Object.entries(weights)) {
    acc += w;
    if (x <= acc) return k;
  }
  // fallback
  return Object.keys(weights)[0];
}

async function rollOnePokemonCandidate(user) {
  const rarity = rollRarityWithPity(user);
  const type = weightedPick(TYPE_WEIGHT_BY_RARITY[rarity.k]);
  const pool = POKEMON_POOL.filter(p => p.type === type);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const rules = PKM_STAT_RULES[rarity.k];
  const hp = randInt(rules.hp[0], rules.hp[1]);
  const dmg = randInt(rules.dmg[0], rules.dmg[1]);
  const displayName = pick.name;
const img = POKEMON_IMAGES[displayName] ?? null;
return { rarity, char: { name: displayName, anime: 'Pokémon', image: img }, stats: { hp, dmg }, meta: { type } };
}

/* =========================
   READY
========================= */
client.once('ready', () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

/* =========================
   AUTOCOMPLETE
========================= */
client.on('interactionCreate', async (i) => {
  if (!i.isAutocomplete()) return;
  const focused = i.options.getFocused(true);
  if (['card_name', 'give', 'take'].includes(focused.name)) {
    const query = String(focused.value || '').replace(/[%_\\]/g, m => '\\' + m);
    const like = `%${query}%`;
    const rows = q.searchCardNames.all(like);
    await i.respond(rows.map(r => ({ name: r.name, value: r.name })));
  } else {
    await i.respond([]);
  }
});

/* =========================
   COMMANDES
========================= */
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // /draft : 3 cartes anime, choisir 1
  if (i.commandName === 'draft') {
    const user = getOrCreateUser(i.member);
    if (!canPull(user)) {
      const remaining = Math.ceil(COOLDOWN_SECONDS - (Date.now()/1000 - user.last_pull_ts));
      const min = Math.max(0, Math.floor(remaining/60));
      const sec = Math.max(0, remaining % 60);
      return i.reply({ content:`⏳ Tu dois attendre **${min} min ${sec}s** avant de relancer /draft.`, ephemeral:true });
    }
    touchPull(user);

    const active = q.getActiveBanner.get()?.v ?? null;
    const banner = active ? q.getBannerByName.get(active) : null;

    await i.deferReply();

    const candidates = [];
    for (let k=0;k<3;k++) {
      const cand = await rollOneCandidate(user, banner);
      if (cand) candidates.push(cand);
    }
    if (candidates.length < 3) return i.editReply({ content: '❌ Impossible de générer 3 cartes (AniList indisponible). Réessaie.' });

    const embeds = candidates.map((c, idx) => {
      const emb = new EmbedBuilder()
        .setTitle(`${c.rarity.badge} ${c.rarity.k} • ${c.char.name}`)
        .setDescription(`**Anime :** ${c.char.anime}\nChoisis avec les boutons ci-dessous.`)
        .setImage(c.char.image)
        .setColor(c.rarity.color)
        .setFooter({ text: `Option ${idx+1}` });
      if (banner) emb.setAuthor({ name: `Bannière: ${banner.name} (+${banner.bonus_percent}% focus)` });
      return emb;
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('choose_1').setLabel('1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_2').setLabel('2').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_3').setLabel('3').setStyle(ButtonStyle.Primary),
    );

    const sent = await i.editReply({ embeds, components: [row] });

    try {
      const click = await sent.awaitMessageComponent({
        filter: (btnInt) => btnInt.user.id === i.user.id && ['choose_1','choose_2','choose_3'].includes(btnInt.customId),
        time: 60_000
      });

      const idx = Number(click.customId.split('_')[1]) - 1;
      const chosen = candidates[idx];

      const cardId = upsertCard(chosen.char.name, chosen.char.anime, chosen.char.image);
      q.upsertOwnership.run(user.id, cardId);

      updatePityCounters(user, chosen.rarity.k);
      const statsDelta = { C:0, R:0, EP:0, LEG:0, MYTH:0 };
      statsDelta[chosen.rarity.k] = 1;
      q.incStats.run(statsDelta.C, statsDelta.R, statsDelta.EP, statsDelta.LEG, statsDelta.MYTH, user.id);
      const pityFooter = `Pity LEG: ${user.pity_leg}/${PITY_LEG_THRESHOLD} • Pity MYTH: ${user.pity_myth}/${PITY_MYTH_THRESHOLD}`;

      const result = new EmbedBuilder()
        .setTitle(`✅ Tu as choisi: ${chosen.rarity.badge} ${chosen.rarity.k} • ${chosen.char.name}`)
        .setDescription(`**Anime :** ${chosen.char.anime}`)
        .setImage(chosen.char.image)
        .setColor(chosen.rarity.color)
        .setFooter({ text: pityFooter });

      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_1').setLabel('1').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_2').setLabel('2').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_3').setLabel('3').setStyle(ButtonStyle.Primary).setDisabled(true),
      );

      await click.update({ embeds: [result], components: [disabled] });

    } catch {
      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_1').setLabel('1').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_2').setLabel('2').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_3').setLabel('3').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      await i.editReply({ content: '⏰ Temps écoulé. Relance `/draft` pour recommencer.', components: [disabled] });
    }
  }

  // /ygo : Yu-Gi-Oh!
  else if (i.commandName === 'ygo') {
    const user = getOrCreateUser(i.member);
    if (!canPull(user)) {
      const remaining = Math.ceil(COOLDOWN_SECONDS - (Date.now()/1000 - user.last_pull_ts));
      const min = Math.max(0, Math.floor(remaining/60));
      const sec = Math.max(0, remaining % 60);
      return i.reply({ content:`⏳ Tu dois attendre **${min} min ${sec}s** avant de relancer /ygo.`, ephemeral:true });
    }
    touchPull(user);

    await i.deferReply();

    const candidates = [];
    for (let k=0;k<3;k++) candidates.push(await rollOneYGOCandidate(user));

    const embeds = candidates.map((c, idx) => new EmbedBuilder()
      .setTitle(`${c.rarity.badge} ${c.rarity.k} • ${c.char.name}`)
      .setDescription(`**Série :** ${c.char.anime}\n**PV :** ${c.stats.hp}\n**Dégâts :** ${c.stats.dmg}\n\nChoisis avec les boutons ci-dessous.`)
      .setColor(c.rarity.color)
      .setFooter({ text: `Option ${idx+1}` })
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('choose_ygo_1').setLabel('1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_ygo_2').setLabel('2').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_ygo_3').setLabel('3').setStyle(ButtonStyle.Primary),
    );

    const sent = await i.editReply({ embeds, components: [row] });

    try {
      const click = await sent.awaitMessageComponent({
        filter: (btnInt) => btnInt.user.id === i.user.id && ['choose_ygo_1','choose_ygo_2','choose_ygo_3'].includes(btnInt.customId),
        time: 60_000
      });

      const idx = Number(click.customId.split('_')[2]) - 1;
      const chosen = candidates[idx];

      const cardId = upsertCard(chosen.char.name, chosen.char.anime, chosen.char.image ?? '');
      q.upsertOwnership.run(user.id, cardId);

      updatePityCounters(user, chosen.rarity.k);
      const statsDelta = { C:0, R:0, EP:0, LEG:0, MYTH:0 };
      statsDelta[chosen.rarity.k] = 1;
      q.incStats.run(statsDelta.C, statsDelta.R, statsDelta.EP, statsDelta.LEG, statsDelta.MYTH, user.id);
      const pityFooter = `Pity LEG: ${user.pity_leg}/${PITY_LEG_THRESHOLD} • Pity MYTH: ${user.pity_myth}/${PITY_MYTH_THRESHOLD}`;

      const result = new EmbedBuilder()
        .setTitle(`✅ Tu as choisi: ${chosen.rarity.badge} ${chosen.rarity.k} • ${chosen.char.name}`)
        .setDescription(`**Série :** ${chosen.char.anime}\n**PV :** ${chosen.stats.hp}\n**Dégâts :** ${chosen.stats.dmg}`)
        .setColor(chosen.rarity.color)
        .setFooter({ text: pityFooter });

      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_ygo_1').setLabel('1').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_ygo_2').setLabel('2').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_ygo_3').setLabel('3').setStyle(ButtonStyle.Primary).setDisabled(true),
      );

      await click.update({ embeds: [result], components: [disabled] });

    } catch {
      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_ygo_1').setLabel('1').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_ygo_2').setLabel('2').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_ygo_3').setLabel('3').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      await i.editReply({ content: '⏰ Temps écoulé. Relance `/ygo` pour recommencer.', components: [disabled] });
    }
  }

  // /pokemon : 3 Pokémon (normal / Mega / EX) avec stats
  else if (i.commandName === 'pokemon') {
    const user = getOrCreateUser(i.member);
    if (!canPull(user)) {
      const remaining = Math.ceil(COOLDOWN_SECONDS - (Date.now()/1000 - user.last_pull_ts));
      const min = Math.max(0, Math.floor(remaining/60));
      const sec = Math.max(0, remaining % 60);
      return i.reply({ content:`⏳ Tu dois attendre **${min} min ${sec}s** avant de relancer /pokemon.`, ephemeral:true });
    }
    touchPull(user);

    await i.deferReply();

    const candidates = [];
    for (let k=0;k<3;k++) candidates.push(await rollOnePokemonCandidate(user));

    const embeds = candidates.map((c, idx) => {
      const typeBadge = c.meta.type === 'mega' ? '🌀 Mega' : (c.meta.type === 'ex' ? '✨ EX' : '⬜ Normal');
      return new EmbedBuilder()
        .setTitle(`${c.rarity.badge} ${c.rarity.k} • ${c.char.name}`)
        .setDescription(`**Série :** ${c.char.anime} • **Forme :** ${typeBadge}\n**PV :** ${c.stats.hp}\n**Dégâts :** ${c.stats.dmg}\n\nChoisis avec les boutons ci-dessous.`)
        .setColor(c.rarity.color)
        .setFooter({ text: `Option ${idx+1}` });
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('choose_pkm_1').setLabel('1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_pkm_2').setLabel('2').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_pkm_3').setLabel('3').setStyle(ButtonStyle.Primary),
    );

    const sent = await i.editReply({ embeds, components: [row] });

    try {
      const click = await sent.awaitMessageComponent({
        filter: (btnInt) => btnInt.user.id === i.user.id && ['choose_pkm_1','choose_pkm_2','choose_pkm_3'].includes(btnInt.customId),
        time: 60_000
      });

      const idx = Number(click.customId.split('_')[2]) - 1;
      const chosen = candidates[idx];

      const cardId = upsertCard(chosen.char.name, chosen.char.anime, chosen.char.image ?? '');
      q.upsertOwnership.run(user.id, cardId);

      updatePityCounters(user, chosen.rarity.k);
      const statsDelta = { C:0, R:0, EP:0, LEG:0, MYTH:0 };
      statsDelta[chosen.rarity.k] = 1;
      q.incStats.run(statsDelta.C, statsDelta.R, statsDelta.EP, statsDelta.LEG, statsDelta.MYTH, user.id);
      const pityFooter = `Pity LEG: ${user.pity_leg}/${PITY_LEG_THRESHOLD} • Pity MYTH: ${user.pity_myth}/${PITY_MYTH_THRESHOLD}`;

      const typeBadge = chosen.meta.type === 'mega' ? '🌀 Mega' : (chosen.meta.type === 'ex' ? '✨ EX' : '⬜ Normal');
      const result = new EmbedBuilder()
        .setTitle(`✅ Tu as choisi: ${chosen.rarity.badge} ${chosen.rarity.k} • ${chosen.char.name}`)
        .setDescription(`**Série :** ${chosen.char.anime} • **Forme :** ${typeBadge}\n**PV :** ${chosen.stats.hp}\n**Dégâts :** ${chosen.stats.dmg}`)
        .setColor(chosen.rarity.color)
        .setFooter({ text: pityFooter });

      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_pkm_1').setLabel('1').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_pkm_2').setLabel('2').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_pkm_3').setLabel('3').setStyle(ButtonStyle.Primary).setDisabled(true),
      );

      await click.update({ embeds: [result], components: [disabled] });

    } catch {
      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_pkm_1').setLabel('1').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_pkm_2').setLabel('2').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_pkm_3').setLabel('3').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      await i.editReply({ content: '⏰ Temps écoulé. Relance `/pokemon` pour recommencer.', components: [disabled] });
    }
  }

  // INVENTORY
  else if (i.commandName === 'inventory') {
    const target = i.options.getUser('user') ?? i.user;
    const member = await i.guild.members.fetch(target.id).catch(()=>null);
    const u = getOrCreateUser(member ?? { id: target.id, displayName: target.username });

    const rows = q.listInventory.all(u.id);
    if (!rows.length) return i.reply({ content:`📦 Inventaire vide pour **${member?.displayName ?? target.username}**.`, ephemeral:true });

    const desc = rows.map(r => `**${r.name}** — *${r.anime}* ×${r.qty} ${'⭐'.repeat(r.stars)}`).join('\n');
    const emb = new EmbedBuilder().setTitle(`🗃️ Inventaire de ${member?.displayName ?? target.username} (top 20)`).setDescription(desc).setColor(Colors.Green);
    await i.reply({ embeds:[emb] });
  }

  // STATS
  else if (i.commandName === 'stats') {
    const target = i.options.getUser('user') ?? i.user;
    const member = await i.guild.members.fetch(target.id).catch(()=>null);
    const u = getOrCreateUser(member ?? { id: target.id, displayName: target.username });

    if (u.pulls === 0) return i.reply({ content:'Aucune statistique pour le moment. Lance `/draft`, `/ygo` ou `/pokemon` !', ephemeral:true });
    const emb = new EmbedBuilder()
      .setTitle(`📊 Stats de ${member?.displayName ?? target.username}`)
      .addFields(
        { name:'Total tirages', value:String(u.pulls), inline:false },
        { name:'C', value:String(u.c), inline:true },
        { name:'R', value:String(u.r), inline:true },
        { name:'EP', value:String(u.ep), inline:true },
        { name:'LEG', value:String(u.leg), inline:true },
        { name:'MYTH', value:String(u.myth), inline:true },
      )
      .setColor(Colors.Blurple);
    await i.reply({ embeds:[emb] });
  }

  // MERGE
  else if (i.commandName === 'merge') {
    const cardName = i.options.getString('card_name');
    const u = getOrCreateUser(i.member);
    const own = q.getOwnershipByName.get(u.id, cardName);
    if (!own) return i.reply({ content:`❌ Tu ne possèdes pas **${cardName}**.`, ephemeral:true });
    if (own.qty < 3) return i.reply({ content:`❌ Il faut **3 doublons** pour fusionner. Tu en as ${own.qty}.`, ephemeral:true });
    if (own.stars >= 5) return i.reply({ content:`⭐ Carte déjà au **max (5⭐)**.`, ephemeral:true });

    q.updateOwnership.run(own.qty - 2, own.stars + 1, own.user_id, own.card_id);
    const emb = new EmbedBuilder()
      .setTitle(`✨ Fusion réussie : ${cardName}`)
      .setDescription(`Nouvelle qualité : **${'⭐'.repeat(own.stars+1)}** (consommé 3 doublons)`)
      .setColor(Colors.Orange);
    await i.reply({ embeds:[emb] });
  }

  // TRADE
  else if (i.commandName === 'trade') {
    const sub = i.options.getSubcommand();

    if (sub === 'propose') {
      const to = i.options.getUser('to');
      const give = i.options.getString('give');
      const take = i.options.getString('take');

      const uFrom = getOrCreateUser(i.member);
      const ownGive = q.getOwnershipByName.get(uFrom.id, give);
      if (!ownGive || ownGive.qty < 1) return i.reply({ content:`❌ Tu ne possèdes pas **${give}**.`, ephemeral:true });

      const id = snowflake();
      q.insertTrade.run(id, String(i.user.id), String(to.id), ownGive.card_id, null, Date.now());

      await i.reply({ content:`📨 Échange **${id}** proposé à <@${to.id}> : tu donnes **${give}**, tu demandes **${take}**.\nLe destinataire pourra \`/trade accept trade_id:${id}\` ou tu peux \`/trade cancel trade_id:${id}\`.`, allowedMentions:{ users:[to.id] } });
    }

    if (sub === 'cancel') {
      const id = i.options.getString('trade_id');
      const tr = q.getTrade.get(id);
      if (!tr) return i.reply({ content:'❌ Échange introuvable.', ephemeral:true });
      if (tr.from_id !== String(i.user.id)) return i.reply({ content:'❌ Seul l’initiateur peut annuler.', ephemeral:true });
      if (tr.status !== 'PENDING') return i.reply({ content:`❌ État actuel: ${tr.status}.`, ephemeral:true });
      q.setTradeStatus.run('CANCELED', id);
      await i.reply({ content:`❎ Échange **${id}** annulé.` });
    }

    if (sub === 'accept') {
      const id = i.options.getString('trade_id');
      const tr = q.getTrade.get(id);
      if (!tr) return i.reply({ content:'❌ Échange introuvable.', ephemeral:true });
      if (tr.to_id !== String(i.user.id)) return i.reply({ content:'❌ Tu n’es pas le destinataire.', ephemeral:true });
      if (tr.status !== 'PENDING') return i.reply({ content:`❌ État actuel: ${tr.status}.`, ephemeral:true });

      const fromU = q.getUserByDid.get(tr.from_id);
      const toU   = q.getUserByDid.get(tr.to_id);

      const giveOwn = db.prepare('SELECT * FROM ownership WHERE user_id=? AND card_id=?').get(fromU.id, tr.give_card_id);
      if (!giveOwn || giveOwn.qty < 1) return i.reply({ content:`❌ L’initiateur ne possède plus la carte à donner.`, ephemeral:true });

      const swap = db.transaction(()=>{
        db.prepare('UPDATE ownership SET qty=qty-1 WHERE user_id=? AND card_id=?').run(fromU.id, tr.give_card_id);
        db.prepare(`
          INSERT INTO ownership(user_id,card_id,qty,stars) VALUES(?,?,1,1)
          ON CONFLICT(user_id,card_id) DO UPDATE SET qty=qty+1
        `).run(toU.id, tr.give_card_id);
        q.deleteOwnershipZero.run();
        q.setTradeStatus.run('ACCEPTED', id);
      });
      swap();

      await i.reply({ content:`🤝 Échange **${id}** effectué !` });
    }
  }

  // BANNERS
  else if (i.commandName === 'banner') {
    const sub = i.options.getSubcommand();

    if (sub === 'current') {
      const active = q.getActiveBanner.get()?.v ?? null;
      if (!active) return i.reply({ content:'Aucune bannière active.' });
      const b = q.getBannerByName.get(active);
      if (!b) return i.reply({ content:'Bannière active introuvable (supprimée ?).' });
      const emb = new EmbedBuilder()
        .setTitle(`🎏 Bannière active: ${b.name}`)
        .setDescription(`Focus: ${b.anime_filter}\nBonus: +${b.bonus_percent}%`)
        .setColor(Colors.Fuchsia);
      return i.reply({ embeds:[emb] });
    }

    if (sub === 'list') {
      const rows = q.listBanners.all();
      if (!rows.length) return i.reply({ content:'Aucune bannière enregistrée.' });
      const desc = rows.map(r => `• **${r.name}** — focus: ${r.anime_filter} ( +${r.bonus_percent}% )`).join('\n');
      const emb = new EmbedBuilder().setTitle('📜 Bannières').setDescription(desc).setColor(Colors.Fuchsia);
      return i.reply({ embeds:[emb] });
    }

    const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.member.roles.cache.some(r=>r.name.toLowerCase().includes('admin'));
    if (!isAdmin) return i.reply({ content:'❌ Réservé aux admins.', ephemeral:true });

    if (sub === 'create') {
      const name = i.options.getString('name');
      const filter = i.options.getString('anime_filter');
      const bonus = i.options.getInteger('bonus');
      q.upsertBanner.run(name, filter, bonus);
      return i.reply({ content:`✅ Bannière **${name}** enregistrée : [${filter}] (+${bonus}%).` });
    }
    if (sub === 'set') {
      const name = i.options.getString('name');
      const b = q.getBannerByName.get(name);
      if (!b) return i.reply({ content:'❌ Bannière inconnue.', ephemeral:true });
      q.setActiveBanner.run(name);
      return i.reply({ content:`🎯 Bannière active → **${name}**.` });
    }
    if (sub === 'remove') {
      const name = i.options.getString('name');
      q.removeBanner.run(name);
      const active = q.getActiveBanner.get()?.v ?? null;
      if (active === name) q.setActiveBanner.run(null);
      return i.reply({ content:`🗑️ Bannière **${name}** supprimée.` });
    }
  }

  // ADMIN
  else if (i.commandName === 'admin') {
    const sub = i.options.getSubcommand();
    const ADMIN_ID = process.env.ADMIN_ID;
    if (i.user.id !== ADMIN_ID)
      return i.reply({ content: '❌ Tu n’as pas les droits admin.', ephemeral: true });

    if (sub === 'reset-db') {
      db.exec(`
        DELETE FROM users;
        DELETE FROM cards;
        DELETE FROM ownership;
        DELETE FROM trades;
        DELETE FROM banners;
        DELETE FROM state;
      `);
      return i.reply({ content: '⚠️ Base de données complètement réinitialisée !' });
    }

    if (sub === 'stats') {
      const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      const cardCount = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
      const ownCount = db.prepare('SELECT COUNT(*) AS n FROM ownership').get().n;
      const emb = new EmbedBuilder()
        .setTitle('📊 Stats globales')
        .addFields(
          { name: 'Utilisateurs', value: String(userCount), inline: true },
          { name: 'Cartes uniques', value: String(cardCount), inline: true },
          { name: 'Possessions totales', value: String(ownCount), inline: true }
        )
        .setColor(Colors.Gold);
      return i.reply({ embeds: [emb] });
    }

    if (sub === 'give') {
      const target = i.options.getUser('user');
      const cardName = i.options.getString('card');
      const qty = i.options.getInteger('qty');
      const member = await i.guild.members.fetch(target.id).catch(() => null);
      const u = getOrCreateUser(member ?? { id: target.id, displayName: target.username });
      const card = q.getCard.get(cardName, '') || q.getCard.get(cardName, 'Unknown');
      if (!card) return i.reply({ content: `❌ Carte inconnue (${cardName}).`, ephemeral: true });
      q.upsertOwnership.run(u.id, card.id);
      q.updateOwnership.run(qty, 1, u.id, card.id);
      return i.reply({ content: `🎁 Donné **${qty}× ${cardName}** à **${target.username}**.` });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
