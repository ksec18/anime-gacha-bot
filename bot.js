// bot.js (draft-only, 15 min cooldown)
import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, Colors, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Database from 'better-sqlite3';
import { request } from 'undici';

/* =========================
   CONFIG
========================= */
const COOLDOWN_SECONDS = 15 * 60; // 15 minutes
const MAX_PULLS_ONCE = 10; // not used by draft, kept for future compatibility

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
  Page(page: $page, perPage: $perPage) {
    characters(sort: FAVOURITES_DESC) {
      name { full }
      image { large }
      media(perPage: 1) { nodes { title { romaji english native } } }
    }
  }
}`;

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
  updateUserName: db.prepare('UPDATE users SET name=? WHERE did=?'),
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
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

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

function rarityEmbed(char, rarity, owner, stars=1, pityState='') {
  const title = `${rarity.badge} ${rarity.k} • ${char.name} ${'⭐'.repeat(stars)}`;
  const emb = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**Anime :** ${char.anime}`)
    .setImage(char.image)
    .setColor(rarity.color)
    .setFooter({ text: pityState || `Gagné par ${owner.displayName ?? owner.user?.username}` });
  return emb;
}

function snowflake() { return String(Date.now()) + Math.floor(Math.random()*1e6); }

// Tire UNE carte candidate selon rareté + bannière (sans persister)
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
   COMMANDES (DRAFT-ONLY)
========================= */
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // /draft : tire 3 cartes et laisse choisir 1 via boutons
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

    // Tire 3 candidats
    const candidates = [];
    for (let k=0;k<3;k++) {
      const cand = await rollOneCandidate(user, banner);
      if (cand) candidates.push(cand);
      await new Promise(r=>setTimeout(r,120));
    }
    if (candidates.length < 3) {
      return i.editReply({ content: '❌ Impossible de générer 3 cartes (AniList indisponible). Réessaie.' });
    }

    // 3 embeds (non sauvegardés)
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

    // Boutons 1 / 2 / 3
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('choose_1').setLabel('1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_2').setLabel('2').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('choose_3').setLabel('3').setStyle(ButtonStyle.Primary),
    );

    const sent = await i.editReply({ embeds, components: [row] });

    // Attente du clic par l'auteur (60s)
    try {
      const click = await sent.awaitMessageComponent({
        filter: (btnInt) => btnInt.user.id === i.user.id && ['choose_1','choose_2','choose_3'].includes(btnInt.customId),
        time: 60_000
      });

      const idx = Number(click.customId.split('_')[1]) - 1;
      const chosen = candidates[idx];

      // Maintenant seulement on PERSISTE la carte choisie
      const cardId = upsertCard(chosen.char.name, chosen.char.anime, chosen.char.image);
      q.upsertOwnership.run(user.id, cardId);

      // Mise à jour pity + stats pour la SEULE carte choisie
      updatePityCounters(user, chosen.rarity.k);
      const pityFooter = `Pity LEG: ${user.pity_leg}/${PITY_LEG_THRESHOLD} • Pity MYTH: ${user.pity_myth}/${PITY_MYTH_THRESHOLD}`;
      const statsDelta = { C:0, R:0, EP:0, LEG:0, MYTH:0 };
      statsDelta[chosen.rarity.k] = 1;
      q.incStats.run(statsDelta.C, statsDelta.R, statsDelta.EP, statsDelta.LEG, statsDelta.MYTH, user.id);

      // Affichage résultat + désactivation boutons
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

    } catch (e) {
      // Timeout: on retire les boutons
      const disabled = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('choose_1').setLabel('1').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_2').setLabel('2').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('choose_3').setLabel('3').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      await i.editReply({ content: '⏰ Temps écoulé. Relance `/draft` pour recommencer.', components: [disabled] });
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

    if (u.pulls === 0) return i.reply({ content:'Aucune statistique pour le moment. Lance `/draft` !', ephemeral:true });
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

    // consomme 3 unités → -2 qty, +1 star
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

  // ADMIN (si tu as ajouté /admin dans deploy-commands.js)
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
