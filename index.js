const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==================== CONFIGURAZIONE ====================
const BOT_TOKEN       = process.env.BOT_TOKEN;
const SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;

const VIDEO_NAME        = 'SENSATIONAL';
const IMAGE_EXTS        = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const VIDEO_EXTS        = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'];
const MAX_FILE_SIZE_MB  = 25;
const FILES_PER_MESSAGE = 2;
const SLEEP_MS          = 800;
const MAX_RETRIES       = 3;

const WEBHOOK_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAAsUlEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8GXHmAAGhi4cUAAAAAElFTkSuQmCC';
// =========================================================

// Debug env vars all'avvio
console.log('🔧 Controllo variabili ambiente:');
console.log(`  BOT_TOKEN:       ${BOT_TOKEN       ? '✅ (' + BOT_TOKEN.slice(0,15)       + '...)' : '❌ MANCANTE'}`);
console.log(`  SOURCE_GUILD_ID: ${SOURCE_GUILD_ID ? '✅ ' + SOURCE_GUILD_ID              : '❌ MANCANTE'}`);
console.log(`  TARGET_GUILD_ID: ${TARGET_GUILD_ID ? '✅ ' + TARGET_GUILD_ID              : '❌ MANCANTE'}`);

if (!BOT_TOKEN)       { console.error('❌ BOT_TOKEN mancante!');       process.exit(1); }
if (!SOURCE_GUILD_ID) { console.error('❌ SOURCE_GUILD_ID mancante!'); process.exit(1); }
if (!TARGET_GUILD_ID) { console.error('❌ TARGET_GUILD_ID mancante!'); process.exit(1); }

// ==================== CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks
  ]
});

let isRunning = false;
let fileCounter = 1;
function getNextCounter() { return fileCounter++; }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==================== DOWNLOAD ====================
async function downloadFile(url, outputPath) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const writer = fs.createWriteStream(outputPath);
      const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 60000 });
      res.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      const stats = fs.statSync(outputPath);
      if (stats.size < 1024) { fs.unlinkSync(outputPath); throw new Error('File corrotto o URL scaduto'); }
      return stats.size;
    } catch (err) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (i === MAX_RETRIES - 1) throw err;
      await sleep(3000);
    }
  }
}

// ==================== WEBHOOK ====================
async function sendPairViaWebhook(webhookUrl, filePaths) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const form = new FormData();
      filePaths.forEach((fp, idx) => form.append(`files[${idx}]`, fs.createReadStream(fp)));
      await axios.post(webhookUrl, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000
      });
      return true;
    } catch (err) {
      if (i === MAX_RETRIES - 1) throw err;
      await sleep(3000);
    }
  }
}

async function getOrCreateWebhook(targetChannel) {
  const webhooks = await targetChannel.fetchWebhooks();
  let wh = webhooks.find(w => w.name === 'SENSATIONAL');
  if (!wh) {
    wh = await targetChannel.createWebhook({ name: 'SENSATIONAL', avatar: WEBHOOK_AVATAR, reason: 'Server clone' });
    await sleep(500);
  }
  return wh.url;
}

// ==================== CLONE STRUCTURE ====================
async function cloneStructure(sourceGuild, targetGuild) {
  console.log('🏗️ Clono categorie e canali...');
  const channelMap = new Map();

  const categories = [...sourceGuild.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);
  console.log(`  📁 ${categories.length} categorie trovate`);

  for (const cat of categories) {
    let targetCat = targetGuild.channels.cache.find(c => c.name === cat.name && c.type === ChannelType.GuildCategory);
    if (!targetCat) {
      try {
        targetCat = await targetGuild.channels.create({
          name: cat.name, type: ChannelType.GuildCategory,
          position: cat.position, reason: 'Server clone'
        });
        console.log(`  📁 Creata: ${cat.name}`);
        await sleep(800);
      } catch (err) { console.error(`  ❌ Cat ${cat.name}: ${err.message}`); continue; }
    } else { console.log(`  ⏭️ Esiste già: ${cat.name}`); }
    channelMap.set(cat.id, targetCat);
  }

  const textChannels = [...sourceGuild.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildText)
    .sort((a, b) => a.position - b.position);
  console.log(`  💬 ${textChannels.length} canali testo trovati`);

  for (const ch of textChannels) {
    let targetCh = targetGuild.channels.cache.find(c => c.name === ch.name && c.type === ChannelType.GuildText);
    if (!targetCh) {
      try {
        const targetParent = ch.parentId ? channelMap.get(ch.parentId) : null;
        targetCh = await targetGuild.channels.create({
          name: ch.name, type: ChannelType.GuildText,
          nsfw: true, parent: targetParent?.id || null,
          position: ch.position, reason: 'Server clone'
        });
        console.log(`  💬 Creato: #${ch.name} [18+]`);
        await sleep(800);
      } catch (err) { console.error(`  ❌ Ch #${ch.name}: ${err.message}`); continue; }
    } else {
      try { await targetCh.edit({ nsfw: true }); } catch (_) {}
      console.log(`  ⏭️ Esiste già: #${ch.name} [18+]`);
    }
    channelMap.set(ch.id, targetCh);
  }

  return channelMap;
}

