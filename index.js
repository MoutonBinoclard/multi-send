const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const fs = require("fs");
const http = require("http");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Load allowed users from config
let allowedUsers = [];
let allowedUserIds = [];
try {
  const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
  allowedUsers = config.allowedUsers || [];
  allowedUserIds = allowedUsers.map(u => u.id);
} catch (err) {
  console.error("Error reading config.json:", err);
}

// Load match-id.json
let channelsConfig = {};
try {
  const data = fs.readFileSync("matchid.json", "utf8");
  channelsConfig = JSON.parse(data);
} catch (err) {
  console.error("Error reading matchid.json:", err);
  channelsConfig = {};
}

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("matchid")
    .setDescription("Send a message to all configured match channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("no-ping")
    .setDescription("Send a message to all configured match channels without pinging any roles")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send a message to all configured announce channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Send a message to all configured start channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    )
  ,
  new SlashCommandBuilder()
    .setName("channels")
    .setDescription("List all announce, start, and match id channels and their pinged roles"),
  new SlashCommandBuilder()
    .setName("users")
    .setDescription("List all authorized users")
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

  if (!allowedUserIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ You are not authorized to use this command.", ephemeral: true });
  }

  // Helper to send to a config file (match-id.json or announce.json)
  async function sendToChannels(configFile, message, withPing = true, interaction) {
    let configData = {};
    try {
      const data = fs.readFileSync(configFile, "utf8");
      configData = JSON.parse(data);
    } catch (err) {
      console.error(`Error reading ${configFile}:`, err);
      return interaction.editReply({ content: `❌ Error reading ${configFile}` });
    }

    let successCount = 0;
    let errorCount = 0;
    const userObj = allowedUsers.find(u => u.id === interaction.user.id);
    const trueName = userObj && userObj.true_name ? userObj.true_name : "unknown";
    const fromLine = `-# _from <@${interaction.user.id}>_`;

    for (const [guildId, channels] of Object.entries(configData)) {
      const sentChannels = new Set();
      for (const ch of channels) {
        if (sentChannels.has(ch.id)) continue;
        sentChannels.add(ch.id);
        try {
          const channel = await client.channels.fetch(ch.id);
          if (channel && channel.isTextBased()) {
            let content;
            if (withPing && ch.ping) {
              let pings = Array.isArray(ch.ping)
                ? ch.ping.map(id => `<@&${id}>`).join(' ')
                : (ch.ping ? `<@&${ch.ping}>` : '');
              content = `${fromLine}\n${pings}\n${message}`;
            } else {
              content = `${fromLine}\n${message}`;
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

  // Helper to get role name from guild and role id
  async function getRoleName(guild, roleId) {
    if (!roleId) return 'None';
    try {
      const role = await guild.roles.fetch(roleId);
      return role ? role.name : `Unknown (${roleId})`;
    } catch {
      return `Unknown (${roleId})`;
    }
  }

  // /channels command implementation
  if (interaction.commandName === "channels") {
    await interaction.deferReply({ ephemeral: true });
    // Read all config files
    let announce, start, matchid;
    try {
      announce = JSON.parse(fs.readFileSync("announce.json", "utf8"));
      start = JSON.parse(fs.readFileSync("start.json", "utf8"));
      matchid = JSON.parse(fs.readFileSync("matchid.json", "utf8"));
    } catch (err) {
      return interaction.editReply({ content: "❌ Error reading config files." });
    }

    // Collect all guild IDs
    const allGuildIds = new Set([
      ...Object.keys(announce),
      ...Object.keys(start),
      ...Object.keys(matchid)
    ]);

    let output = [];
    for (const guildId of allGuildIds) {
      let guild;
      try {
        guild = await client.guilds.fetch(guildId);
      } catch {
        output.push(`- Unknown server (${guildId})`);
        continue;
      }
      const guildName = guild.name;

      // Helper to get channel/role info
      async function getChannelRole(config, label) {
        if (!config[guildId] || config[guildId].length === 0) return `    - ${label} : None`;
        const ch = config[guildId][0];
        let roleNames = 'None';
        if (ch.ping && ch.ping.length > 0) {
          // Get all role names if multiple
          const rolePromises = ch.ping.map(roleId => getRoleName(guild, roleId));
          const roles = await Promise.all(rolePromises);
          roleNames = roles.join(', ');
        }
        return `    - ${label} : ${roleNames}`;
      }

      // Build lines for this guild
      let lines = [`- ${guildName}`];
      lines.push(await getChannelRole(announce, 'Announce'));
      lines.push(await getChannelRole(start, 'Start'));
      lines.push(await getChannelRole(matchid, 'Match id'));
      output.push(lines.join('\n'));
    }
    const msg = output.join('\n\n');
    // Send as a temp message (ephemeral, can be rejected by closing)
    await interaction.editReply({ content: msg });
    return;
  }

  // /users command implementation
  if (interaction.commandName === "users") {
    await interaction.deferReply({ ephemeral: true });
    const userList = allowedUsers.map(user => `- <@${user.id}>`).join('\n');
    await interaction.editReply({ content: userList });
    return;
  }

  if (interaction.commandName === "matchid") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    await sendToChannels("matchid.json", message, true, interaction);
  } else if (interaction.commandName === "no-ping") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    await sendToChannels("matchid.json", message, false, interaction);
  } else if (interaction.commandName === "announce") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    await sendToChannels("announce.json", message, true, interaction);
  } else if (interaction.commandName === "start") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    await sendToChannels("start.json", message, true, interaction);
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
