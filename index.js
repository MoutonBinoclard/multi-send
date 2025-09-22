const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const http = require("http"); // fake server for Render

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Load channels.json ---
let channelsConfig = {};
try {
  const data = fs.readFileSync("channels.json", "utf8");
  channelsConfig = JSON.parse(data);
} catch (err) {
  console.error("Erreur lecture channels.json:", err);
  channelsConfig = {};
}

// --- Commands ---
const commands = [
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("Envoie un message sur tous les salons configurés")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("Le message à envoyer")
        .setRequired(true)
    )
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
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;
  if (!channelsConfig[guildId]) {
    return interaction.reply({ content: "Aucun salon configuré", ephemeral: true });
  }

  if (interaction.commandName === "send") {
    const message = interaction.options.getString("message");
    const guildChannels = channelsConfig[guildId];

    for (const ch of guildChannels) {
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
});

client.once("ready", () => {
  console.log(`🤖 Bot multi-send connecté en tant que ${client.user.tag}`);
});

// --- Fake HTTP server for Render ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot multi-send is running!\n");
}).listen(PORT, () => {
  console.log(`Fake HTTP server listening on port ${PORT}`);
});

client.login(TOKEN);
