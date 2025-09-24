const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
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

// Storage for active polls
const activePolls = new Map();
let pollCounter = 0;

// Helper functions for persistent poll storage
function loadPolls() {
  try {
    const data = fs.readFileSync("polls.json", "utf8");
    const pollsData = JSON.parse(data);
    
    // Convert clickedUsers arrays back to Sets and restore polls
    for (const [pollId, pollData] of Object.entries(pollsData.polls || {})) {
      pollData.clickedUsers = new Set(pollData.clickedUsers || []);
      activePolls.set(pollId, pollData);
    }
    
    // Restore poll counter
    pollCounter = pollsData.pollCounter || 0;
    
    console.log(`Loaded ${activePolls.size} active polls from storage`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error("Error loading polls.json:", err);
    }
    // File doesn't exist or is corrupted, start fresh
    activePolls.clear();
    pollCounter = 0;
  }
}

function savePolls() {
  try {
    const pollsToSave = {};
    
    // Convert Sets to arrays for JSON serialization
    for (const [pollId, pollData] of activePolls.entries()) {
      pollsToSave[pollId] = {
        ...pollData,
        clickedUsers: Array.from(pollData.clickedUsers)
      };
    }
    
    const data = {
      polls: pollsToSave,
      pollCounter: pollCounter
    };
    
    fs.writeFileSync("polls.json", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving polls.json:", err);
  }
}

function cleanupOldPolls() {
  const now = Date.now();
  const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000); // 7 days in milliseconds
  let removedCount = 0;
  
  for (const [pollId, pollData] of activePolls.entries()) {
    // Extract timestamp from pollId (format: poll_${counter}_${timestamp})
    const parts = pollId.split('_');
    if (parts.length >= 3) {
      const timestamp = parseInt(parts[2]);
      if (timestamp < oneWeekAgo) {
        activePolls.delete(pollId);
        removedCount++;
      }
    }
  }
  
  if (removedCount > 0) {
    console.log(`Cleaned up ${removedCount} old polls`);
    savePolls();
  }
}

// Slash commands
const commands = [
  new SlashCommandBuilder().setName("matchid").setDescription("Share a match-id to play scrims").addStringOption(o=>o.setName("message").setDescription("The message to send").setRequired(true)).addBooleanOption(o=>o.setName("no_ping").setDescription("Don't ping roles, show role names instead")),
  new SlashCommandBuilder().setName("announce").setDescription("Make an annoucement. No code here").addStringOption(o=>o.setName("message").setDescription("The message to send").setRequired(true)).addBooleanOption(o=>o.setName("no_ping").setDescription("Don't ping roles, show role names instead")),
  new SlashCommandBuilder().setName("start").setDescription("Use this command to send the first match-id").addStringOption(o=>o.setName("message").setDescription("The message to send").setRequired(true)).addBooleanOption(o=>o.setName("no_ping").setDescription("Don't ping roles, show role names instead")),
  new SlashCommandBuilder().setName("users").setDescription("Show all the users that can send messages with this bot"),
  new SlashCommandBuilder().setName("ask").setDescription("Send a question with a button. For instance who is interested").addStringOption(o=>o.setName("message").setDescription("The question/message to send").setRequired(true)).addStringOption(o=>o.setName("button_text").setDescription("The text for the button").setRequired(true)).addBooleanOption(o=>o.setName("no_ping").setDescription("Don't ping roles, show role names instead")),
  new SlashCommandBuilder().setName("channels").setDescription("Test all the configured channels and roles across all servers"),
  new SlashCommandBuilder().setName("set").setDescription("Send the current channel and the role to ping to Mouton Binoclard, to sync your server").addRoleOption(o=>o.setName("role").setDescription("The role to ping").setRequired(true))
].map(c=>c.toJSON());

const rest = new (require("discord.js").REST)({ version: "10" }).setToken(TOKEN);
(async () => { try { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands }); console.log("Slash commands deployed"); } catch (e) { console.error("Deploy error:", e); } })();

