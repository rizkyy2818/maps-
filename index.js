/* =====================================================================
   KYRIEL STATUS BOT — Discord website monitoring bot
   ===================================================================== */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client, GatewayIntentBits, Partials,
  REST, Routes,
  SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder,
  ActivityType
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE   = path.join(__dirname, 'data.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID   = process.env.DISCORD_CLIENT_ID;
const GUILD_ID    = process.env.DISCORD_GUILD_ID;
const CHECK_MS    = parseInt(process.env.CHECK_INTERVAL_MS || '300000', 10);
const TIMEOUT_MS  = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
const ENV_LOGO    = process.env.BOT_LOGO || '';

if(!TOKEN || !CLIENT_ID || !GUILD_ID){
  console.error('✗ Missing env vars. Check your environment variables.');
  process.exit(1);
}

/* =====================================================================
   MESSAGE CONFIG
   ===================================================================== */
const DEFAULT_CONFIG = {
  logo: "",
  down: {
    color: "#4b362a",
    title: "🔧 WEBSITE UNDER MAINTENANCE",
    description: "Website **{label}** is currently experiencing issues.\n\n🛠️ **Status:** Under repair\n⏳ **Progress:** Fix in progress\n\nPlease wait until the website is back online. We'll post an update once the repair is complete.\n\nThank you for your patience! 🤎",
    image: "",
    thumbnail: "",
    footer: "Condo Servers • Maintenance"
  },
  up: {
    color: "#4fd88a",
    title: "✅ WEBSITE IS BACK ONLINE",
    description: "Website **{label}** is accessible again.\n\n🟢 **Status:** Online\n⚡ **Response:** {ms}ms\n\nThank you for your patience! 🤎",
    image: "",
    thumbnail: "",
    footer: "Condo Servers • Online"
  }
};

let MSG_CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

function loadMsgConfig(){
  try{
    if(fs.existsSync(CONFIG_FILE)){
      MSG_CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('✓ config.json loaded');
    }else{
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      MSG_CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      console.log('✓ config.json created (default)');
    }

    // Env override for logo
    if(ENV_LOGO && /^https?:\/\//i.test(ENV_LOGO)){
      MSG_CONFIG.logo = ENV_LOGO;
      console.log('✓ Logo loaded from env:', ENV_LOGO);
    }

    // Ensure structure
    MSG_CONFIG.down = MSG_CONFIG.down || {};
    MSG_CONFIG.up   = MSG_CONFIG.up   || {};
  }catch(e){
    console.error('✗ config.json parse error:', e.message);
    MSG_CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveMsgConfig(){
  try{
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(MSG_CONFIG, null, 2));
    return true;
  }catch(e){
    console.error('✗ Failed to save config.json:', e.message);
    return false;
  }
}

function fillTemplate(str, vars){
  return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

function resolveThumbnail(section){
  const sec = MSG_CONFIG[section] || {};
  const s = sec.thumbnail || '';
  if(s && /^https?:\/\//i.test(s)) return s;
  const g = MSG_CONFIG.logo || '';
  if(g && /^https?:\/\//i.test(g)) return g;
  return '';
}

function buildEmbed(section, vars){
  const cfg = MSG_CONFIG[section] || DEFAULT_CONFIG[section];
  const embed = new EmbedBuilder();

  if(cfg.color){
    const hex = cfg.color.replace('#','');
    if(/^[0-9a-f]{6}$/i.test(hex)) embed.setColor('#' + hex);
  }
  if(cfg.title) embed.setTitle(fillTemplate(cfg.title, vars).slice(0, 256));
  if(cfg.description) embed.setDescription(fillTemplate(cfg.description, vars).slice(0, 4000));

  const thumb = resolveThumbnail(section);
  if(thumb) embed.setThumbnail(thumb);

  if(cfg.image && /^https?:\/\//i.test(cfg.image)) embed.setImage(cfg.image);
  if(cfg.footer) embed.setFooter({ text: fillTemplate(cfg.footer, vars).slice(0, 2048) });

  embed.setTimestamp();
  return embed;
}

/* =====================================================================
   STORAGE
   ===================================================================== */
let db = { channelId: null, monitors: [] };

function loadDb(){
  try{
    if(fs.existsSync(DATA_FILE)){
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.monitors = db.monitors || [];
    }
  }catch(e){
    console.error('Failed to load data.json:', e.message);
  }
}
function saveDb(){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch(e){ console.error('Failed to save data.json:', e.message); }
}

/* =====================================================================
   URL CHECK
   ===================================================================== */
async function checkUrl(url){
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);

  try{
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'KyrielStatusBot/1.0 (+discord)' }
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    const ok = res.status >= 200 && res.status < 400;
    return { ok, status: res.status, ms, error: null };
  }catch(err){
    clearTimeout(timer);
    const ms = Date.now() - started;
    let msg = err.message || 'Unknown error';
    if(err.name === 'AbortError') msg = `Timeout after ${TIMEOUT_MS}ms`;
    return { ok: false, status: null, ms, error: msg };
  }
}

/* =====================================================================
   SLASH COMMANDS
   ===================================================================== */
const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check a URL right now')
    .addStringOption(o => o.setName('url').setDescription('Full URL').setRequired(true)),

  new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Manage monitored URLs')
    .addSubcommand(s => s.setName('add')
      .setDescription('Add a URL to monitor')
      .addStringOption(o => o.setName('url').setDescription('Full URL').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Display name').setRequired(false)))
    .addSubcommand(s => s.setName('remove')
      .setDescription('Remove a monitor')
      .addStringOption(o => o.setName('id').setDescription('Monitor ID from /monitor list').setRequired(true)))
    .addSubcommand(s => s.setName('list')
      .setDescription('List all monitors'))
    .addSubcommand(s => s.setName('check')
      .setDescription('Force check all monitors now')),

  new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Set the channel for alerts')
    .addSubcommand(s => s.setName('set')
      .setDescription('Set alert channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('clear')
      .setDescription('Clear alert channel')),

  new SlashCommandBuilder()
    .setName('message')
    .setDescription('Manage alert message templates')
    .addSubcommand(s => s.setName('view')
      .setDescription('Preview a message template')
      .addStringOption(o => o.setName('section').setDescription('Which template').setRequired(true)
        .addChoices({ name: 'Down alert', value: 'down' }, { name: 'Up alert', value: 'up' })))
    .addSubcommand(s => s.setName('edit')
      .setDescription('Edit a message template with a form')
      .addStringOption(o => o.setName('section').setDescription('Which template').setRequired(true)
        .addChoices({ name: 'Down alert', value: 'down' }, { name: 'Up alert', value: 'up' })))
    .addSubcommand(s => s.setName('reset')
      .setDescription('Reset a message template to default')
      .addStringOption(o => o.setName('section').setDescription('Which template').setRequired(true)
        .addChoices({ name: 'Down alert', value: 'down' }, { name: 'Up alert', value: 'up' })))
    .addSubcommand(s => s.setName('placeholders')
      .setDescription('List available placeholders'))
    .addSubcommand(s => s.setName('logo')
      .setDescription('Set the global logo (thumbnail) for all alerts')
      .addStringOption(o => o.setName('url').setDescription('Image URL, or "clear" to remove').setRequired(true))),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all commands')
].map(c => c.toJSON());

/* =====================================================================
   CLIENT
   ===================================================================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

async function registerCommands(){
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try{
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✓ Slash commands registered');
  }catch(e){
    console.error('✗ Failed to register commands:', e.message);
  }
}

/* =====================================================================
   MONITOR LOOP
   ===================================================================== */
let checkInProgress = false;

async function runAllChecks(force = false){
  if(checkInProgress) return;
  checkInProgress = true;
  try{
    for(const m of db.monitors){
      const result = await checkUrl(m.url);
      const wasUp = m.status !== 'down';
      const isUp = result.ok;

      if(isUp){ m.fails = 0; m.lastOk = Date.now(); }
      else { m.fails = (m.fails || 0) + 1; }
      m.lastCheck = Date.now();
      m.lastResult = { status: result.status, ms: result.ms, error: result.error };
      m.status = isUp ? 'up' : 'down';

      const changed = (wasUp && !isUp) || (!wasUp && isUp);
      if(changed || (force && !isUp)){
        await notify(m, result, wasUp);
      }
    }
    saveDb();
  }catch(e){
    console.error('Monitor loop error:', e.message);
  }finally{
    checkInProgress = false;
  }
}

async function notify(m, result, wasUp){
  if(!db.channelId) return;
  try{
    const ch = await client.channels.fetch(db.channelId).catch(()=>null);
    if(!ch || !ch.isTextBased()) return;

    const section = result.ok ? 'up' : 'down';
    const vars = {
      label: m.label,
      url: m.url,
      ms: result.ms,
      status: result.status || '—',
      error: result.error || 'none',
      fails: m.fails || 0
    };
    const embed = buildEmbed(section, vars);

    await ch.send({
      content: '',
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  }catch(e){
    console.error('Notify failed:', e.message);
  }
}

/* =====================================================================
   INTERACTION HANDLER
   ===================================================================== */
client.on('interactionCreate', async (interaction)=>{

  /* ---------- MODAL SUBMIT ---------- */
  if(interaction.isModalSubmit()){
    if(interaction.customId.startsWith('msgedit:')){
      const section = interaction.customId.split(':')[1];
      if(section !== 'down' && section !== 'up'){
        return interaction.reply({ content: '✗ Unknown section.', ephemeral: true });
      }

      const title = interaction.fields.getTextInputValue('m_title').trim();
      const description = interaction.fields.getTextInputValue('m_desc').trim();
      const color = interaction.fields.getTextInputValue('m_color').trim();
      const thumbnail = interaction.fields.getTextInputValue('m_thumbnail').trim();
      const footer = interaction.fields.getTextInputValue('m_footer').trim();

      if(color && !/^#?[0-9a-f]{6}$/i.test(color)){
        return interaction.reply({ content: '✗ Invalid color. Use hex like `#4b362a`.', ephemeral: true });
      }
      if(thumbnail && !/^https?:\/\//i.test(thumbnail)){
        return interaction.reply({ content: '✗ Thumbnail must be a full http/https URL, or leave it blank.', ephemeral: true });
      }

      MSG_CONFIG[section] = {
        ...MSG_CONFIG[section],
        title,
        description,
        color: color.startsWith('#') ? color : (color ? '#' + color : ''),
        thumbnail,
        footer
      };

      if(!saveMsgConfig()){
        return interaction.reply({ content: '✗ Failed to save config.json.', ephemeral: true });
      }

      const preview = buildEmbed(section, {
        label: 'Example Game', url: 'https://example.com',
        ms: 123, status: 200, error: 'none', fails: 0
      });

      return interaction.reply({
        content: `✅ Updated **${section === 'down' ? 'Down alert' : 'Up alert'}**. Preview below:`,
        embeds: [preview],
        ephemeral: true
      });
    }
    return;
  }

  /* ---------- SLASH COMMAND ---------- */
  if(!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try{
    if(commandName === 'status'){
      await interaction.deferReply();
      const url = interaction.options.getString('url').trim();
      const safe = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      const result = await checkUrl(safe);
      const vars = { label: safe, url: safe, ms: result.ms, status: result.status || '—', error: result.error || 'none', fails: 0 };
      const embed = buildEmbed(result.ok ? 'up' : 'down', vars);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if(commandName === 'help'){
      const e = new EmbedBuilder()
        .setColor(0x2fe0d0)
        .setTitle('🛡️ Kyriel Status Bot')
        .setDescription('Monitor your websites and get alerted the moment they go down.')
        .addFields(
          { name: '/status url:<url>', value: 'Check any URL immediately' },
          { name: '/monitor add url:<url> label:<name>', value: 'Start monitoring a URL' },
          { name: '/monitor remove id:<id>', value: 'Stop monitoring' },
          { name: '/monitor list', value: 'Show all monitors' },
          { name: '/monitor check', value: 'Force re-check everything now' },
          { name: '/channel set channel:<#channel>', value: 'Where to send alerts' },
          { name: '/channel clear', value: 'Stop alerts' },
          { name: '/message view section:<down|up>', value: 'Preview a template' },
          { name: '/message edit section:<down|up>', value: 'Edit template with a form' },
          { name: '/message reset section:<down|up>', value: 'Reset template to default' },
          { name: '/message logo url:<url>', value: 'Set global logo for all alerts' },
          { name: '/message placeholders', value: 'List available placeholders' }
        )
        .setFooter({ text: `Auto-check every ${Math.round(CHECK_MS/1000)}s` });
      await interaction.reply({ embeds: [e] });
      return;
    }

    if(commandName === 'channel'){
      const sub = interaction.options.getSubcommand();
      if(!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)){
        return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
      }
      if(sub === 'set'){
        const ch = interaction.options.getChannel('channel');
        db.channelId = ch.id;
        saveDb();
        return interaction.reply({ content: `✅ Alerts will be sent to ${ch}`, ephemeral: true });
      }
      if(sub === 'clear'){
        db.channelId = null;
        saveDb();
        return interaction.reply({ content: '🔕 Alert channel cleared.', ephemeral: true });
      }
    }

    if(commandName === 'message'){
      const sub = interaction.options.getSubcommand();

      if(sub === 'view'){
        const section = interaction.options.getString('section');
        const embed = buildEmbed(section, {
          label: 'Example Game', url: 'https://example.com',
          ms: 123, status: 200, error: 'none', fails: 0
        });
        return interaction.reply({
          content: `📄 Preview of **${section === 'down' ? 'Down alert' : 'Up alert'}** template:`,
          embeds: [embed],
          ephemeral: true
        });
      }

      if(sub === 'edit'){
        const section = interaction.options.getString('section');
        const cfg = MSG_CONFIG[section] || DEFAULT_CONFIG[section];

        const modal = new ModalBuilder()
          .setCustomId('msgedit:' + section)
          .setTitle(section === 'down' ? 'Edit Down Alert' : 'Edit Up Alert');

        const titleInput = new TextInputBuilder()
          .setCustomId('m_title')
          .setLabel('Title')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(256)
          .setRequired(false)
          .setValue(cfg.title || '');

        const descInput = new TextInputBuilder()
          .setCustomId('m_desc')
          .setLabel('Description')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
          .setRequired(false)
          .setValue(cfg.description || '');

        const colorInput = new TextInputBuilder()
          .setCustomId('m_color')
          .setLabel('Color (hex, e.g. #4b362a)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(7)
          .setRequired(false)
          .setValue(cfg.color || '');

        const thumbInput = new TextInputBuilder()
          .setCustomId('m_thumbnail')
          .setLabel('Thumbnail / logo URL (blank = use global)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(500)
          .setRequired(false)
          .setValue(cfg.thumbnail || '');

        const footerInput = new TextInputBuilder()
          .setCustomId('m_footer')
          .setLabel('Footer')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(2048)
          .setRequired(false)
          .setValue(cfg.footer || '');

        modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descInput),
          new ActionRowBuilder().addComponents(colorInput),
          new ActionRowBuilder().addComponents(thumbInput),
          new ActionRowBuilder().addComponents(footerInput)
        );

        return interaction.showModal(modal);
      }

      if(sub === 'reset'){
        const section = interaction.options.getString('section');
        if(!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)){
          return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
        }
        MSG_CONFIG[section] = JSON.parse(JSON.stringify(DEFAULT_CONFIG[section]));
        if(!saveMsgConfig()){
          return interaction.reply({ content: '✗ Failed to save config.json.', ephemeral: true });
        }
        const preview = buildEmbed(section, {
          label: 'Example Game', url: 'https://example.com',
          ms: 123, status: 200, error: 'none', fails: 0
        });
        return interaction.reply({
          content: `↺ Reset **${section === 'down' ? 'Down alert' : 'Up alert'}** to default.`,
          embeds: [preview],
          ephemeral: true
        });
      }

      if(sub === 'logo'){
        if(!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)){
          return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
        }
        const url = interaction.options.getString('url').trim();
        if(url.toLowerCase() === 'clear'){
          MSG_CONFIG.logo = '';
          saveMsgConfig();
          return interaction.reply({ content: '🗑️ Global logo cleared.', ephemeral: true });
        }
        const safe = /^https?:\/\//i.test(url) ? url : 'https://' + url;
        if(!/^https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(safe)){
          return interaction.reply({ content: '✗ URL must point to an image (png/jpg/jpeg/gif/webp).', ephemeral: true });
        }
        MSG_CONFIG.logo = safe;
        if(!saveMsgConfig()){
          return interaction.reply({ content: '✗ Failed to save.', ephemeral: true });
        }
        const preview = buildEmbed('down', {
          label: 'Example Game', url: 'https://example.com',
          ms: 123, status: 200, error: 'none', fails: 0
        });
        return interaction.reply({
          content: `✅ Global logo set.\n${safe}`,
          embeds: [preview],
          ephemeral: true
        });
      }

      if(sub === 'placeholders'){
        const e = new EmbedBuilder()
          .setColor(0x2fe0d0)
          .setTitle('📌 Available Placeholders')
          .setDescription('Use these in the **title**, **description**, or **footer** of any template. They are replaced at send time.')
          .addFields(
            { name: '{label}', value: 'The monitor label (e.g. `My Website`)', inline: false },
            { name: '{url}', value: 'The monitored URL', inline: false },
            { name: '{ms}', value: 'Response time in milliseconds', inline: false },
            { name: '{status}', value: 'HTTP status code (e.g. `200`, `500`)', inline: false },
            { name: '{error}', value: 'Error message if the check failed', inline: false },
            { name: '{fails}', value: 'Number of consecutive failures', inline: false }
          )
          .setFooter({ text: 'Unknown placeholders are left as-is' });
        return interaction.reply({ embeds: [e], ephemeral: true });
      }
    }

    if(commandName === 'monitor'){
      const sub = interaction.options.getSubcommand();

      if(sub === 'add'){
        const urlRaw = interaction.options.getString('url').trim();
        const label = (interaction.options.getString('label') || '').trim() || urlRaw;
        const safe = /^https?:\/\//i.test(urlRaw) ? urlRaw : 'https://' + urlRaw;
        if(!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(safe)){
          return interaction.reply({ content: '✗ Invalid URL', ephemeral: true });
        }
        if(db.monitors.some(m => m.url === safe)){
          return interaction.reply({ content: '⚠ This URL is already monitored.', ephemeral: true });
        }
        const id = Math.random().toString(36).slice(2, 8);
        const m = { id, url: safe, label, status: null, fails: 0, lastCheck: 0, lastResult: null };
        db.monitors.push(m);
        saveDb();
        await interaction.reply({ content: `✅ Added **${label}**\n\`ID: ${id}\`\n${safe}`, ephemeral: true });

        const result = await checkUrl(safe);
        m.status = result.ok ? 'up' : 'down';
        m.fails = result.ok ? 0 : 1;
        m.lastCheck = Date.now();
        m.lastResult = { status: result.status, ms: result.ms, error: result.error };
        saveDb();
        if(!result.ok) await notify(m, result, true);
        return;
      }

      if(sub === 'remove'){
        const id = interaction.options.getString('id').trim();
        const i = db.monitors.findIndex(m => m.id === id);
        if(i === -1) return interaction.reply({ content: '✗ ID not found', ephemeral: true });
        const removed = db.monitors.splice(i, 1)[0];
        saveDb();
        return interaction.reply({ content: `🗑️ Removed **${removed.label}**`, ephemeral: true });
      }

      if(sub === 'list'){
        if(!db.monitors.length){
          return interaction.reply({ content: 'No monitors yet. Use `/monitor add` to start.', ephemeral: true });
        }
        const lines = db.monitors.map(m => {
          const icon = m.status === 'up' ? '🟢' : (m.status === 'down' ? '🔴' : '⚪');
          const ms = m.lastResult?.ms ? ` · \`${m.lastResult.ms}ms\`` : '';
          const err = m.lastResult?.error ? ` · \`${m.lastResult.error}\`` : '';
          return `${icon} **${m.label}** · \`${m.id}\`${ms}${err}\n${m.url}`;
        }).join('\n\n');
        const e = new EmbedBuilder()
          .setColor(0x2fe0d0)
          .setTitle(`📋 Monitors (${db.monitors.length})`)
          .setDescription(lines.slice(0, 4000))
          .setFooter({ text: db.channelId ? `Alerts → <#${db.channelId}>` : 'No alert channel set' });
        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      if(sub === 'check'){
        if(!db.monitors.length) return interaction.reply({ content: 'No monitors to check.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const results = [];
        for(const m of db.monitors){
          const r = await checkUrl(m.url);
          m.status = r.ok ? 'up' : 'down';
          m.fails = r.ok ? 0 : (m.fails || 0) + 1;
          m.lastCheck = Date.now();
          m.lastResult = { status: r.status, ms: r.ms, error: r.error };
          results.push(`${r.ok ? '🟢' : '🔴'} **${m.label}** ${r.status ? '(' + r.status + ')' : ''} \`${r.ms}ms\`${r.error ? ' · ' + r.error : ''}`);
        }
        saveDb();
        const e = new EmbedBuilder()
          .setColor(0x2fe0d0)
          .setTitle('🔍 Check Results')
          .setDescription(results.join('\n'));
        return interaction.editReply({ embeds: [e] });
      }
    }
  }catch(e){
    console.error('Interaction error:', e);
    if(!interaction.replied && !interaction.deferred){
      interaction.reply({ content: '✗ Something went wrong.', ephemeral: true }).catch(()=>{});
    }
  }
});

/* =====================================================================
   READY
   ===================================================================== */
client.once('ready', async ()=>{
  console.log(`✓ Logged in as ${client.user.tag}`);
  loadMsgConfig();
  await registerCommands();
  client.user.setActivity('for downtime 👀', { type: ActivityType.Watching });

  loadDb();
  setTimeout(()=>runAllChecks(), 5000);
  setInterval(()=>runAllChecks(), CHECK_MS);
});

process.on('SIGINT', ()=>{
  console.log('\nShutting down...');
  saveDb();
  client.destroy();
  process.exit(0);
});

loadMsgConfig();
loadDb();
client.login(TOKEN);
