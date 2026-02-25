const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==================== CONFIGURAZIONE ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;

const VIDEO_NAME = 'SENSATIONAL';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'];
const MAX_FILE_SIZE_MB = 25;
const FILES_PER_MESSAGE = 2;
const SLEEP_MS = 800;
const MAX_RETRIES = 3;
// =========================================================

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

const WEBHOOK_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAAsUlEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8GXHmAAGhi4cUAAAAAElFTkSuQmCC';

async function getOrCreateWebhook(targetChannel) {
  const webhooks = await targetChannel.fetchWebhooks();
  let wh = webhooks.find(w => w.name === 'SENSATIONAL');
  if (!wh) {
    wh = await targetChannel.createWebhook({ name: 'SENSATIONAL', avatar: WEBHOOK_AVATAR, reason: 'Server clone' });
    await sleep(500);
  }
  return wh.url;
}

// ===================== CLONE STRUCTURE =====================
async function cloneStructure(sourceGuild, targetGuild) {
  console.log('🏗️ Clono categorie e canali...');

  const channelMap = new Map();

  // 1. Categorie
  const categories = [...sourceGuild.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  for (const cat of categories) {
    let targetCat = targetGuild.channels.cache.find(c => c.name === cat.name && c.type === ChannelType.GuildCategory);
    if (!targetCat) {
      try {
        targetCat = await targetGuild.channels.create({
          name: cat.name,
          type: ChannelType.GuildCategory,
          position: cat.position,
          reason: 'Server clone'
        });
        console.log(`  📁 Categoria creata: ${cat.name}`);
        await sleep(800);
      } catch (err) {
        console.error(`  ❌ Errore categoria ${cat.name}: ${err.message}`);
        continue;
      }
    } else {
      console.log(`  ⏭️ Categoria già esistente: ${cat.name}`);
    }
    channelMap.set(cat.id, targetCat);
  }

  // 2. Canali testo — tutti 18+
  const textChannels = [...sourceGuild.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildText)
    .sort((a, b) => a.position - b.position);

  for (const ch of textChannels) {
    let targetCh = targetGuild.channels.cache.find(c => c.name === ch.name && c.type === ChannelType.GuildText);
    if (!targetCh) {
      try {
        const targetParent = ch.parentId ? channelMap.get(ch.parentId) : null;
        targetCh = await targetGuild.channels.create({
          name: ch.name,
          type: ChannelType.GuildText,
          nsfw: true,
          parent: targetParent?.id || null,
          position: ch.position,
          reason: 'Server clone'
        });
        console.log(`  💬 Canale creato: #${ch.name} [18+]`);
        await sleep(800);
      } catch (err) {
        console.error(`  ❌ Errore canale #${ch.name}: ${err.message}`);
        continue;
      }
    } else {
      try { await targetCh.edit({ nsfw: true }); } catch (_) {}
      console.log(`  ⏭️ Canale già esistente: #${ch.name} [18+]`);
    }
    channelMap.set(ch.id, targetCh);
  }

  return channelMap;
}

// ===================== CLONE MEDIA PER CANALE =====================
async function cloneChannelMedia(sourceChannel, targetChannel) {
  console.log(`  📨 [#${sourceChannel.name}] Avvio...`);
  const webhookUrl = await getOrCreateWebhook(targetChannel);

  let lastId = null;
  let done = false;
  let buffer = [];
  let totalFiles = 0;

  const flushBuffer = async () => {
    if (buffer.length === 0) return;
    const paths = buffer.map(f => f.tempPath);
    const names = buffer.map(f => f.newName).join(', ');
    try {
      await sendPairViaWebhook(webhookUrl, paths);
      totalFiles += buffer.length;
      console.log(`  ✅ [#${sourceChannel.name}] Inviati: ${names}`);
    } catch (err) {
      console.error(`  ❌ [#${sourceChannel.name}] Invio fallito: ${err.message}`);
    }
    paths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
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
        for (const attachment of message.attachments.values()) {
          const ext = path.extname(attachment.name).toLowerCase();
          const isImage = IMAGE_EXTS.includes(ext);
          const isVideo = VIDEO_EXTS.includes(ext);
          if (!isImage && !isVideo) continue;

          if (attachment.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            console.log(`  ⚠️ [#${sourceChannel.name}] Salto ${attachment.name} (${(attachment.size / 1024 / 1024).toFixed(1)}MB)`);
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
            console.error(`  ❌ [#${sourceChannel.name}] Download fallito: ${err.message}`);
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
  console.log(`  🏁 [#${sourceChannel.name}] Completato: ${totalFiles} file inviati`);
  return totalFiles;
}

// ===================== MAIN =====================
async function cloneServer(sourceGuild, targetGuild) {
  console.log(`\n🚀 Clonazione: "${sourceGuild.name}" -> "${targetGuild.name}"\n`);

  const channelMap = await cloneStructure(sourceGuild, targetGuild);

  console.log('\n📦 Upload media in parallelo su tutti i canali...\n');

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
  console.log(`\n🏁 Clonazione completata! Totale file inviati: ${total}`);
}

// ---------- Server HTTP per Render ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Bot cloner attivo'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 Server HTTP in ascolto sulla porta ${PORT}`));
// --------------------------------------------

client.once('ready', async () => {
  if (isRunning) return;
  isRunning = true;
  console.log(`✅ Bot connesso come ${client.user.tag}`);

  const sourceGuild = await client.guilds.fetch(SOURCE_GUILD_ID).catch(() => null);
  const targetGuild = await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);

  if (!sourceGuild || !targetGuild) {
    console.error('❌ Server non trovati. Assicurati che il bot sia in entrambi i server.');
    process.exit(1);
  }

  // Fetch canali
  await sourceGuild.channels.fetch();
  await targetGuild.channels.fetch();

  await cloneServer(sourceGuild, targetGuild);
  console.log('🏁 Operazione terminata.');
});

process.on('unhandledRejection', reason => console.error('❌ Unhandled:', reason));
process.on('uncaughtException', err => console.error('❌ Exception:', err.message));

client.login(BOT_TOKEN).catch(err => {
  console.error('❌ Login fallito:', err.message);
  process.exit(1);
});
                        
