const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const fs = require("fs");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Load config ---
let config = {};
if (fs.existsSync("config.json")) {
  try {
    const data = fs.readFileSync("config.json", "utf8");
    config = data ? JSON.parse(data) : {};
  } catch (err) {
    console.error("Erreur lecture config.json:", err);
    config = {};
  }
}
function saveConfig() {
  fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
}

// --- Commands ---
const commands = [
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("Envoie un message sur tous les salons configurés")
    .addStringOption(opt => opt.setName("message").setDescription("Le message à envoyer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("edit")
    .setDescription("Ajouter / Modifier / Supprimer un salon et définir un ping par salon")
].map(cmd => cmd.toJSON());

// --- Deploy commands ---
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

// --- Interaction ---
client.on("interactionCreate", async (interaction) => {
  const guildId = interaction.guildId;
  if (!config[guildId]) config[guildId] = { channels: [] };

  // --- Commandes slash ---
  if (interaction.isChatInputCommand()) {

    // --- SEND ---
    if (interaction.commandName === "send") {
      const message = interaction.options.getString("message");
      const guildConfig = config[guildId];
      if (!guildConfig.channels.length) return interaction.reply({ content: "Aucun salon configuré", ephemeral: true });

      for (const ch of guildConfig.channels) {
        try {
          const channel = await client.channels.fetch(ch.id);
          if (channel && channel.isTextBased()) {
            const ping = ch.ping ? `<@&${ch.ping}> ` : "";
            await channel.send(`${ping}${message}`);
          }
        } catch (err) {
          console.error(`Erreur sur le salon ${ch.id}:`, err);
        }
      }
      await interaction.reply({ content: "Message envoyé ✅", ephemeral: true });
    }

    // --- EDIT ---
    else if (interaction.commandName === "edit") {
      const modal = new ModalBuilder()
        .setCustomId("edit_modal")
        .setTitle("Modifier salons et ping")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("channels_input")
              .setLabel("Salons et ping (ex: 123456:987654 pour ping, 111111 pour sans ping, -222222 pour supprimer)")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          )
        );
      await interaction.showModal(modal);
    }
  }

  // --- Modal submit ---
  else if (interaction.isModalSubmit()) {
    if (interaction.customId === "edit_modal") {
      const value = interaction.fields.getTextInputValue("channels_input").trim();
      const oldChannels = config[guildId].channels || [];

      if (value) {
        const items = value.split(",");
        for (const item of items) {
          const clean = item.trim();
          if (!clean) continue;

          // Supprimer salon si - devant
          if (clean.startsWith("-")) {
            const idToRemove = clean.slice(1);
            const index = oldChannels.findIndex(c => c.id === idToRemove);
            if (index !== -1) oldChannels.splice(index, 1);
            continue;
          }

          // Ajouter ou modifier salon
          const [id, ping] = clean.split(":").map(s => s.trim());
          const existing = oldChannels.find(c => c.id === id);
          if (existing) existing.ping = ping || null;
          else oldChannels.push({ id, ping: ping || null });
        }
      }

      config[guildId].channels = oldChannels;
      saveConfig();
      await interaction.reply({ content: "Configuration mise à jour ✅", ephemeral: true });
    }
  }
});

client.once("ready", () => {
  console.log(`🤖 Bot multi-send connecté en tant que ${client.user.tag}`);
});

client.login(TOKEN);