// Interaction handling
client.on("interactionCreate", async (interaction) => {
  // Buttons first
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith("show_")) {
      const pollId = customId.slice(5);
      const poll = activePolls.get(pollId);
      if (!poll) return interaction.reply({ content: "❌ This poll is no longer active.", ephemeral: true });
      const ids = Array.from(poll.clickedUsers);
      if (!ids.length) return interaction.reply({ content: "No one has clicked yet.", ephemeral: true });
      const display = ids.map(id => `<@${id}>`).join("\n");
      return interaction.reply({ content: `Who clicked (${ids.length}):\n${display}`.slice(0,1900), ephemeral: true });
    }
    const poll = activePolls.get(customId);
    if (!poll) return interaction.reply({ content: "❌ This poll is no longer active.", ephemeral: true });
    const userId = interaction.user.id;
    if (poll.clickedUsers.has(userId)) return interaction.reply({ content: "❌ You have already responded to this poll.", ephemeral: true });
    poll.clickedUsers.add(userId);
    const clickCount = poll.clickedUsers.size;

    // Save the updated poll data
    savePolls();

    const mainButton = new ButtonBuilder().setCustomId(customId).setLabel(poll.messageData.buttonText).setStyle(ButtonStyle.Primary);
    const showButton = new ButtonBuilder().setCustomId(`show_${customId}`).setLabel("Show who clicked").setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(mainButton, showButton);
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

    for (const ref of poll.messageRefs || []) {
      try {
        const channel = await client.channels.fetch(ref.channelId);
        if (!channel || !channel.isTextBased()) continue;
        const msg = await channel.messages.fetch(ref.messageId).catch(()=>null);
        if (!msg) continue;
        const fromLine = `-# _from <@${poll.senderId}>_`;
        let content;
        if (poll.noPing) {
          let roleText = '';
          const guild = msg.guild || null;
          if (guild && ref.ping && ref.ping.length) {
            const names = [];
            for (const rid of ref.ping) { try { const role = await guild.roles.fetch(rid); names.push(role ? role.name : `Unknown (${rid})`); } catch { names.push(`Unknown (${rid})`); } }
            if (names.length) roleText = `(Ping roles: ${names.join(', ')})\n`;
          }
          content = `${fromLine}\n${roleText}${poll.messageData.message}\n(${clickCount} clicked)`;
        } else {
          const pings = (ref.ping || []).map(id => `<@&${id}>`).join(' ');
          content = `${fromLine}\n${pings ? pings+'\n' : ''}${poll.messageData.message}\n(${clickCount} clicked)`;
        }
        await msg.edit({ content, components: [row], allowedMentions: { parse: [] } });
        await wait(120);
      } catch (e) {
        console.error(`Edit failed for message ${ref.messageId}:`, e);
      }
    }
    return interaction.reply({ content: "✅ Your response has been recorded!", ephemeral: true });
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;
  
  // Allow certain commands for everyone, check authorization for messaging commands
  const publicCommands = ["set", "channels", "users"];
  if (!publicCommands.includes(interaction.commandName) && !allowedUserIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ You are not authorized to use this command.", ephemeral: true });
  }

  async function sendToChannelType(channelType, message, noPing = false) {
    let successCount = 0, errorCount = 0;
    const fromLine = `-# _from <@${interaction.user.id}>_`;
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
    for (const [guildId, cfg] of Object.entries(channelsConfig)) {
      const entries = cfg[channelType] || [];
      const seen = new Set();
      let guild = null; try { guild = await client.guilds.fetch(guildId); } catch {}
      for (const ch of entries) {
        if (seen.has(ch.id)) continue; seen.add(ch.id);
        try {
          const channel = await client.channels.fetch(ch.id);
          if (!channel || !channel.isTextBased()) continue;
          let content = '';
          if (noPing) {
            let roleText = '';
            if (guild && ch.ping && ch.ping.length) {
              const names = [];
              for (const rid of ch.ping) { try { const role = await guild.roles.fetch(rid); names.push(role ? role.name : `Unknown (${rid})`); } catch { names.push(`Unknown (${rid})`); } }
              if (names.length) roleText = `(Ping roles: ${names.join(', ')})\n`;
            }
            content = `${fromLine}\n${roleText}${message}`;
          } else {
            const pings = (ch.ping || []).map(id => `<@&${id}>`).join(' ');
            content = `${fromLine}\n${pings ? pings+'\n' : ''}${message}`;
          }
          await channel.send({ content, allowedMentions: noPing ? { parse: [] } : { roles: ch.ping || [] } });
          successCount++; await wait(120);
        } catch (e) { console.error(`Send failed for channel ${ch.id}:`, e); errorCount++; }
      }
    }
    return { successCount, errorCount };
  }

  if (interaction.commandName === "users") {
    await interaction.deferReply({ ephemeral: true });
    const userList = allowedUsers.map(u=>`- <@${u.id}>`).join('\n') || 'None';
    await interaction.editReply({ content: userList });
    return;
  }

  if (interaction.commandName === "set") {
    await interaction.deferReply({ ephemeral: true });
    
    const role = interaction.options.getRole('role');
    const serverId = interaction.guildId;
    const channelId = interaction.channelId;
    const roleId = role.id;
    
    try {
      // Get logging configuration
      const loggingConfig = channelsConfig.LOGGING_CONFIG;
      if (!loggingConfig) {
        await interaction.editReply({ content: 'Logging channel not configured' });
        return;
      }
      
      // Fetch server and channel information
      const guild = await client.guilds.fetch(serverId);
      const currentChannel = await client.channels.fetch(channelId);
      const loggingChannel = await client.channels.fetch(loggingConfig.channel_id);
      
      // Format the message
      const message = `**SET Command Info:**
-# _from <@${interaction.user.id}>_
      
**Server:** ${guild.name}
**Server ID:** ${serverId}

**Channel:** #${currentChannel.name}
**Channel ID:** ${channelId}

**Role:** @${role.name}
**Role ID:** ${roleId}`;
      
      // Send to logging channel
      await loggingChannel.send({ content: message });
      
      await interaction.editReply({ content: 'info sent' });
    } catch (error) {
      console.error('Error in set command:', error);
      await interaction.editReply({ content: 'Error sending info' });
    }
    return;
  }

  if (interaction.commandName === "ask") {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString('message');
    const buttonText = interaction.options.getString('button_text');
    const noPing = interaction.options.getBoolean('no_ping') || false;

    let successCount = 0, errorCount = 0;
    pollCounter++; const pollId = `poll_${pollCounter}_${Date.now()}`;
    const pollData = { messageData: { message, buttonText }, clickedUsers: new Set(), messageRefs: [], noPing, senderId: interaction.user.id };

    const mainButton = new ButtonBuilder().setCustomId(pollId).setLabel(buttonText).setStyle(ButtonStyle.Primary);
    const showButton = new ButtonBuilder().setCustomId(`show_${pollId}`).setLabel("Show who clicked").setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(mainButton, showButton);
    const fromLine = `-# _from <@${interaction.user.id}>_`;
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

    for (const [guildId, cfg] of Object.entries(channelsConfig)) {
      const announce = cfg.announce || [];
      const seen = new Set();
      let guild = null; try { guild = await client.guilds.fetch(guildId); } catch {}
      for (const ch of announce) {
        if (seen.has(ch.id)) continue; seen.add(ch.id);
        try {
          const channel = await client.channels.fetch(ch.id);
          if (!channel || !channel.isTextBased()) continue;
          let content = '';
          if (noPing) {
            let roleText = '';
            if (guild && ch.ping && ch.ping.length) {
              const names = [];
              for (const rid of ch.ping) { try { const role = await guild.roles.fetch(rid); names.push(role ? role.name : `Unknown (${rid})`); } catch { names.push(`Unknown (${rid})`); } }
              if (names.length) roleText = `(Ping roles: ${names.join(', ')})\n`;
            }
            content = `${fromLine}\n${roleText}${message}\n(0 clicked)`;
          } else {
            const pings = (ch.ping || []).map(id => `<@&${id}>`).join(' ');
            content = `${fromLine}\n${pings ? pings+'\n' : ''}${message}\n(0 clicked)`;
          }
          const sent = await channel.send({ content, components: [row], allowedMentions: noPing ? { parse: [] } : { roles: ch.ping || [] } });
          pollData.messageRefs.push({ guildId, channelId: ch.id, messageId: sent.id, ping: ch.ping || [] });
          successCount++; await wait(120);
        } catch (e) { console.error(`Send failed for channel ${ch.id}:`, e); errorCount++; }
      }
    }
    activePolls.set(pollId, pollData);
    
    // Save the new poll data
    savePolls();
    
    await interaction.editReply({ content: `Poll sent to ${successCount} channel(s). ${errorCount ? `${errorCount} error(s) occurred.` : ''}` });
    return;
  }

  if (interaction.commandName === "channels") {
    await interaction.deferReply({ ephemeral: true });
    const blocks = [];
    
    for (const [guildId, cfg] of Object.entries(channelsConfig)) {
      const serverName = cfg.nom_serv || guildId;
      
      // Helper function to check channel and role access
      const checkChannelAccess = async (channels, channelType, guild) => {
        if (!channels || channels.length === 0) return `- ${channelType}:\n     - No channels configured`;
        
        const results = [];
        for (const c of channels) {
          try {
            // Check channel access and permissions
            const channel = await client.channels.fetch(c.id);
            let channelStatus = "";
            let channelStatusText = "";
            let channelName = "";
            
            if (!channel) {
              channelName = c.id;
              channelStatus = "❌";
              channelStatusText = "not accessible";
            } else {
              channelName = channel.name;
              
              // Check if bot can view the channel
              const canView = channel.permissionsFor(client.user)?.has("ViewChannel") ?? false;
              if (!canView) {
                channelStatus = "❌";
                channelStatusText = "no access";
              } else {
                // Check if bot can send messages
                const canSend = channel.permissionsFor(client.user)?.has("SendMessages") ?? false;
                if (canSend) {
                  channelStatus = "✅";
                  channelStatusText = "read+write";
                } else {
                  channelStatus = "🟡";
                  channelStatusText = "read only";
                }
              }
            }
            
            // Check role status
            let roleStatus = "✅";
            let roleStatusText = "all good";
            let roleNames = [];
            
            if (c.ping && c.ping.length > 0) {
              let hasRedIssue = false;
              let hasYellowIssue = false;
              
              for (const roleId of c.ping) {
                try {
                  const role = guild ? guild.roles.cache.get(roleId) : null;
                  if (!role) {
                    roleNames.push(`@${roleId} (not found)`);
                    hasRedIssue = true;
                  } else {
                    // Check if role is mentionable by the bot
                    const canMention = role.mentionable || 
                                     guild.members.me?.permissions.has("MentionEveryone") || 
                                     guild.members.me?.roles.highest.comparePositionTo(role) > 0;
                    
                    if (!canMention) {
                      roleNames.push(`@${role.name} (can't ping)`);
                      hasYellowIssue = true;
                    } else {
                      roleNames.push(`@${role.name}`);
                    }
                  }
                } catch (err) {
                  roleNames.push(`@${roleId} (error)`);
                  hasRedIssue = true;
                }
              }
              
              // Priority: red overrides yellow
              if (hasRedIssue) {
                roleStatus = "❌";
                roleStatusText = "role(s) don't exist";
              } else if (hasYellowIssue) {
                roleStatus = "🟡";
                roleStatusText = "can't ping role(s)";
              }
            } else {
              roleNames = ["none"];
            }
            
            results.push(`     - ${channelStatus} (${channelStatusText}) / #${channelName}`);
            results.push(`     - ${roleStatus} (${roleStatusText}) / ${roleNames.join(', ')}`);
          } catch (err) {
            results.push(`     - ❌ (error fetching) / #${c.id}`);
            results.push(`     - ❌ (unchecked) / ${c.ping?.length ? c.ping.map(id => `@${id}`).join(', ') : 'none'}`);
          }
        }
        return `- ${channelType}:\n${results.join('\n')}`;
      };
      
      try {
        // Try to fetch the guild
        let guild = null;
        let serverStatus = "❌";
        let realServerName = serverName; // fallback to config name
        
        try {
          guild = await client.guilds.fetch(guildId);
          serverStatus = "✅";
          realServerName = guild.name; // use actual Discord server name
        } catch (err) {
          serverStatus = "❌";
          // keep the config name as fallback
        }
        
        const announceInfo = await checkChannelAccess(cfg.announce, "Announce", guild);
        const startInfo = await checkChannelAccess(cfg.start, "Start", guild);
        const matchIdInfo = await checkChannelAccess(cfg.matchid, "Match ID", guild);
        
        blocks.push(`### ${realServerName} (${serverStatus})\n${announceInfo}\n${startInfo}\n${matchIdInfo}`);
      } catch (err) {
        console.error(`Error processing guild ${guildId}:`, err);
        blocks.push(`### ${serverName} (❌)`);
      }
    }
    
    const content = blocks.join('\n\n') || 'No servers configured.';
    
    // Discord has a 2000 character limit for messages, so we might need to split
    if (content.length > 2000) {
      await interaction.editReply({ content: content.substring(0, 1997) + "..." });
    } else {
      await interaction.editReply({ content: content });
    }
    return;
  }

  if (["matchid","announce","start"].includes(interaction.commandName)) {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.getString('message');
    const noPing = interaction.options.getBoolean('no_ping') || false;
    const { successCount, errorCount } = await sendToChannelType(interaction.commandName, message, noPing);
    await interaction.editReply({ content: `Message sent to ${successCount} channel(s). ${errorCount ? `${errorCount} error(s) occurred.` : ''}` });
    return;
  }
});

client.once("ready", () => {
  console.log(`🤖 Multi-send bot connected as ${client.user.tag}`);
  
  // Load existing polls from storage
  loadPolls();
  
  // Clean up old polls
  cleanupOldPolls();
  
  // Set up periodic cleanup (every 24 hours)
  setInterval(cleanupOldPolls, 24 * 60 * 60 * 1000);
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