// ==================== CLONE MEDIA ====================
async function cloneChannelMedia(sourceChannel, targetChannel) {
  console.log(`  📨 [#${sourceChannel.name}] Avvio...`);
  const webhookUrl = await getOrCreateWebhook(targetChannel);

  let lastId = null, done = false, buffer = [], totalFiles = 0;

  const flushBuffer = async () => {
    if (!buffer.length) return;
    const paths = buffer.map(f => f.tempPath);
    try {
      await sendPairViaWebhook(webhookUrl, paths);
      totalFiles += buffer.length;
      console.log(`  ✅ [#${sourceChannel.name}] Inviati: ${buffer.map(f=>f.newName).join(', ')}`);
    } catch (err) { console.error(`  ❌ [#${sourceChannel.name}] Invio fallito: ${err.message}`); }
    paths.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch(_){} });
    buffer = [];
    await sleep(SLEEP_MS);
  };

  while (!done) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await sourceChannel.messages.fetch(options).catch(() => null);
    if (!messages || messages.size === 0) break;

    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of sorted) {
      if (message.attachments.size) {
        let freshMessage = message;
        try { freshMessage = await sourceChannel.messages.fetch(message.id); } catch(_) {}

        for (const attachment of freshMessage.attachments.values()) {
          const ext = path.extname(attachment.name).toLowerCase();
          if (![...IMAGE_EXTS, ...VIDEO_EXTS].includes(ext)) continue;
          if (attachment.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            console.log(`  ⚠️ [#${sourceChannel.name}] Skip ${attachment.name} (${(attachment.size/1024/1024).toFixed(1)}MB)`);
            continue;
          }

          const newName = `${VIDEO_NAME}_${getNextCounter()}${ext}`;
          const tempPath = path.join(__dirname, `${sourceChannel.id}_${Date.now()}_${newName}`);
          console.log(`  ⬇️ [#${sourceChannel.name}] ${attachment.name} -> ${newName}`);

          try {
            await downloadFile(attachment.url, tempPath);
            buffer.push({ tempPath, newName });
            if (buffer.length >= FILES_PER_MESSAGE) await flushBuffer();
          } catch (err) {
            console.error(`  ❌ [#${sourceChannel.name}] Download: ${err.message}`);
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          }
        }
      }
    }

    lastId = messages.last()?.id;
    if (messages.size < 100) done = true;
    else await sleep(SLEEP_MS);
  }

  await flushBuffer();
  console.log(`  🏁 [#${sourceChannel.name}] Completato: ${totalFiles} file`);
  return totalFiles;
}

// ==================== MAIN ====================
async function cloneServer(sourceGuild, targetGuild) {
  console.log(`\n🚀 Clonazione: "${sourceGuild.name}" -> "${targetGuild.name}"\n`);

  const channelMap = await cloneStructure(sourceGuild, targetGuild);
  console.log('\n📦 Upload media in parallelo...\n');

  const textChannels = [...sourceGuild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText);

  const results = await Promise.allSettled(
    textChannels.map(sourceChannel => {
      const targetChannel = channelMap.get(sourceChannel.id) ||
        targetGuild.channels.cache.find(c => c.name === sourceChannel.name && c.type === ChannelType.GuildText);
      if (!targetChannel) {
        console.log(`  ⚠️ Target non trovato per #${sourceChannel.name}, salto.`);
        return Promise.resolve(0);
      }
      return cloneChannelMedia(sourceChannel, targetChannel);
    })
  );

  const total = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
  console.log(`\n🏁 Clonazione completata! Totale file: ${total}`);
}

// ==================== HTTP per Render ====================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Bot cloner attivo'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 HTTP sulla porta ${PORT}`));
// =========================================================

client.once('ready', async () => {
  if (isRunning) return;
  isRunning = true;
  console.log(`\n✅ Bot connesso come ${client.user.tag}`);

  console.log('📡 Fetching server sorgente...');
  const sourceGuild = await client.guilds.fetch(SOURCE_GUILD_ID).catch(e => { console.error(`❌ Source fetch error: ${e.message}`); return null; });
  console.log('📡 Fetching server destinazione...');
  const targetGuild = await client.guilds.fetch(TARGET_GUILD_ID).catch(e => { console.error(`❌ Target fetch error: ${e.message}`); return null; });

  if (!sourceGuild) { console.error('❌ Source non trovato. Il bot è nel server sorgente con i permessi giusti?'); process.exit(1); }
  if (!targetGuild) { console.error('❌ Target non trovato. Il bot è nel server destinazione con i permessi giusti?'); process.exit(1); }

  console.log(`✅ Source: ${sourceGuild.name}`);
  console.log(`✅ Target: ${targetGuild.name}`);

  await sourceGuild.channels.fetch();
  await targetGuild.channels.fetch();

  await cloneServer(sourceGuild, targetGuild);
  console.log('🏁 Operazione terminata.');
});

process.on('unhandledRejection', reason => console.error('❌ Unhandled:', reason));
process.on('uncaughtException', err => console.error('❌ Exception:', err.message));

console.log('🔌 Connessione a Discord in corso...');
client.login(BOT_TOKEN).catch(err => {
  console.error(`❌ Login fallito: ${err.message}`);
  process.exit(1);
});
          
