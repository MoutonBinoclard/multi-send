const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const fs = require("fs");

const TOKEN = process.env.TOKEN;       // Ton token vient de Render
const CLIENT_ID = process.env.CLIENT_ID; // ID de ton bot

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Config par serveur ---
let config = {};
if (fs.existsSync("config.json")) {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
}
function saveConfig() {
  fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
}

// --- Commandes slash ---
const commands = [
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("Envoie un message sur les salons configurés")
    .addStringOption(opt => opt.setName("message").setDescription("Le message à envoyer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roles_id_edit")
    .setDescription("Ajoute/modifie les rôles à ping")
    .addStringOption(opt => opt.setName("roles").setDescription("IDs séparés par des virgules").setRequired(true)),

  new SlashCommandBuilder()
    .setName("channel_id_edit")
    .setDescription("Ajoute/modifie les salons cibles")
    .addStringOption(opt => opt.setName("channels").setDescription("IDs séparés par des virgules").setRequired(true)),
].map(cmd => cmd.toJSON());

// --- Déploiement commandes globales ---
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("Déploiement des commandes slash...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Commandes déployées ✅");
  } catch (err) {
    console.error("Erreur déploiement commandes:", err);
  }
})();

// --- Réactions aux commandes ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  if (!config[guildId]) config[guildId] = { channels: [], roles: [] };

  if (interaction.commandName === "send") {
    const msg = interaction.options.getString("message");
    const roles = config[guildId].roles.map(r => `<@&${r}>`).join(" ");
    for (const channelId of config[guildId].channels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          await channel.send(`${roles} ${msg}`);
        }
      } catch (err) {
        console.error(`Erreur en envoyant sur ${channelId}:`, err);
      }
    }
    await interaction.reply({ content: "Message envoyé ✅", ephemeral: true });
  }

  else if (interaction.commandName === "roles_id_edit") {
    const roleList = interaction.options.getString("roles").split(",").map(r => r.trim());
    config[guildId].roles = roleList;
    saveConfig();
    await interaction.reply({ content: `Rôles mis à jour ✅ (${roleList.join(", ")})`, ephemeral: true });
  }

  else if (interaction.commandName === "channel_id_edit") {
    const channelList = interaction.options.getString("channels").split(",").map(c => c.trim());
    config[guildId].channels = channelList;
    saveConfig();
    await interaction.reply({ content: `Salons mis à jour ✅ (${channelList.join(", ")})`, ephemeral: true });
  }
});

client.once("ready", () => {
  console.log(`🤖 Bot multi-send connecté en tant que ${client.user.tag}`);
});

client.login(TOKEN);
