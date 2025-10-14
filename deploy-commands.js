// deploy-commands.js (draft-only)
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  // DRAFT replaces PULL
  new SlashCommandBuilder()
    .setName('draft')
    .setDescription('Tirage 3 cartes, choisis-en 1'),

  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Voir un inventaire')
    .addUserOption(o => o.setName('user').setDescription('Utilisateur (optionnel)')),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Voir des stats')
    .addUserOption(o => o.setName('user').setDescription('Utilisateur (optionnel)')),

  new SlashCommandBuilder()
    .setName('merge')
    .setDescription('Fusionner 3 doublons pour +1⭐')
    .addStringOption(o => o.setName('card_name').setDescription('Nom exact de la carte à fusionner').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Échanger des cartes')
    .addSubcommand(sc => sc.setName('propose').setDescription('Proposer un échange')
      .addUserOption(o => o.setName('to').setDescription('Destinataire').setRequired(true))
      .addStringOption(o => o.setName('give').setDescription('Carte que TU donnes').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('take').setDescription('Carte que TU demandes').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sc => sc.setName('accept').setDescription('Accepter un échange')
      .addStringOption(o => o.setName('trade_id').setDescription('ID de l’échange').setRequired(true)))
    .addSubcommand(sc => sc.setName('cancel').setDescription('Annuler un échange')
      .addStringOption(o => o.setName('trade_id').setDescription('ID de l’échange').setRequired(true))),

  new SlashCommandBuilder()
    .setName('banner')
    .setDescription('Gérer la bannière limitée')
    .addSubcommand(sc => sc.setName('current').setDescription('Voir la bannière active'))
    .addSubcommand(sc => sc.setName('list').setDescription('Lister les bannières'))
    .addSubcommand(sc => sc.setName('set').setDescription('Activer une bannière')
      .addStringOption(o => o.setName('name').setDescription('Nom de la bannière').setRequired(true)))
    .addSubcommand(sc => sc.setName('create').setDescription('Créer/maj une bannière')
      .addStringOption(o => o.setName('name').setDescription('Nom').setRequired(true))
      .addStringOption(o => o.setName('anime_filter').setDescription('Liste d’animes séparés par ;').setRequired(true))
      .addIntegerOption(o => o.setName('bonus').setDescription('Bonus %').setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Supprimer une bannière')
      .addStringOption(o => o.setName('name').setDescription('Nom').setRequired(true))),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Commandes admin du bot')
    .addSubcommand(sc => sc.setName('reset-db').setDescription('Réinitialiser complètement la base'))
    .addSubcommand(sc => sc.setName('stats').setDescription('Voir les stats du bot'))
    .addSubcommand(sc => sc.setName('give').setDescription('Donner une carte à un utilisateur')
      .addUserOption(o => o.setName('user').setDescription('Utilisateur cible').setRequired(true))
      .addStringOption(o => o.setName('card').setDescription('Nom exact de la carte').setRequired(true))
      .addIntegerOption(o => o.setName('qty').setDescription('Quantité').setRequired(true).setMinValue(1)))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

console.log('✅ Slash commands déployées (mode guild, draft-only).');
