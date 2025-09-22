const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const fs = require("fs");
const http = require("http");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Load allowed users from config
let allowedUsers = [];
try {
  const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
  allowedUsers = config.allowedUsers || [];
} catch (err) {
  console.error("Error reading config.json:", err);
}

// Load channels.json
let channelsConfig = {};
try {
  const data = fs.readFileSync("channels.json", "utf8");
  channelsConfig = JSON.parse(data);
} catch (err) {
  console.error("Error reading channels.json:", err);
  channelsConfig = {};
}

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("Send a message to all configured channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("no-ping")
    .setDescription("Send a message to all configured channels without pinging any roles")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

// Deploy commands (optional)
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("Deploying slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Commands deployed ✅");
  } catch (err) {
    console.error("Error deploying commands:", err);
  }
})();

// Interaction handling
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!allowedUsers.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ You are not authorized to use this command.", ephemeral: true });
  }

  if (interaction.commandName === "send" || interaction.commandName === "no-ping") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    let successCount = 0;
    let errorCount = 0;

    for (const [guildId, channels] of Object.entries(channelsConfig)) {
      const sentChannels = new Set();

      for (const ch of channels) {
        if (sentChannels.has(ch.id)) continue;
        sentChannels.add(ch.id);

        try {
          const channel = await client.channels.fetch(ch.id);
          if (channel && channel.isTextBased()) {
            let content;
            if (interaction.commandName === "send") {
              const ping = ch.ping ? `<@&${ch.ping}> ` : "";
              content = `${ping}${message}`;
            } else {
              content = message;
            }
            await channel.send(content);
            successCount++;
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (err) {
          console.error(`Error in channel ${ch.id}:`, err);
          errorCount++;
        }
      }
    }

    await interaction.editReply({ 
      content: `Message sent to ${successCount} channel(s). ${errorCount > 0 ? `${errorCount} error(s) occurred.` : ''}`
    });
  }
});

client.once("ready", () => {
  console.log(`🤖 Multi-send bot connected as ${client.user.tag}`);
});

// HTTP server for hosting platforms
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Multi-send bot is running!\n");
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

client.login(TOKEN);
