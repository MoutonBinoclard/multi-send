const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
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

// Load channels.json (unified config)
let channelsConfig = {};
try {
  const data = fs.readFileSync("channels.json", "utf8");
  channelsConfig = JSON.parse(data);
} catch (err) {
  console.error("Error reading channels.json:", err);
  channelsConfig = {};
}

// Storage for active polls and button clicks
const activePolls = new Map(); // pollId -> { messageData, clickedUsers: Set, sentMessages: Map(channelId -> message) }
let pollCounter = 0;

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("matchid")
    .setDescription("Send a message to all configured match channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName("no_ping")
        .setDescription("Don't ping roles, show role names instead")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send a message to all configured announce channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName("no_ping")
        .setDescription("Don't ping roles, show role names instead")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Send a message to all configured start channels across all servers")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The message to send")
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName("no_ping")
        .setDescription("Don't ping roles, show role names instead")
        .setRequired(false)
    )
  ,
  new SlashCommandBuilder()
    .setName("channels")
    .setDescription("List all announce, start, and match id channels and their pinged roles"),
  new SlashCommandBuilder()
    .setName("users")
    .setDescription("List all authorized users"),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Send an interactive question with a button to all announce channels")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("The question/message to send")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("button_text")
        .setDescription("The text for the button")
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName("no_ping")
        .setDescription("Don't ping roles, show role names instead")
        .setRequired(false)
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
  if (interaction.isChatInputCommand()) {
    if (!allowedUserIds.includes(interaction.user.id)) {
      return interaction.reply({ content: "❌ You are not authorized to use this command.", ephemeral: true });
    }
  }

  // Handle button interactions
  if (interaction.isButton()) {
    const customId = interaction.customId;
    
    // Handle "Show who clicked" button
    if (customId.startsWith('show_')) {
      const pollId = customId.replace('show_', '');
      const poll = activePolls.get(pollId);
      
      if (!poll) {
        return interaction.reply({ content: "❌ This poll is no longer active.", ephemeral: true });
      }

      if (poll.clickedUsers.size === 0) {
        return interaction.reply({ content: "No one has clicked yet.", ephemeral: true });
      }

      // Get usernames of clicked users
      const userMentions = Array.from(poll.clickedUsers).map(userId => `<@${userId}>`);
      const userList = userMentions.join('\n');
      
      return interaction.reply({ 
        content: `**Users who clicked:**\n${userList}`, 
        ephemeral: true 
      });
    }

    // Handle main poll button
    const pollId = customId;
    const poll = activePolls.get(pollId);
    
    if (!poll) {
      return interaction.reply({ content: "❌ This poll is no longer active.", ephemeral: true });
    }

    const userId = interaction.user.id;
    
    // Check if user already clicked
    if (poll.clickedUsers.has(userId)) {
      return interaction.reply({ content: "❌ You have already responded to this poll.", ephemeral: true });
    }

    // Add user to clicked list
    poll.clickedUsers.add(userId);
    
    // Update all messages across all servers
    const clickCount = poll.clickedUsers.size;
    const newMainButton = new ButtonBuilder()
      .setCustomId(pollId)
      .setLabel(poll.messageData.buttonText)
      .setStyle(ButtonStyle.Primary);
    
    const newShowButton = new ButtonBuilder()
      .setCustomId(`show_${pollId}`)
      .setLabel("Show who clicked")
      .setStyle(ButtonStyle.Secondary);
    
    const newRow = new ActionRowBuilder().addComponents(newMainButton, newShowButton);

      // No longer need to read announce.json, use channelsConfig if needed

    // Update all sent messages with proper ping/role format
    for (const [channelId, message] of poll.sentMessages) {
      try {
        // Find the guild and channel config for this message
        let guild;
        let channelConfig;
        for (const [guildId, channels] of Object.entries(announceConfig)) {
          const ch = channels.find(c => c.id === channelId);
          if (ch) {
            guild = await client.guilds.fetch(guildId);
            channelConfig = ch;
            break;
          }
        }

        // Reconstruct the content with ping/role info
        const fromLine = `-# _from <@${poll.senderId}>_`;
        let newContent;

        if (poll.noPing && channelConfig?.ping && channelConfig.ping.length > 0 && guild) {
          // Show role names instead of pinging
          const rolePromises = channelConfig.ping.map(async (roleId) => {
            try {
              const role = await guild.roles.fetch(roleId);
              return role ? role.name : `Unknown (${roleId})`;
            } catch {
              return `Unknown (${roleId})`;
            }
          });
          const roleNames = await Promise.all(rolePromises);
          const roleText = `(Ping roles: ${roleNames.join(', ')})`;
          newContent = `${fromLine}\n${roleText}\n${poll.messageData.message}\n(${clickCount} clicked)`;
        } else if (!poll.noPing && channelConfig?.ping && channelConfig.ping.length > 0) {
          // Normal behavior - ping the roles
          let pings = Array.isArray(channelConfig.ping)
            ? channelConfig.ping.map(id => `<@&${id}>`).join(' ')
            : `<@&${channelConfig.ping}>`;
          newContent = `${fromLine}\n${pings}\n${poll.messageData.message}\n(${clickCount} clicked)`;
        } else {
          newContent = `${fromLine}\n${poll.messageData.message}\n(${clickCount} clicked)`;
        }

        await message.edit({ content: newContent, components: [newRow] });
      } catch (err) {
        console.error(`Error updating message in channel ${channelId}:`, err);
      }
    }

    await interaction.reply({ content: "✅ Your response has been recorded!", ephemeral: true });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!allowedUserIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ You are not authorized to use this command.", ephemeral: true });
  }

  // Helper to send to a config file (match-id.json or announce.json)
  async function sendToChannels(configFile, message, withPing = true, interaction, noPing = false) {
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
      let guild;
      try {
        guild = await client.guilds.fetch(guildId);
      } catch {
        continue;
      }

      for (const ch of channels) {
        if (sentChannels.has(ch.id)) continue;
        sentChannels.add(ch.id);
        try {
          const channel = await client.channels.fetch(ch.id);
          if (channel && channel.isTextBased()) {
            let content;
            if (withPing && ch.ping && ch.ping.length > 0 && !noPing) {
              let pings = Array.isArray(ch.ping)
                ? ch.ping.map(id => `<@&${id}>`).join(' ')
                : (ch.ping ? `<@&${ch.ping}>` : '');
              content = `${fromLine}\n${pings}\n${message}`;
            } else if (ch.ping && ch.ping.length > 0 && noPing) {
              // Get role names instead of pinging
              const rolePromises = ch.ping.map(async (roleId) => {
                try {
                  const role = await guild.roles.fetch(roleId);
                  return role ? role.name : `Unknown (${roleId})`;
                } catch {
                  return `Unknown (${roleId})`;
                }
              });
              const roleNames = await Promise.all(rolePromises);
              const roleText = `(Ping roles: ${roleNames.join(', ')})`;
              content = `${fromLine}\n${roleText}\n${message}`;
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
      // Use channelsConfig (channels.json)
      let output = [];
      for (const [guildId, guildConfig] of Object.entries(channelsConfig)) {
        let guild;
        try {
          guild = await client.guilds.fetch(guildId);
        } catch {
          output.push(`- Unknown server (${guildId})`);
          continue;
        }
        const guildName = guild.name || guildId;

        // Helper to get channel/role info
        async function getChannelRole(type, label) {
          const arr = guildConfig[type] || [];
          if (arr.length === 0) return `    - ${label} : None`;
          const ch = arr[0];
          let roleNames = 'None';
          if (ch.ping && ch.ping.length > 0) {
            const rolePromises = ch.ping.map(roleId => getRoleName(guild, roleId));
            const roles = await Promise.all(rolePromises);
            roleNames = roles.join(', ');
          }
          return `    - ${label} : ${roleNames}`;
        }

        // Build lines for this guild
        let lines = [`- ${guildName}`];
        lines.push(await getChannelRole('announce', 'Announce'));
        lines.push(await getChannelRole('start', 'Start'));
        lines.push(await getChannelRole('matchid', 'Match id'));
        output.push(lines.join('\n'));
      }
      const msg = output.join('\n\n');
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

    // /ask command implementation
    if (interaction.commandName === "ask") {
      await interaction.deferReply({ ephemeral: true });
      const message = interaction.options.getString("message");
      const buttonText = interaction.options.getString("button_text");
      const noPing = interaction.options.getBoolean("no_ping") || false;

      // Use channelsConfig for announce channels
      let successCount = 0;
      let errorCount = 0;
      pollCounter++;
      const pollId = `poll_${pollCounter}_${Date.now()}`;
      const pollData = {
        messageData: { message, buttonText },
        clickedUsers: new Set(),
        sentMessages: new Map(),
        noPing: noPing,
        senderId: interaction.user.id
      };
      const mainButton = new ButtonBuilder()
        .setCustomId(pollId)
        .setLabel(buttonText)
        .setStyle(ButtonStyle.Primary);
      const showButton = new ButtonBuilder()
        .setCustomId(`show_${pollId}`)
        .setLabel("Show who clicked")
        .setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder().addComponents(mainButton, showButton);
      const userObj = allowedUsers.find(u => u.id === interaction.user.id);
      const trueName = userObj && userObj.true_name ? userObj.true_name : "unknown";
      const fromLine = `-# _from <@${interaction.user.id}>_`;

      for (const [guildId, guildConfig] of Object.entries(channelsConfig)) {
        const sentChannels = new Set();
        let guild;
        try {
          guild = await client.guilds.fetch(guildId);
        } catch {
          continue;
        }
        const channels = guildConfig.announce || [];
        for (const ch of channels) {
          if (sentChannels.has(ch.id)) continue;
          sentChannels.add(ch.id);
          try {
            const channel = await client.channels.fetch(ch.id);
            if (channel && channel.isTextBased()) {
              let content;
              if (noPing) {
                if (ch.ping && ch.ping.length > 0) {
                  const rolePromises = ch.ping.map(async (roleId) => {
                    try {
                      const role = await guild.roles.fetch(roleId);
                      return role ? role.name : `Unknown (${roleId})`;
                    } catch {
                      return `Unknown (${roleId})`;
                    }
                  });
                  const roleNames = await Promise.all(rolePromises);
                  const roleText = `(Ping roles: ${roleNames.join(', ')})`;
                  content = `${fromLine}\n${roleText}\n${message}\n(0 clicked)`;
                } else {
                  content = `${fromLine}\n${message}\n(0 clicked)`;
                }
              } else {
                if (ch.ping && ch.ping.length > 0) {
                  let pings = Array.isArray(ch.ping)
                    ? ch.ping.map(id => `<@&${id}>`).join(' ')
                    : `<@&${ch.ping}>`;
                  content = `${fromLine}\n${pings}\n${message}\n(0 clicked)`;
                } else {
                  content = `${fromLine}\n${message}\n(0 clicked)`;
                }
              }
              const sentMessage = await channel.send({ content, components: [row] });
              pollData.sentMessages.set(ch.id, sentMessage);
              successCount++;
              await new Promise(r => setTimeout(r, 500));
            }
          } catch (err) {
            console.error(`Error in channel ${ch.id}:`, err);
            errorCount++;
          }
        }
      }
      activePolls.set(pollId, pollData);
      await interaction.editReply({
        content: `Poll sent to ${successCount} channel(s). ${errorCount > 0 ? `${errorCount} error(s) occurred.` : ''}`
      });
      return;
    }

  if (interaction.commandName === "matchid") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    const noPing = interaction.options.getBoolean("no_ping") || false;
    await sendToChannels("matchid.json", message, true, interaction, noPing);
  } else if (interaction.commandName === "announce") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    const noPing = interaction.options.getBoolean("no_ping") || false;
    await sendToChannels("announce.json", message, true, interaction, noPing);
  } else if (interaction.commandName === "start") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString("message");
    const noPing = interaction.options.getBoolean("no_ping") || false;
    await sendToChannels("start.json", message, true, interaction, noPing);
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
