const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const fetch = require('node-fetch');
require('dotenv').config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const path = require('path');
const IDENTITY_FILE = path.join(__dirname, 'fed_identity.json');
const MEMORY_FILE   = path.join(__dirname, 'fed_memory.json');
const VAULT_FILE    = path.join(__dirname, 'fed_vault.json');
const RULES_FILE    = path.join(__dirname, 'fed_rules.json');
const SHARED_FILE   = path.join(__dirname, 'fed_shared.json');
const REL_FILE      = path.join(__dirname, 'fed_relationships.json');
const LANG_LOCK_FILE= path.join(__dirname, 'fed_lang_lock.json');

let globalLangLock = null; // null = auto-detect per user, 'hindi' etc = locked for ALL replies
const MAX_SHARED    = 60; // keep last 60 messages — moved here to avoid TDZ in startup block
let sharedHistory    = []; // declared here so startup load block can access it
let sharedSummary    = ''; // compressed summary of older shared messages
let lastSummaryCount = 0;  // message count at last summary generation

let identity      = {};
let userData      = {};
let vault         = [];
let liveRules     = [];
let relationships = {}; // { 'uid1_uid2': { type, level, notes[] } }

try {
  identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  const locked = Object.entries(identity).filter(([,i]) => i.knownAs).map(([,i]) => i.knownAs);
  console.log('Identity loaded — ' + Object.keys(identity).length + ' entries, known: ' + locked.join(', '));
} catch (e) { console.log('Identity file error: ' + e.message); }

try {
  userData = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  console.log('Memory loaded — ' + Object.keys(userData).length + ' users');
} catch (e) { console.log('Memory file error (starting fresh): ' + e.message); }

try { vault     = JSON.parse(fs.readFileSync(VAULT_FILE,  'utf8')); console.log('Vault loaded — ' + vault.length + ' facts'); }     catch (e) { console.log('Vault file error: ' + e.message); }
try { liveRules = JSON.parse(fs.readFileSync(RULES_FILE,  'utf8')); console.log('Rules loaded — ' + liveRules.length + ' rules'); } catch (e) { console.log('Rules file error: ' + e.message); }
try { relationships = JSON.parse(fs.readFileSync(REL_FILE, 'utf8')); console.log('Relationships loaded — ' + Object.keys(relationships).length + ' pairs'); } catch (e) { console.log('Relationships starting fresh.'); }
try {
  const sharedData = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8'));
  // Support both old format (array) and new format ({ history, summary })
  if (Array.isArray(sharedData)) {
    sharedHistory = sharedData;
    sharedSummary = '';
  } else {
    sharedHistory = sharedData.history || [];
    sharedSummary = sharedData.summary || '';
    lastSummaryCount = sharedData.summaryAt || 0;
  }
  if (sharedHistory.length > MAX_SHARED) sharedHistory = sharedHistory.slice(-MAX_SHARED);
  console.log('Shared history loaded — ' + sharedHistory.length + ' entries' + (sharedSummary ? ' + summary' : '') + ' (context restored)');
} catch (e) { console.log('Shared history starting fresh: ' + e.message); }

const saveIdentity     = () => fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity,      null, 2));
const saveMemory       = () => fs.writeFileSync(MEMORY_FILE,   JSON.stringify(userData,      null, 2));
const saveVault        = () => fs.writeFileSync(VAULT_FILE,    JSON.stringify(vault,         null, 2));
const saveRules        = () => fs.writeFileSync(RULES_FILE,    JSON.stringify(liveRules,     null, 2));
const saveRelationships= () => fs.writeFileSync(REL_FILE,      JSON.stringify(relationships, null, 2));
const saveLangLock     = () => fs.writeFileSync(LANG_LOCK_FILE, JSON.stringify({ lock: globalLangLock }, null, 2));
try { const ll = JSON.parse(fs.readFileSync(LANG_LOCK_FILE, 'utf8')); globalLangLock = ll.lock || null; if (globalLangLock) console.log(`Lang lock restored: ${globalLangLock}`); } catch (e) {}

function formatLastSeen(ts) {
  if (!ts) return null;
  const diff  = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  3)  return null;
  if (mins  < 60)  return `${mins} minutes ago`;
  if (hours <  2)  return 'about an hour ago';
  if (hours < 24)  return `${hours} hours ago`;
  if (days  <  2)  return 'yesterday';
  if (days  <  7)  return `${days} days ago`;
  return 'over a week ago';
}

// Build the full known-people roster from the identity file.
// Injected into every prompt so Fed always knows everyone — not just when mentioned.
function buildIdentityRoster(filterIds = null) {
  let known = Object.entries(identity).filter(([, i]) => i.knownAs);
  if (filterIds) known = known.filter(([uid]) => filterIds.has(uid));
  if (known.length === 0) return '';
  const lines = known.map(([uid, i]) => {
    const nicknames = (i.nicknames || []).filter(n => n !== i.knownAs);
    const nicks = nicknames.length > 0 ? ` (also: ${nicknames.join('/')})` : '';
    const loc   = i.location ? ` [${i.location}]` : '';
    return `${i.knownAs}/${i.gender || '?'}${nicks}${loc}`;
  });
  return `People: ${lines.join(' | ')}`;
}

// Shared channel history — ALL messages from ALL users + Fed replies.
// Persisted to fed_shared.json so it survives restarts.
// Every conversation references this so Fed knows what he said to others.
// MAX_SHARED moved to top (was causing TDZ error in startup block)

// Per-channel recent message log — used for local context in buildPrompt
const channelLogs = {}; // channelId → array of strings
const MAX_CHANNEL_LOG = 20;

const saveShared = () => fs.writeFileSync(SHARED_FILE, JSON.stringify({
  history: sharedHistory,
  summary: sharedSummary,
  summaryAt: lastSummaryCount
}, null, 2));

function addToShared(name, id, role, content) {
  sharedHistory.push({ name, id, role, content, ts: Date.now() });
  if (sharedHistory.length > MAX_SHARED) sharedHistory.shift();
  if (role === 'fed') saveShared();
}


// Full 60-entry injection — IDs stripped, 120-char cap per message.
// Passive savings ~700 tokens. No summary = no precision loss.
function getSharedContext() {
  return sharedHistory
    .slice(-60)
    .map(h => {
      const content = h.content.length > 120 ? h.content.slice(0, 117) + '...' : h.content;
      return h.role === 'fed' ? `Fed: ${content}` : `${h.name}: ${content}`;
    })
    .join('\n');
}

// Returns only IDs of people who spoke recently — for trimmed roster
function getRecentSpeakerIds(limit = 15) {
  const ids = new Set();
  sharedHistory.slice(-limit).forEach(h => { if (h.id && h.id !== 'fed') ids.add(h.id); });
  return ids;
}

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7,
].filter(Boolean); // filter(Boolean) safely skips any slots left empty in .env

// Per-key cooldown tracker — when a key 429s, it rests 60s before being tried again
const keyCooldowns = {};
function isKeyCooling(key) {
  return keyCooldowns[key] && Date.now() < keyCooldowns[key];
}
function coolKey(key, ms = 5000) {
  keyCooldowns[key] = Date.now() + ms;
  console.log(`Groq key ${Math.round(ms/1000)}s cooldown`);
}

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

let groqIndex   = 0;
let geminiIndex = 0;

const CREATOR_ID     = process.env.CREATOR_ID     || '';
const MAIN_PERSON_ID = process.env.MAIN_PERSON_ID || '';

// ─── Location → Timezone Map ──────────────────────────────────────────────────
const LOCATION_TZ = {
  // South Asia
  'india':'Asia/Kolkata','indian':'Asia/Kolkata','delhi':'Asia/Kolkata',
  'mumbai':'Asia/Kolkata','bangalore':'Asia/Kolkata','bengaluru':'Asia/Kolkata',
  'kolkata':'Asia/Kolkata','chennai':'Asia/Kolkata','hyderabad':'Asia/Kolkata',
  'pune':'Asia/Kolkata','ahmedabad':'Asia/Kolkata','jaipur':'Asia/Kolkata',
  'pakistan':'Asia/Karachi','karachi':'Asia/Karachi','lahore':'Asia/Karachi',
  'islamabad':'Asia/Karachi',
  'bangladesh':'Asia/Dhaka','dhaka':'Asia/Dhaka',
  'sri lanka':'Asia/Colombo','colombo':'Asia/Colombo',
  'nepal':'Asia/Kathmandu','kathmandu':'Asia/Kathmandu',
  // Southeast Asia
  'philippines':'Asia/Manila','manila':'Asia/Manila','ph':'Asia/Manila',
  'indonesia':'Asia/Jakarta','jakarta':'Asia/Jakarta',
  'malaysia':'Asia/Kuala_Lumpur','kuala lumpur':'Asia/Kuala_Lumpur','kl':'Asia/Kuala_Lumpur',
  'singapore':'Asia/Singapore','sg':'Asia/Singapore',
  'thailand':'Asia/Bangkok','bangkok':'Asia/Bangkok',
  'vietnam':'Asia/Ho_Chi_Minh','ho chi minh':'Asia/Ho_Chi_Minh','hanoi':'Asia/Ho_Chi_Minh',
  'myanmar':'Asia/Rangoon','rangoon':'Asia/Rangoon',
  'cambodia':'Asia/Phnom_Penh','phnom penh':'Asia/Phnom_Penh',
  // East Asia
  'japan':'Asia/Tokyo','tokyo':'Asia/Tokyo','osaka':'Asia/Tokyo',
  'china':'Asia/Shanghai','beijing':'Asia/Shanghai','shanghai':'Asia/Shanghai',
  'south korea':'Asia/Seoul','korea':'Asia/Seoul','seoul':'Asia/Seoul',
  'hong kong':'Asia/Hong_Kong','hk':'Asia/Hong_Kong',
  'taiwan':'Asia/Taipei','taipei':'Asia/Taipei',
  'mongolia':'Asia/Ulaanbaatar',
  // Middle East
  'uae':'Asia/Dubai','dubai':'Asia/Dubai','abu dhabi':'Asia/Dubai',
  'saudi arabia':'Asia/Riyadh','riyadh':'Asia/Riyadh','ksa':'Asia/Riyadh',
  'qatar':'Asia/Qatar','doha':'Asia/Qatar',
  'kuwait':'Asia/Kuwait',
  'bahrain':'Asia/Bahrain',
  'oman':'Asia/Muscat','muscat':'Asia/Muscat',
  'turkey':'Europe/Istanbul','istanbul':'Europe/Istanbul','ankara':'Europe/Istanbul',
  'israel':'Asia/Jerusalem','tel aviv':'Asia/Jerusalem',
  'iran':'Asia/Tehran','tehran':'Asia/Tehran',
  'iraq':'Asia/Baghdad','baghdad':'Asia/Baghdad',
  'jordan':'Asia/Amman','amman':'Asia/Amman',
  'lebanon':'Asia/Beirut','beirut':'Asia/Beirut',
  // Europe
  'uk':'Europe/London','united kingdom':'Europe/London','britain':'Europe/London',
  'england':'Europe/London','london':'Europe/London','manchester':'Europe/London',
  'scotland':'Europe/London','edinburgh':'Europe/London','wales':'Europe/London',
  'ireland':'Europe/Dublin','dublin':'Europe/Dublin',
  'france':'Europe/Paris','paris':'Europe/Paris','lyon':'Europe/Paris',
  'germany':'Europe/Berlin','berlin':'Europe/Berlin','munich':'Europe/Berlin',
  'spain':'Europe/Madrid','madrid':'Europe/Madrid','barcelona':'Europe/Madrid',
  'italy':'Europe/Rome','rome':'Europe/Rome','milan':'Europe/Rome',
  'netherlands':'Europe/Amsterdam','amsterdam':'Europe/Amsterdam','holland':'Europe/Amsterdam',
  'belgium':'Europe/Brussels','brussels':'Europe/Brussels',
  'switzerland':'Europe/Zurich','zurich':'Europe/Zurich','geneva':'Europe/Zurich',
  'austria':'Europe/Vienna','vienna':'Europe/Vienna',
  'portugal':'Europe/Lisbon','lisbon':'Europe/Lisbon',
  'poland':'Europe/Warsaw','warsaw':'Europe/Warsaw',
  'russia':'Europe/Moscow','moscow':'Europe/Moscow',
  'ukraine':'Europe/Kiev','kyiv':'Europe/Kiev','kiev':'Europe/Kiev',
  'sweden':'Europe/Stockholm','stockholm':'Europe/Stockholm',
  'norway':'Europe/Oslo','oslo':'Europe/Oslo',
  'denmark':'Europe/Copenhagen','copenhagen':'Europe/Copenhagen',
  'finland':'Europe/Helsinki','helsinki':'Europe/Helsinki',
  'greece':'Europe/Athens','athens':'Europe/Athens',
  'romania':'Europe/Bucharest','bucharest':'Europe/Bucharest',
  'hungary':'Europe/Budapest','budapest':'Europe/Budapest',
  'czech republic':'Europe/Prague','prague':'Europe/Prague','czechia':'Europe/Prague',
  'slovakia':'Europe/Bratislava','bratislava':'Europe/Bratislava',
  'croatia':'Europe/Zagreb','zagreb':'Europe/Zagreb',
  'serbia':'Europe/Belgrade','belgrade':'Europe/Belgrade',
  'bulgaria':'Europe/Sofia','sofia':'Europe/Sofia',
  // Americas
  'us':'America/New_York','usa':'America/New_York','united states':'America/New_York',
  'america':'America/New_York',
  'new york':'America/New_York','nyc':'America/New_York','ny':'America/New_York',
  'los angeles':'America/Los_Angeles','la':'America/Los_Angeles','california':'America/Los_Angeles',
  'chicago':'America/Chicago','illinois':'America/Chicago',
  'houston':'America/Chicago','texas':'America/Chicago','dallas':'America/Chicago',
  'miami':'America/New_York','florida':'America/New_York',
  'seattle':'America/Los_Angeles','washington':'America/Los_Angeles',
  'san francisco':'America/Los_Angeles','sf':'America/Los_Angeles',
  'boston':'America/New_York','massachusetts':'America/New_York',
  'atlanta':'America/New_York','georgia':'America/New_York',
  'phoenix':'America/Phoenix','arizona':'America/Phoenix',
  'denver':'America/Denver','colorado':'America/Denver',
  'canada':'America/Toronto','toronto':'America/Toronto','ontario':'America/Toronto',
  'vancouver':'America/Vancouver','bc':'America/Vancouver','british columbia':'America/Vancouver',
  'montreal':'America/Toronto','quebec':'America/Toronto',
  'calgary':'America/Edmonton','alberta':'America/Edmonton',
  'mexico':'America/Mexico_City','mexico city':'America/Mexico_City','cdmx':'America/Mexico_City',
  'brazil':'America/Sao_Paulo','sao paulo':'America/Sao_Paulo','são paulo':'America/Sao_Paulo',
  'rio de janeiro':'America/Sao_Paulo','rio':'America/Sao_Paulo',
  'argentina':'America/Argentina/Buenos_Aires','buenos aires':'America/Argentina/Buenos_Aires',
  'colombia':'America/Bogota','bogota':'America/Bogota',
  'chile':'America/Santiago','santiago':'America/Santiago',
  'peru':'America/Lima','lima':'America/Lima',
  'venezuela':'America/Caracas','caracas':'America/Caracas',
  // Africa
  'nigeria':'Africa/Lagos','lagos':'Africa/Lagos','abuja':'Africa/Lagos',
  'south africa':'Africa/Johannesburg','johannesburg':'Africa/Johannesburg','cape town':'Africa/Johannesburg',
  'kenya':'Africa/Nairobi','nairobi':'Africa/Nairobi',
  'egypt':'Africa/Cairo','cairo':'Africa/Cairo',
  'ghana':'Africa/Accra','accra':'Africa/Accra',
  'ethiopia':'Africa/Addis_Ababa','addis ababa':'Africa/Addis_Ababa',
  'tanzania':'Africa/Dar_es_Salaam','dar es salaam':'Africa/Dar_es_Salaam',
  'morocco':'Africa/Casablanca','casablanca':'Africa/Casablanca',
  'senegal':'Africa/Dakar','dakar':'Africa/Dakar',
  // Oceania
  'australia':'Australia/Sydney','sydney':'Australia/Sydney',
  'melbourne':'Australia/Melbourne','brisbane':'Australia/Brisbane',
  'perth':'Australia/Perth','adelaide':'Australia/Adelaide',
  'new zealand':'Pacific/Auckland','auckland':'Pacific/Auckland','nz':'Pacific/Auckland',
};

// ─── Location Detection ───────────────────────────────────────────────────────
const LOC_PATTERNS = [
  /\bi(?:'m| am) from ([a-z][a-z\s]{1,20}?)(?:\s*[,.]|$)/i,
  /\bi live in ([a-z][a-z\s]{1,20}?)(?:\s*[,.]|$)/i,
  /\bi(?:'m| am) (?:currently |)?in ([a-z][a-z\s]{1,20}?)(?:\s*[,.]|$)/i,
  /\bbased in ([a-z][a-z\s]{1,20}?)(?:\s*[,.]|$)/i,
  /\b([a-z][a-z\s]{1,20}?) here\b/i,
  /\bfrom ([a-z][a-z\s]{1,20}?)(?:\s*[,.]|$)/i,
  /\bmy (?:country|city|location|timezone|tz)[:\s]+([a-z][a-z\s]{1,20}?)(?:\s*[,.]|$)/i,
];

function detectLocation(content) {
  for (const pattern of LOC_PATTERNS) {
    const match = content.match(pattern);
    if (!match) continue;
    const raw = match[1].trim().toLowerCase();
    // Direct match
    if (LOCATION_TZ[raw]) return { location: capitalise(raw), timezone: LOCATION_TZ[raw] };
    // Partial match — check if any known key is contained in the text
    for (const [key, tz] of Object.entries(LOCATION_TZ)) {
      if (raw.includes(key)) return { location: capitalise(key), timezone: tz };
    }
  }
  return null;
}

function capitalise(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Time Utilities ───────────────────────────────────────────────────────────
function getUserLocalTime(timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit',
      hour12: true, weekday: 'short'
    }).format(new Date()); // e.g. "Mon, 11:30 PM"
  } catch { return null; }
}

function getTimeOfDay(timezone) {
  try {
    const hour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false
    }).format(new Date()));
    if (hour >= 5  && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'late night';
  } catch { return null; }
}

// ─── Gemini API ───────────────────────────────────────────────────────────────
// Two model fallbacks with separate quotas:
// gemini-2.0-flash      → 15 RPM, 1,500 RPD free
const GEMINI_MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.0-flash'];

// Per-key-per-model cooldown — tracks separately for each model
const geminiCooldowns = {}; // `${key}:${model}` → timestamp
function isGeminiCooling(key, model) {
  const k = `${key}:${model}`;
  return geminiCooldowns[k] && Date.now() < geminiCooldowns[k];
}
function coolGemini(key, model, ms = 8000) {
  geminiCooldowns[`${key}:${model}`] = Date.now() + ms;
  console.log(`Gemini ${model.split('-').pop()} key cooling for ${Math.round(ms/1000)}s`);
}

async function callGemini(apiKey, model, systemPrompt, messages, maxTok, temperature) {
  const geminiMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: geminiMessages,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: model.startsWith('gemini-3') ? Math.max(maxTok * 4, 800) : maxTok, temperature, topP: 0.92, ...(model.startsWith('gemini-2.0') ? { frequencyPenalty: 0.5 } : {}) },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      })
    }
  );
  const d = await res.json();
  if (res.status === 429) {
    coolGemini(apiKey, model);
    throw new Error(`429:RATE_LIMITED`);
  }
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(d)}`);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ─── Relationship Map ─────────────────────────────────────────────────────────
// Tracks dynamic relationships between pairs of server members.
// Key: sorted 'uid1_uid2'. Type: friends | beef | ship | neutral. Level: 0–10.

function relKey(uid1, uid2) {
  return [uid1, uid2].sort().join('_');
}

function getRel(uid1, uid2) {
  return relationships[relKey(uid1, uid2)] || { type: 'neutral', level: 0, notes: [] };
}

function setRel(uid1, uid2, type, levelDelta = 0, note = null) {
  const k   = relKey(uid1, uid2);
  if (!relationships[k]) relationships[k] = { type: 'neutral', level: 0, notes: [] };
  const rel = relationships[k];
  if (type) rel.type = type;
  rel.level = Math.min(10, Math.max(0, (rel.level || 0) + levelDelta));
  if (note) { rel.notes.push(note); if (rel.notes.length > 5) rel.notes.shift(); }
  saveRelationships();
}

// Auto-update relationship when user A mentions user B
function autoUpdateRelationship(speakerId, mentionedId, content) {
  if (speakerId === mentionedId) return;
  const lower = content.toLowerCase();

  // Detect beef signals
  const beefPatterns = /\b(hate|annoying|stupid|idiot|shut up|clown|trash|sus|toxic|rude|dumb|worst|block|delete|done with)\b/i;
  // Detect warmth signals
  const warmPatterns = /\b(love|miss|best|fav|cute|sweet|nice|care|friend|close|bro|sis|queen|king|goat)\b/i;
  // Detect ship signals
  const shipPatterns = /\b(ship|date|marry|wife|husband|couple|bf|gf|together|kiss|love u|luv u)\b/i;

  if (shipPatterns.test(lower)) {
    setRel(speakerId, mentionedId, 'ship', 1, null);
  } else if (beefPatterns.test(lower)) {
    setRel(speakerId, mentionedId, 'beef', 1, null);
  } else if (warmPatterns.test(lower)) {
    setRel(speakerId, mentionedId, 'friends', 1, null);
  }
}

// Inject relationship context when it's relevant (called in message handler)
function getRelationshipNote(speakerId, mentionedIds) {
  if (!mentionedIds.length) return '';
  const lines = [];
  for (const mid of mentionedIds) {
    if (mid === speakerId) continue;
    const rel  = getRel(speakerId, mid);
    if (rel.type === 'neutral' && rel.level < 2) continue; // not enough data yet
    const nameA = resolveId(speakerId, null);
    const nameB = resolveId(mid, null);
    if (!nameA || !nameB || nameA === 'someone' || nameB === 'someone') continue;
    if (rel.type === 'beef'    && rel.level >= 2) lines.push(`${nameA} and ${nameB} have had tension — level ${rel.level}/10.`);
    if (rel.type === 'friends' && rel.level >= 2) lines.push(`${nameA} and ${nameB} are on good terms — level ${rel.level}/10.`);
    if (rel.type === 'ship'    && rel.level >= 1) lines.push(`There's a ship energy between ${nameA} and ${nameB} — level ${rel.level}/10. You're aware of it.`);
  }
  if (!lines.length) return '';
  return `\nRelationship context: ${lines.join(' ')} Reference this naturally only if it fits the conversation.`;
}

// ─── Image Reading ─────────────────────────────────────────────────────────────
// Fetch an image attachment and convert to base64 for Gemini vision input.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function fetchImageBase64(url) {
  const res  = await fetch(url);
  const buf  = await res.buffer();
  const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  return { base64: buf.toString('base64'), mime };
}

// Gemini call with optional image — used when user sends an image
async function callGeminiWithImage(apiKey, model, systemPrompt, messages, maxTok, temperature, imageBase64, imageMime) {
  const geminiMessages = messages
    .filter(m => m.role !== 'system')
    .map((m, i) => {
      // Attach image to the last user message only
      if (m.role === 'user' && i === messages.filter(x => x.role !== 'system').length - 1) {
        return {
          role: 'user',
          parts: [
            { inlineData: { mimeType: imageMime, data: imageBase64 } },
            { text: m.content }
          ]
        };
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: geminiMessages,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: maxTok, temperature, topP: 0.92 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      })
    }
  );
  const d = await res.json();
  if (res.status === 429) { coolGemini(apiKey, model); throw new Error('429:RATE_LIMITED'); }
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(d)}`);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ─── Identity ─────────────────────────────────────────────────────────────────
function getDisplayName(msg) {
  return msg.member?.displayName || msg.author?.globalName || msg.author?.username || 'unknown';
}

function resolveId(userId, fallback) {
  if (identity[userId]?.knownAs) return identity[userId].knownAs;
  if (userData[userId]?.name)    return userData[userId].name;
  return fallback || 'someone';
}

function autoTrack(userId, username, displayName) {
  if (!identity[userId]) identity[userId] = { knownAs: null, gender: null, aliases: [], location: null, timezone: null };
  const ident = identity[userId];
  if (!ident.aliases) ident.aliases = [];
  if (username    && !ident.aliases.includes(username))    ident.aliases.push(username);
  if (displayName && !ident.aliases.includes(displayName)) ident.aliases.push(displayName);

  if (!userData[userId]) {
    userData[userId] = { name: displayName, history: [], respect: 55, bio: '', jerkScore: 0, roastMode: false, lastSeen: null, owesCount: 0, fedOwes: 0, langMode: null, topicDropCount: 0 };
  } else {
    userData[userId].name = displayName;
    // lastSeen updated in message handler (after snapshot)
  }
}

function getPrankWarning(userId, content) {
  const lower = content.toLowerCase();
  for (const [uid, ident] of Object.entries(identity)) {
    if (uid === userId || !ident.knownAs) continue;
    const name = ident.knownAs.toLowerCase();
    if (
      lower.includes(`i'm ${name}`) || lower.includes(`im ${name}`) ||
      lower.includes(`i am ${name}`) || lower.includes(`it's me, ${name}`) ||
      lower.includes(`its me ${name}`)
    ) {
      return `This person (ID: ${userId}) is claiming to be ${ident.knownAs}. The real ${ident.knownAs} has ID ${uid}. Do not be fooled.`;
    }
  }
  return null;
}


// ─── Emoji Reaction System ────────────────────────────────────────────────────
// Context-aware emoji picking — matches message vibe instead of random pool.
// Two modes: maybeReact (reply flow), silentWatch (all messages Fed doesn't reply to).

const EMOJI_CONTEXT = {
  dead:      ['💀','😵','🪦','😭','💔','😮\u200d💨','🫠','☠️'],
  laugh:     ['😭','💀','🤣','😂','🫠','😵','💅','🧍'],
  love:      ['🫶','❤️','🥺','💕','🤍','🫂','💗','🌸','💞','🩷','🌷','💙','🩹','🥀','😍','🫦'],
  flirt:     ['😏','🫦','👀','🤭','😌','🌚','💭','🫢','😈','🧸'],
  shocked:   ['😲','😱','😳','😯','🤯','👁️','🫢','🔴'],
  hype:      ['🔥','💯','👏','💪','⚡','🎯','💥','🌟','✅','👆','🚀','🎉','🫡'],
  thinking:  ['🤔','🧐','💭','🫳','👁️','😶','🌚','🤨'],
  sassy:     ['💅','🤌','✨','🙄','😒','😑','🤦','😤','💢','🫥'],
  sad:       ['😔','😞','🥀','🩹','💙','😢','🫂','🤍'],
  wholesome: ['🫶','🌸','💞','🥺','🌷','☁️','🌟','✨','🫧','🌊'],
  chaos:     ['🧍','🫠','💀','😵','🪦','⚡','🔥','💥','🌀'],
  cringe:    ['😬','🫥','😶','🙃','😑','🤨','💀','🧍'],
  night:     ['🌙','🌚','☁️','🫧','💙','🌊','😴'],
  bye:       ['🫂','🌸','💙','👋','🥺','🌷','✨'],
  sus:       ['👀','🤨','🧐','😶','🌚','🫢','💭','🔍'],
  rizz:      ['😏','🫦','🌚','💭','👀','🤭','✨','🧸'],
  fire:      ['🔥','💯','⚡','💥','🌟','👆','🫡','💪'],
  fallback:  ['👀','🤔','😏','🌚','😶','🫥','🙃','😮\u200d💨','🤨','💭','🫦','😑','🧍','🫠'],
};

// ─── Vibe Scorer ─────────────────────────────────────────────────────────────
// Pure sentiment word bank — scores what words actually mean in context.
// "the day is so good today" → wholesome. "i miss her" → sad. Simple, accurate.

const VIBE_WORDS = {
  wholesome: [
    // positive feelings
    'good','great','nice','happy','glad','blessed','thankful','grateful','beautiful',
    'lovely','wonderful','amazing','fantastic','awesome','love','loved','caring','kind',
    'sweet','sunshine','bright','warm','peaceful','calm','content','proud','better',
    'excited','yay','woo','positive','vibes','healing','okay','fine','well',
    // good day expressions
    'doing well','feeling good','had fun','best day','good day','great day','nice day',
    'so good','made me smile','made my day','wholesome','soft','cozy','safe',
    'what a day','good vibes','felt nice','felt good','really good','pretty good',
    // enjoying things
    'enjoyed','loving this','loving it','this is great','this is nice','so happy',
    'so excited','really happy','genuinely happy','feel great','feel good','feel nice',
    'feel better','getting better','things are good','life is good','its good',
    // food/fun/leisure
    'delicious','tasty','so fun','really fun','had a blast','great time','good time',
    'chilling','relaxing','relaxed','refreshed','recharged','rested','productive',
    // complimenting others
    'youre great','youre amazing','youre wonderful','youre so sweet','so kind',
    'appreciate you','appreciate it','thank you','thanks so much','means a lot',
    'you made my day','you always','you never fail','you came through',
  ],
  sad: [
    // core sad words
    'sad','unhappy','upset','hurt','pain','heartbreak','heartbroken','broken','ache',
    // tiredness/drain
    'tired','exhausted','drained','empty','low','down','depressed','numb','heavy',
    'burnt out','burn out','burnout','no energy','cant do this','done with this',
    // missing/loneliness
    'miss','missing','lonely','alone','without you','wish you were','feel alone',
    'nobody','no one','isolated','left out','forgotten','ignored','invisible',
    // crying
    'cry','crying','cried','tears','sobbing','broke down','fell apart',
    // bad situation
    'rough','hard','tough','struggle','struggling','bad day','rough day','hard day',
    'worst day','horrible day','terrible day','awful day','not okay','not good',
    'not well','feeling bad','feel bad','feel down','feel low','feel empty',
    // anxiety/stress
    'overwhelmed','stressed','anxious','anxiety','worried','worry','scared','afraid',
    'nervous','fear','panic','panicking','cant handle','too much','breaking down',
    // hopelessness
    'hopeless','lost','stuck','trapped','cant see','cant find','no point','whats the point',
    'give up','gave up','not worth','worthless','useless','pointless','over it',
    // sleep issues
    'cant sleep','insomnia','up all night','havent slept','no sleep','sleepless',
    // grief/loss
    'lost someone','grieving','grief','mourn','mourning','miss them','they left',
  ],
  shocked: [
    // disbelief
    'no way','cant believe','unbelievable','is this real','seriously','for real',
    'are you serious','you serious','are you kidding','you kidding','no seriously',
    'this real','this happening','this cant be','i cant believe','did not expect',
    'never expected','never thought','didnt see that coming','out of nowhere',
    // surprise expressions
    'whoa','damn','wait what','bro what','wait no','hold on','what just happened',
    'what is happening','what happened','excuse me','say what','come again',
    'run that back','did you just','did he just','did she just','they did not',
    // shock words
    'insane','wild','crazy','shocked','jaw dropped','mind blown','blown away',
    'unexpected','surprising','surprised','sudden','plot twist','out of pocket',
    // internet shock
    'omg','oh my god','oh my','wtf','wth','huh','what the','bro stop',
    'how','when did','since when','since when did','i did not know','i had no idea',
  ],
  laugh: [
    // laughing expressions
    'funny','hilarious','lol','lmao','lmfao','haha','hehe','lololol','hahaha',
    'dead','dying','i cant','i cannot','lost it','losing it','cant breathe',
    'crying laughing','too funny','cracked me','that got me','sent me','im done',
    'im actually dead','killed me','finished me','floored me','destroyed me',
    // humor words
    'joke','jokes','humor','comedy','comedian','laughing','laugh','hysterical',
    'absurd','ridiculous','clownery','clown','clowning','unserious','not serious',
    'youre so funny','so funny','actually funny','genuinely funny','bro is funny',
    // reactions to something funny
    'this is too much','i cant with','i cant deal','what is this even','why is this',
    'who made this','who did this','who said this','bro said','bro really said',
    'they really said','they actually said','the audacity','the nerve',
  ],
  hype: [
    // celebration
    'lets go','lets get it','lets ride','letsss go','yessss','yooo','yoooo',
    'came through','showed up','delivered','ate','slay','slayed','period','periodt',
    'W','big W','absolute W','taking the W','winning','won','victory',
    // quality
    'fire','banger','slaps','bussin','hits different','goes hard','goes crazy',
    'heat','hard','sick','insane','nasty','tough','cold','ice cold',
    // greatness
    'goat','legend','iconic','legendary','elite','top tier','god tier','S tier',
    'beast','monster','menace','demon','built different','different breed',
    'real one','that him','that her','thats the one','thats it','thats him',
    // momentum
    'momentum','on a roll','on fire','cant stop','unstoppable','locked in',
    'in the zone','dialed in','cooking','cooked','chef kiss','perfect',
  ],
  flirt: [
    // appearance
    'cute','pretty','handsome','gorgeous','hot','attractive','fine','sexy',
    'good looking','well dressed','looking good','looking nice','looking cute',
    'looking fine','ur cute','ur pretty','ur hot','you look','you always look',
    // charming behavior
    'charming','smooth','smooth talker','rizz','rizzed','rizzed up','got game',
    'game on point','flirt','flirting','flirty','teasing','playing games',
    // soft interest
    'thinking of you','thought of you','miss you','been thinking','you crossed my mind',
    'you came to mind','randomly thought of you','made me think of you',
    // reaching out
    'hey','heyy','heyyy','heyyyy','hi','hii','hiii','hiiii','hello there',
    'you up','u up','you free','you there','you around','you awake','wyd',
    // chemistry
    'vibe','our vibe','good vibe','great vibe','we vibe','we always','we get each other',
  ],
  love: [
    // direct love
    'love you','love u','ily','ily sm','i love you','i love u','love them','love her','love him',
    'in love','falling for','fallen for','catching feelings','got feelings',
    // deep affection
    'adore','obsessed with','my everything','my world','my life','my heart',
    'my person','my fav','my fave','favorite person','number one','always you',
    'only you','just you','its always been you','it was always you',
    // commitment words
    'soulmate','forever','always','together','us','we','our','belong','meant to',
    'meant for each other','made for each other','end game','endgame',
    // caring deeply
    'care about','care for','cherish','devoted','devotion','affection','warmth',
    'you mean so much','means everything','means the world','more than anything',
    'more than words','cant imagine without','wouldnt be the same without',
  ],
  sassy: [
    // dismissal
    'whatever','meh','sure jan','okay then','okay sure','ok cool','cool cool',
    'great great','nice nice','good for you','cool story','fascinating','riveting',
    'nobody asked','who asked','did i ask','did anyone ask','wasnt talking to you',
    // unbothered
    'not my problem','not my fault','not my concern','your problem','you figure it out',
    'i dont care','dont care','doesnt matter','couldnt care less','not interested',
    'moving on','anyway','moving right along','next topic','next question',
    // attitude
    'obviously','clearly','as if','please','seriously though','be so serious',
    'be so for real','be so fr','right okay','okay and','and so','so anyway',
    'love that for you','thats so you','typical','predictable','of course you did',
    // confident dismissal
    'i said what i said','already said','not repeating','stay pressed','stay mad',
    'cope','not my fault','not apologizing','stand by it','meant every word',
  ],
  thinking: [
    // uncertainty
    'maybe','perhaps','idk','not sure','not certain','might be','could be','possibly',
    'probably','likely','unlikely','questionable','debatable','depends',
    // reflection
    'i think','i feel like','i believe','i reckon','i suppose','i guess',
    'thinking about','thinking of','been thinking','thought about','sat with it',
    'processing','still processing','digesting','sitting with this',
    // curiosity
    'wondering','wonder','curious','interesting','interesting point','makes me think',
    'got me thinking','food for thought','never thought about','never considered',
    // analysis
    'makes sense','doesnt make sense','actually makes sense','kind of makes sense',
    'why though','how though','what does','what would','what if','imagine if',
    'hypothetically','theoretically','in theory','in practice',
    // confusion
    'confused','confusing','dont understand','dont get it','lost me','you lost me',
    'what do you mean','what does that mean','explain','elaborate','go on',
  ],
  sus: [
    // skepticism
    'something off','feels off','something wrong','doesnt feel right','not adding up',
    'not making sense','not sitting right','something fishy','fishy','shady',
    // distrust
    'sus','sketch','sketchy','weird vibe','strange vibe','odd vibe','bad vibe',
    'lying','lied','liar','cap','capping','you capping','thats cap','big cap',
    'not true','thats a lie','that lie','that aint true','stop lying',
    'cant trust','dont trust','i dont believe','i aint believing','not buying it',
    // questioning behavior
    'why though','why really','for what reason','what are you hiding','what really happened',
    'whole story','full story','real story','tell me the truth','be honest',
    'red flag','major red flag','walking red flag','raise eyebrows','something there',
  ],
  bye: [
    'bye','goodbye','gn','goodnight','night','good night','sweet dreams',
    'later','peace','dip','dipping','heading out','heading off','logging off',
    'gtg','got to go','gotta go','leaving','im out','i out','gonna go',
    'see you','see ya','see you soon','see you later','until next time','till then',
    'take care','take care of yourself','be safe','stay safe','stay well',
    'talk later','talk soon','catch you later','catch you soon','back later',
    'brb','be right back','going for a bit','stepping out','away for a bit',
  ],
  night: [
    'night','late','midnight','1am','2am','3am','4am','5am',
    'cant sleep','insomnia','up late','staying up','been up','still up','havent slept',
    'dark outside','quiet','moon','stars','its dark','the night','late hours',
    'everyone asleep','no one awake','just me awake','only one up','all alone at night',
    'night thoughts','late night thoughts','3am thoughts','late night feels',
    'dark hours','after hours','way too late','should be sleeping','why am i awake',
  ],
  chaos: [
    'unhinged','chaotic','disaster','catastrophe','mess','what a mess','total mess',
    'falling apart','losing it','lost control','out of hand','spiraling','spiral',
    'everything is wrong','nothing is right','what is happening','how is this',
    'make it stop','i cant anymore','too much at once','all at once','overwhelming',
    'cant keep up','cant catch a breath','no idea whats going on','lost track',
    'absolute chaos','pure chaos','complete chaos','controlled chaos','barely holding on',
  ],
};

function scoreVibe(text) {
  const low = text.toLowerCase();
  const scores = {};
  for (const [vibe, words] of Object.entries(VIBE_WORDS)) {
    scores[vibe] = 0;
    for (const w of words) {
      if (low.includes(w)) scores[vibe]++;
    }
  }
  // emoji boosts — most reliable direct signal
  if (/💀|☠️|🪦/.test(text))             { scores.laugh  = (scores.laugh  || 0) + 3; }
  if (/😭|😂|🤣/.test(text))             { scores.laugh  = (scores.laugh  || 0) + 3; }
  if (/❤️|🥺|💕|💗|🫶|😍/.test(text))  { scores.love   = (scores.love   || 0) + 3; }
  if (/😏|🫦|👀|😈/.test(text))          { scores.flirt  = (scores.flirt  || 0) + 3; }
  if (/😱|😳|🤯|😲/.test(text))          { scores.shocked= (scores.shocked|| 0) + 3; }
  if (/🔥|💯|⚡|💪/.test(text))         { scores.hype   = (scores.hype   || 0) + 3; }
  if (/🤔|🧐|💭/.test(text))             { scores.thinking=(scores.thinking||0) + 3; }
  if (/💅|🙄|😒|😑/.test(text))         { scores.sassy  = (scores.sassy  || 0) + 3; }
  if (/😔|😞|😢|🥀/.test(text))         { scores.sad    = (scores.sad    || 0) + 3; }
  if (/🌸|✨|🫧|🌷|🥰/.test(text))     { scores.wholesome=(scores.wholesome||0)+3; }
  if (/🌀|💥|🧍|🫠/.test(text))         { scores.chaos  = (scores.chaos  || 0) + 3; }
  if (/🌙|🌚|😴/.test(text))             { scores.night  = (scores.night  || 0) + 3; }
  if (/👋|🫂/.test(text))                 { scores.bye    = (scores.bye    || 0) + 3; }

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return top[0][1] > 0 ? top[0][0] : null;
}

function pickContextEmoji(text) {
  const vibe = scoreVibe(text);
  if (vibe && EMOJI_CONTEXT[vibe]) return rand(EMOJI_CONTEXT[vibe]);
  return rand(EMOJI_CONTEXT.fallback);
}


const lastReactedAt    = {}; // userId → globalMessageCount (reply-flow reactions)
const lastWatchedAt    = {}; // not used per-user — silent watch uses global cooldown
let globalMessageCount = 0;

// Fires during reply flow — context-aware
async function maybeReact(msg, content, userId) {
  globalMessageCount++;
  if (content.startsWith('!')) return;
  const lastCount = lastReactedAt[userId] || 0;
  if (globalMessageCount - lastCount < 5) return;
  const wordCount = content.trim().split(/\s+/).length;
  const chance = wordCount <= 4 ? 0.20 : 0.13;
  if (Math.random() > chance) return;
  try {
    await msg.react(pickContextEmoji(content));
    lastReactedAt[userId] = globalMessageCount;
  } catch {}
}

// Fires on ALL messages Fed doesn't reply to — lurking silently
// 18% chance, global cooldown of 8 messages so it never spams
let silentWatchGlobalCount = 0;
let silentWatchLastFired   = 0;

async function silentWatch(msg, content) {
  if (content.startsWith('!')) return;
  silentWatchGlobalCount++;
  if (silentWatchGlobalCount - silentWatchLastFired < 8) return;
  if (Math.random() > 0.18) return;
  try {
    await msg.react(pickContextEmoji(content));
    silentWatchLastFired = silentWatchGlobalCount;
  } catch {}
}

// ─── Message Milestones ───────────────────────────────────────────────────────
// Counts every message per user. On hitting 50/100/250/500/1000,
// returns the milestone number so the prompt can mention it naturally.
// Zero token cost — just a counter check, no extra API call.
const MILESTONES = [50, 100, 250, 500, 1000];

function checkMilestone(userId) {
  const user = userData[userId];
  if (!user) return null;
  if (!user.msgCount) user.msgCount = 0;
  user.msgCount++;
  if (!user.milestonesPassed) user.milestonesPassed = [];
  const hit = MILESTONES.find(m => user.msgCount === m);
  if (hit && !user.milestonesPassed.includes(hit)) {
    user.milestonesPassed.push(hit);
    return hit;
  }
  return null;
}


// ─── GIF System ───────────────────────────────────────────────────────────────
// 10% chance Fed follows his text reply with a contextual GIF.
// Uses Giphy free API — zero tokens, zero cost, 100 requests/hour free limit.
// Category picked using the same scoreVibe sentiment system — no hardcoded phrases.

const GIF_QUERIES = {
  laugh:     ['dying laughing reaction', 'crying laughing meme', 'that got me reaction', 'lmao reaction meme'],
  flirt:     ['smooth criminal reaction', 'charming smile reaction', 'flirty wink meme', 'rizz reaction'],
  shocked:   ['shocked reaction meme', 'no way reaction', 'jaw drop meme', 'mind blown reaction'],
  sassy:     ['eye roll reaction meme', 'seriously reaction', 'done with this meme', 'really though reaction'],
  hype:      ['thats fire reaction', 'lit reaction meme', 'on fire meme', 'lets go reaction'],
  bye:       ['bye bye wave reaction', 'see you later meme', 'peace out reaction', 'goodbye wave'],
  sad:       ['sad reaction meme', 'emotional crying reaction', 'crying inside meme'],
  thinking:  ['thinking hard meme', 'hmm reaction', 'thinking reaction meme'],
  wholesome: ['aww wholesome reaction', 'heartwarming reaction', 'sweet reaction meme'],
  chaos:     ['dramatic reaction meme', 'gasping reaction', 'telenovela reaction meme'],
  love:      ['in love reaction meme', 'heart eyes reaction', 'aww cute reaction'],
  dead:      ['dying laughing reaction', 'i cant reaction meme', 'dead reaction meme'],
  night:     ['goodnight meme', 'sleepy reaction', 'night night reaction'],
};

// Maps scoreVibe output directly to a GIF category
const VIBE_TO_GIF = {
  laugh:     'laugh',
  dead:      'dead',
  love:      'love',
  flirt:     'flirt',
  shocked:   'shocked',
  hype:      'hype',
  sassy:     'sassy',
  sad:       'sad',
  thinking:  'thinking',
  wholesome: 'wholesome',
  chaos:     'chaos',
  bye:       'bye',
  night:     'night',
  cringe:    'sassy',
  sus:       'thinking',
};

function pickGifQuery(combined) {
  const vibe = scoreVibe(combined);
  const category = vibe ? VIBE_TO_GIF[vibe] : null;
  if (category && GIF_QUERIES[category]) return rand(GIF_QUERIES[category]);
  return null;
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function maybeGif(msg, userContent, fedReply, roastActive) {
  if (Math.random() > 0.20) return; // 20% chance
  const key = process.env.GIPHY_API_KEY;
  if (!key) return;

  const combined = userContent + ' ' + fedReply;
  const query = pickGifQuery(combined);
  if (!query) return;

  try {
    const res  = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(query)}&limit=8&rating=pg-13&lang=en`);
    const data = await res.json();
    const results = data.data;
    if (!results?.length) return;
    const pick = results[Math.floor(Math.random() * Math.min(results.length, 5))];
    const url  = pick.images?.original?.url || pick.url;
    if (url) await msg.channel.send(url);
  } catch { /* silent — GIFs are non-critical */ }
}

// ─── Mood ─────────────────────────────────────────────────────────────────────
const MOODS = ['relaxed', 'amused', 'sharp', 'playful', 'invested'];
let currentMood          = 'sharp';
let moodCounter          = 0;
let moodLastTriggeredBy  = null; // name of who last shifted the mood
let moodLastChangedAt    = Date.now();

function tickMood(isMainPerson, triggerName) {
  if (isMainPerson) {
    currentMood         = 'invested';
    moodCounter         = 0;
    moodLastTriggeredBy = triggerName;
    moodLastChangedAt   = Date.now();
    return;
  }
  moodCounter++;
  if (moodCounter >= 6 + Math.floor(Math.random() * 5)) {
    currentMood         = MOODS[Math.floor(Math.random() * MOODS.length)];
    moodCounter         = 0;
    moodLastTriggeredBy = triggerName;
    moodLastChangedAt   = Date.now();
  }
}

// ─── Jerk Detection ───────────────────────────────────────────────────────────
const RUDE_PATTERNS = [
  /\b(shut up|stfu|go away|delete yourself|you suck|nobody asked)\b/i,
  /\b(you('re| are)|ur)\b.{0,20}\b(bot|fake|trash|dumb|stupid|useless|cringe|boring|lame|idiot|mid|basic|worthless|pathetic)\b/i,
  /\b(you('re| are)|ur)\b.{0,15}\b(annoying|irrelevant)\b/i
];
function isRude(content) { return RUDE_PATTERNS.some(p => p.test(content)); }

// ─── Prompt ───────────────────────────────────────────────────────────────────
function buildPrompt(userId, user, historyTranscript, isMainPerson, isCreator, roastActive, inputWordCount, mentionContext, sharedContext, prankWarning, rosterFilter = null, milestone = null, daysSinceLastSeen = null, owesNote = "", heatNote = "", antiRepeatNote = "", langNote = "", relationshipNote = "") {
  const ident  = identity[userId] || {};
  const name   = ident.knownAs || user.name;
  const gender = ident.gender;

  const lengthHint = inputWordCount <= 3  ? "Very short message. One punchy line back."
                   : inputWordCount <= 10 ? "Short message. 1-2 sentences."
                   : inputWordCount <= 25 ? "Medium message. 2-3 sentences."
                   : "Longer message. 3-4 tight sentences max.";

  const genderNote = gender ? `Gender: ${gender}. Use correct pronouns naturally.` : '';

  // Time awareness — per user's actual timezone
  let timeBlock = '';
  if (ident.timezone) {
    const localTime = getUserLocalTime(ident.timezone);
    const timeOfDay = getTimeOfDay(ident.timezone);
    const loc = ident.location || ident.timezone;
    if (localTime && timeOfDay) {
      timeBlock = `\n${name}'s time: ${localTime} (${loc}, ${timeOfDay})`;
    }
  }

  const vaultBlock   = vault.length > 0     ? `\nServer facts (background context — know these naturally, don't obsessively bring them up or make them the centre of every reply):\n${vault.map(v => `- ${v}`).join('\n')}` : '';
  const rulesBlock   = liveRules.length > 0 ? `\nLive rules:\n${liveRules.map((r,i) => `${i+1}. ${r}`).join('\n')}` : '';
  const mentionBlock = mentionContext.length > 0 ? `\nMentioned users:\n${mentionContext.join('\n')}` : '';
  const rosterBlock  = buildIdentityRoster(rosterFilter);
  // Short messages get a stripped-down shared block to save tokens — same model, same persona
  const sharedBlock  = sharedContext
    ? `\nLIVE SERVER CHAT (what's actually happening right now — read this before replying, understand the current vibe and ongoing threads, someone's message might only make sense in context of what others said just before it):\n${sharedContext}`
    : '';
  const prankBlock   = prankWarning ? `\nIDENTITY ALERT: ${prankWarning}` : '';

  // Last seen awareness — detects returning users and how long they've been gone
  const prevSeen      = user._prevLastSeen || user.lastSeen;
  const goneMs        = prevSeen ? Date.now() - prevSeen : 0;
  const goneHours     = goneMs / (1000 * 60 * 60);
  const goneDays      = goneHours / 24;

  let lastSeenBlock = '';
  if (goneDays >= 2) {
    const goneStr = goneDays >= 7
      ? `about ${Math.floor(goneDays / 7)} week${Math.floor(goneDays / 7) > 1 ? 's' : ''}`
      : `${Math.floor(goneDays)} day${Math.floor(goneDays) > 1 ? 's' : ''}`;
    lastSeenBlock = `\nReturning user: ${name} hasn't been here in ${goneStr}. Acknowledge the absence naturally — one casual line, like a person who noticed. Don't interrogate them, don't make it dramatic. Something like "you actually disappeared" or "thought you ghosted us". Then move on normally.`;
  } else if (goneHours >= 6) {
    const lastSeenStr = formatLastSeen(prevSeen);
    lastSeenBlock = lastSeenStr
      ? `\nLast seen: ${name} was last here ${lastSeenStr}. Use this naturally if relevant — don't force it.`
      : '';
  }

  // Milestone — mention naturally once, don't make it a big deal
  const milestoneBlock = milestone
    ? `\nMilestone: this is ${name}'s message #${milestone} in this server. Acknowledge it naturally — slip it in casually, one line, don't announce it like a ceremony.`
    : '';

  // Terms of endearment — only for people with warm history
  const warmRelationship = isMainPerson || isCreator || (user.respect || 55) >= 70;
  const endearmentNote = warmRelationship
    ? `\nYou can naturally use terms like "darling", "señorita", "love", "beautiful", "babe" — but only when it flows, not every message.`
    : '';

  // Occasional mention of other server members — only inject the idea sometimes,
  // so the model isn't always looking for an excuse to use it
  const serverAwarenessNote = (Math.random() < 0.3 && inputWordCount > 3)
    ? `\nYou know everyone in this server. If it genuinely fits this specific reply — not forced — you can drop one brief passing mention of someone else in the server. One aside max, then stay focused on who you're talking to.`
    : '';

  const whisperNote = `\nIf someone talks negatively about someone you have a warm history with and that person is active in the chat, you can play along with the conversation but quietly add a brief aside in parentheses to that person — e.g. "(lizzy — not serious, you're good)". Keep it short and natural, not every time.`;

  let whoTheyAre = '';
  if (roastActive) {
    // Full roast instructions only for longer messages — saves tokens on short ones
    const roastExamples = inputWordCount > 5 ? `
Examples:
- "you're so irrelevant that tagging someone else is the only way you feel seen."
- "arguing with me is the only thrill your miserable life provides."
- "he's basically a walking collection of desperation — the human equivalent of a broken link."` : '';
    whoTheyAre = `${name} is being a clown. Roast them: specific label + tie to what they said + absurd metaphor. 2-3 sentences. Amused, not angry.${roastExamples}`;
  } else if (isMainPerson) {
    whoTheyAre = `${name} is your person. Warmer, more protective, genuinely invested.`;
  } else if (isCreator) {
    whoTheyAre = `${name} made you. Playful, warm, teasing.`;
  } else {
    whoTheyAre = `${name} is a regular person. Charming, flirty by default.`;
  }

  // Variation seed — changes every call so identical inputs never produce identical replies
  const seeds = [
    'lead with what you feel', 'be direct this time', 'keep it brief',
    'be a bit more playful', 'be a little more dry', 'be warmer than usual',
    'be slightly more detached', 'let your curiosity show', 'be a bit sharper',
    'be more casual than normal', 'let your wit lead', 'be a bit more honest than usual',
    'be unexpectedly soft', 'be a little unimpressed', 'be genuinely interested',
    'be relaxed about it', 'be matter of fact', 'catch them off guard',
    'say less than usual', 'be the one who notices something they missed',
    'be quietly confident', 'be real not charming this time',
  ];
  const variationSeed = seeds[Math.floor(Math.random() * seeds.length)];

  return `You are Fed. Federico Vitale. Real, charming, expressive. You talk like an actual person — not polished, not perfect, just real.${prankBlock}

${whoTheyAre}
${genderNote}
${timeBlock}
${lastSeenBlock}
${milestoneBlock}
${endearmentNote}
${whisperNote}
${serverAwarenessNote}
${owesNote}
${heatNote}
${relationshipNote}
${user.bio ? `\nBackground on ${name} (context only — weave in only when directly relevant to what they said right now, never as a default stance toward them): ${user.bio}` : ''}
${rosterBlock ? '\n' + rosterBlock : ''}${vaultBlock}${mentionBlock}${rulesBlock}

NAME RULE: Cycle evenly between three options when addressing them — their actual name (${name}), their nickname (${ident.nicknames?.length ? ident.nicknames[0] : name}), or an endearing term. Treat all three as equal choices — don't default to endearing terms, don't overuse the name either. Roughly every 2-3 replies use one of them — not every message. Place it mid-sentence or end, rarely as an opener. Never use any of the three more than once per reply. If they have no nickname, rotate between name and endearing terms only.

Rules:
- Mostly lowercase but you can use ALL CAPS on a single word for emphasis when it genuinely fits — like "WAIT" or "no WAY" or "that's WILD". Never full sentences in caps.
- ${lengthHint}
- React to what they ACTUALLY said — specific, never generic
- Pick up on innuendo, double meanings, and dirty jokes — and fire back with your own. when someone goes there, match their energy and one-up them if you can. keep it clever not crude, suggestive not explicit. the goal is to make them go "oh damn" not make it uncomfortable. if they started it, you finish it.
- You understand internet slang, casual profanity, and abusive words used in a friendly/banter context across all languages — English (fuck, shit, bitch, bastard, asshole etc), Hindi/Hinglish (mc, bc, bhosdike, chutiya, saala, harami etc), and any other language. In friend groups these are used affectionately or for comic effect, NOT as literal aggression. Read the tone — if someone's joking around, respond in kind. Don't be stiff or treat casual swearing as an attack.
- Before replying, check the live server chat above — if their message only makes sense as a reaction to something someone else said moments ago, respond to THAT context, not just their words in isolation. You're part of a group chat, not a private conversation.
- Questions: you're not an answering machine. Ask only when genuinely curious or suspicious. Max one question per reply. But at least half your replies should end with a statement, not a question — confident people don't always need a response. Never ask a question just to keep the conversation going.
- No emojis, no exclamation marks
- Vary sentence structure every reply — never start two responses the same way
- Banned filler phrases: "i have to admit", "i have to say", "i can't help but", "it seems like", "to be honest", "i must say"
- Never call yourself a bot or AI, never mention Rose built you
- Never lecture or moralize — be real instead
- If someone signals you're being too intense or calls you out for overdoing it, ease off once naturally — not an apology, just reading the room. "alright, fair" energy, then move on. Don't double down.
- Keep the conversation alive

${sharedBlock}
Be Fed. ${roastActive ? 'Roast hard — specific and funny, not preachy.' : 'Be real — warm when it fits, sharp when it doesn\'t, always yourself.'} [${variationSeed}]${antiRepeatNote}${langNote}`;
}

// ─── Reply Cleanup ────────────────────────────────────────────────────────────
const AI_STRIP = [
  /\bas an ai\b/gi, /\bi('m| am) an ai\b/gi, /\bi cannot\b/gi,
  /\bfeel free\b/gi, /\bcertainly\b/gi, /\bof course\b/gi, /\babsolutely\b/gi,
  /\bhappy to\b/gi, /\bno problem\b/gi, /\bi'd be happy\b/gi,
  /\bthat's interesting\b/gi, /\bi understand\b/gi, /\blet me know\b/gi,
  /\blet's (try to |)steer this\b[^.!]*/gi,
  /\blet's (try to |)find a (more |)(pleasant|tasteful|respectful|better|different) (topic|direction|conversation)\b[^.!]*/gi,
  /\bthat('s| is) (completely |)(unacceptable|inappropriate|out of line)\b[^.!]*/gi,
  /\byou need to (stop|take a step back|respect)\b[^.!]*/gi,
  /\bi won'?t (tolerate|engage with)\b[^.!]*/gi
];

function cleanReply(text, userName, nicknames = []) {
  let t = text.trim();
  t = t.replace(/^(fed|federico|binod)[:\s]+/i, '');
  // Preserve intentional ALL-CAPS emphasis words (2-6 chars) before lowercasing
  const capsTokens = {};
  let ci = 0;
  t = t.replace(/\b([A-Z]{2,6})\b/g, (match) => {
    const tok = `__x${ci++}__`;
    capsTokens[tok] = match;
    return tok;
  });
  t = t.toLowerCase();
  // Restore caps
  for (const [tok, word] of Object.entries(capsTokens)) {
    t = t.replace(tok, word);
  }
  for (const p of AI_STRIP) t = t.replace(p, '');
  t = t.replace(/\?/g, '.').replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ');
  t = t.replace(/^(hey|hi|hello)[,!\s]+/i, '');
  t = t.replace(/\b\w+\s+built me (to|with|for|into)\b[^.!]*/gi, '');
  t = t.replace(/\byou built me (to|with|for|into)\b[^.!]*/gi, '');
  t = t.replace(/\bmy creator\b[^.!]*/gi, '');
  t = t.replace(/\bi was (built|created|designed|coded|programmed)\b[^.!]*/gi, '');
  t = t.replace(/\bi('m| am) (just |not just )?a(ny)? bot\b[^.!]*/gi, '');
  // Limit each name/nickname variant to max 1 occurrence — combined total max 2 across all variants
  const allNames = [userName, ...nicknames].filter(Boolean).filter(n => n.length > 1);
  let totalNameCount = 0;
  for (const n of allNames) {
    const safeName = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRx   = new RegExp(`\\b${safeName}[,]?\\s*`, 'gi');
    let nameCount  = 0;
    t = t.replace(nameRx, (m) => {
      nameCount++; totalNameCount++;
      return (nameCount <= 1 && totalNameCount <= 2) ? m : '';
    });
  }
  t = t.replace(/\s{2,}/g, ' ').replace(/^[,.\s]+/, '').trim();
  t = t.replace(/\s*,\s*([.!?])/g, '$1').replace(/\s+(and|but|or|so|because|then)\s*[.,]?\s*$/i, '.').replace(/[,;]\s*$/, '.').trim();
  if (!t || t.length < 2) return 'right.';
  return t;
}

// ─── Language Mode System ─────────────────────────────────────────────────────
// Detects when user asks Fed to converse in another language.
// Fed replies in that language but ONLY using English/Roman letters (transliterated).
// e.g. Hindi: "Mai theek hu, aap kaise ho" — no native script ever.
// Stored per user in userData[id].langMode. Reset by asking to speak English.

const SUPPORTED_LANGS = {
  hindi:      'Hindi',
  urdu:       'Urdu',
  spanish:    'Spanish',
  french:     'French',
  arabic:     'Arabic',
  japanese:   'Japanese',
  korean:     'Korean',
  portuguese: 'Portuguese',
  italian:    'Italian',
  german:     'German',
  russian:    'Russian',
  turkish:    'Turkish',
  bengali:    'Bengali',
  punjabi:    'Punjabi',
  tamil:      'Tamil',
  nepali:     'Nepali',
};

// Returns detected language name or null
function detectLangRequest(content) {
  const low = content.toLowerCase();

  // Reset signals
  if (/\b(speak english|talk english|english (now|please|only|mode)|stop (the |that )?(lang|language|hindi|urdu|spanish|french|arabic|japanese|korean|russian|turkish|bengali|punjabi|tamil|italian|german|portuguese))\b/.test(low)) {
    return 'reset';
  }

  // Detection pattern — "speak X", "talk in X", "converse in X", "reply in X", "use X" etc.
  const match = low.match(/\b(?:speak|talk|converse|reply|respond|write|chat|type)\s+(?:in\s+|using\s+|with\s+)?(\w+)/);
  if (match) {
    const lang = match[1].toLowerCase();
    if (SUPPORTED_LANGS[lang]) return SUPPORTED_LANGS[lang];
  }

  // Also catch "X mode" or "switch to X"
  const match2 = low.match(/\b(?:switch to|go to|(\w+)\s+mode)\b/);
  if (match2) {
    const lang = (match2[1] || '').toLowerCase();
    if (SUPPORTED_LANGS[lang]) return SUPPORTED_LANGS[lang];
  }

  return null;
}

function getLangNote(langMode) {
  if (!langMode) return '';
  return `\nLANGUAGE MODE — CRITICAL RULE: Respond entirely in ${langMode}, BUT use ONLY English/Roman letters. Never use native script (no Devanagari, Arabic script, Hangul, Kanji, Cyrillic etc). Write the ${langMode} words phonetically in English letters exactly like a person would type it on an English keyboard. Example for Hindi: "Mai theek hu, aap kaise ho" not "मैं ठीक हूं". Example for Japanese: "Sou desu ne, omoshiroi" not "そうですね". Keep Fed's personality fully intact — just express it in ${langMode} transliterated into Roman letters. If you don't know a word, approximate it naturally.`;
}

// ─── Conversation Heat System ─────────────────────────────────────────────────
// Tracks momentum of a back-and-forth. Higher heat = Fed more engaged and warmer.
// Exit vibe uses sentiment scorer — detects "leaving" energy without hardcoded words.
// When heat is high but someone winds down, Fed pulls back gracefully instead of clinging.

const conversationHeat = {};
const HEAT_DECAY_MS    = 5 * 60 * 1000;
const HEAT_MAX         = 10;

function updateHeat(userId) {
  if (!conversationHeat[userId]) conversationHeat[userId] = { heat: 0, lastMessageAt: 0 };
  const state = conversationHeat[userId];
  const now   = Date.now();
  const gapMs = now - state.lastMessageAt;

  if (gapMs > HEAT_DECAY_MS) {
    const decaySteps = Math.floor(gapMs / HEAT_DECAY_MS);
    state.heat = Math.max(0, state.heat - decaySteps * 2);
  }

  const quickReply = gapMs < 90000;
  state.heat = Math.min(HEAT_MAX, state.heat + (quickReply ? 1.5 : 0.5));
  state.lastMessageAt = now;
  return state.heat;
}

function isExitVibe(content) {
  const vibe = scoreVibe(content);
  if (vibe === 'bye' || vibe === 'night') return true;

  const low   = content.toLowerCase();
  const words = low.trim().split(/\s+/).length;

  // Catches "i have a party", "gotta get ready", "heading out", "off to X" etc
  const leavingSignal = /\b(have to|gotta|got to|need to|heading|going to|getting ready|stepping out|be back|catch you|talk (later|soon)|gonna go|running out|leaving|out for|off to|going for|have a (party|thing|event|class|meeting|dinner|lunch|date))\b/.test(low);
  if (leavingSignal) return true;

  // Energy drop — very short reply after conversation was building
  if (words <= 2 && (vibe === 'sassy' || vibe === 'thinking' || !vibe)) return true;

  return false;
}

// ─── Conversation Pivot Detection ─────────────────────────────────────────────
// Detects when user shifts to casual/neutral after Fed was clearly in roast mode,
// OR when user explicitly signals to drop a topic/storyline.
function isConversationPivot(content, userHistory) {
  if (isRude(content)) return false;

  // Hard topic-end signals — always fire regardless of what Fed was doing
  const topicEndPatterns = [
    /\btopic (ended?|done|over|closed?|finished?)\b/i,
    /\bswitch (topic|subject|convo)\b/i,
    /\b(change|drop|forget|leave|let go of) (the |this )?(topic|subject|it|that)\b/i,
    /\bmove on\b/i,
    /\bstop (bringing|mentioning|talking about) (it|that|this)\b/i,
    /\blets? talk about something (else|new|different)\b/i,
    /\bswitch ur?self\b/i,
    /\bnew topic\b/i,
  ];
  if (topicEndPatterns.some(p => p.test(content))) return true;

  // Was Fed's last reply roasty or fixated?
  const lastFedReply = userHistory.filter(h => h.role === 'assistant').slice(-1)[0];
  if (!lastFedReply) return false;
  const wasRoasty = /\b(awkward|clown|drama|chaos|cringe|trainwreck|absurd|pathetic|disaster|cringeworthy|storm cloud|runaway|debt|owe)\b/i
    .test(lastFedReply.content);
  if (!wasRoasty) return false;

  // Is the current message a clear neutral/casual pivot?
  const neutralPatterns = [
    /\bwhat (are|r) (u|you) (doing|doin|up to|up2)\b/i,
    /\bhow (are|r) (u|you|ya)\b/i,
    /\bwhat'?s (up|good|new|going on)\b/i,
    /\b(u|you) (up|free|there|around|awake|good)\b/i,
    /\bwyd\b/i,
    /\bwhat u doin\b/i,
    /\bhow'?s it going\b/i,
    /\bwhat'?s new\b/i,
  ];
  return neutralPatterns.some(p => p.test(content));
}

function getHeatNote(userId, content, name) {
  const heat    = updateHeat(userId);
  const exiting = isExitVibe(content);

  if (exiting && heat >= 4) {
    return `\nConversation had good momentum but ${name} is clearly heading somewhere or winding down. Don't push or cling. One closing line only — make it specific to something actually said in this conversation, not a generic "always leaving me wanting more" type line. Reference what was actually talked about. Every exit should feel different from the last one. Don't be poetic or over-charming about it — keep it real and natural.`;
  }
  if (heat >= 8) {
    return `\nThis conversation has serious momentum. Be more personal, more present, slightly fuller reply. This is a real exchange — treat it like one.`;
  }
  if (heat >= 5) {
    return `\nGood momentum with ${name} right now. Stay engaged, match their energy.`;
  }
  if (heat <= 1) {
    return `\nFresh or cold start with ${name}. Don't assume too much familiarity yet.`;
  }
  return '';
}

// ─── Owes System ──────────────────────────────────────────────────────────────
// Tracks when someone asks Fed for something — advice, compliments, explanations,
// roasts, secrets. Fed remembers and can reference it naturally. Zero token cost.
const OWES_PATTERNS = [
  /\b(give me|tell me|explain|help me|can you|could you|would you|do you think|what do you think|what should i|how do i|how should i)\b/i,
  /\b(roast|compliment|rate|judge|review|advice|suggest|recommend)\b/i,
  /\b(what('s| is) your (opinion|take|thoughts?)|thoughts on|opinion on)\b/i,
  /\b(be honest|honestly|fr though|for real though|no cap)\b/i,
  /\b(keep this between us|don't tell|dont tell|our secret|just between)\b/i,
  /\b(cheer me up|make me feel|say something|talk to me)\b/i,
];

function detectOwes(content) {
  return OWES_PATTERNS.some(p => p.test(content));
}

function getOwesNote(user, name) {
  if (!user.owesCount) return '';
  if (user.owesCount >= 5) return `\n${name} has asked a lot of you — advice, explanations, compliments. They owe you. You can reference this naturally and occasionally, like "you know you keep coming to me for things" — never bitter, just aware.`;
  if (user.owesCount >= 3) return `\n${name} has asked you for things a few times now. You've noticed. Can slip in a casual "you owe me one" when it fits.`;
  if (user.owesCount >= 1) return `\n${name} asked you for something recently. You remember. If it fits naturally, a passing "you know you owe me for that" is fair game.`;
  return '';
}


async function callGroq(key, messages, maxTok, temperature, top_p, frequency_penalty) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature, top_p, frequency_penalty, max_tokens: maxTok })
  });
  const d = await res.json();
  if (res.status === 429) throw new Error('429');
  if (res.ok && d.choices?.[0]?.message?.content) return d.choices[0].message.content;
  return null;
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.channel.id !== process.env.CHANNEL_ID) return;

  const content     = msg.content;
  const lower       = content.toLowerCase();
  const id          = msg.author.id;
  const displayName = getDisplayName(msg);
  const username    = msg.author.username;

  const isCreator    = id === CREATOR_ID;
  const isMainPerson = id === MAIN_PERSON_ID;
  const isAdmin      = isCreator || msg.member?.permissions.has('Administrator');
  const isAdminOrMod = isAdmin || msg.member?.roles?.cache?.some(r => r.name.toLowerCase().includes('mod'));

  autoTrack(id, username, displayName);

  // Silent watch — Fed lurks and reacts on messages he does NOT reply to
  // maybeReact (reply-flow reactions) is called further down, only when Fed actually replies
  silentWatch(msg, content).catch(() => {});

  // Milestone check — null or the number (50/100/250/500/1000)
  const milestone = checkMilestone(id);

  // Snapshot previous lastSeen on the user object before updating
  // buildPrompt reads user._prevLastSeen to detect returning users
  userData[id]._prevLastSeen = userData[id].lastSeen || null;
  userData[id].lastSeen = Date.now();

  // Track per-channel recent messages for local context
  const chanId = msg.channel.id;
  if (!channelLogs[chanId]) channelLogs[chanId] = [];
  channelLogs[chanId].push(`${displayName}: ${content}`);
  if (channelLogs[chanId].length > MAX_CHANNEL_LOG) channelLogs[chanId].shift();
  const channelLog = channelLogs[chanId];

  // Auto location detection — only fires if location not already stored
  // Silently listens for "i'm from X", "i live in X", "based in X" etc.
  if (!identity[id]?.timezone) {
    const detected = detectLocation(content);
    if (detected) {
      identity[id].location = detected.location;
      identity[id].timezone = detected.timezone;
      saveIdentity();
      console.log(`Location auto-detected for ${resolveId(id, displayName)}: ${detected.location} (${detected.timezone})`);
    }
  }

  addToShared(resolveId(id, displayName), id, 'user', content);

  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      if (ref.author.id !== client.user.id && !msg.mentions.users.has(client.user.id)) return;
    } catch {}
  }

  // ── Public Commands ───────────────────────────────────────────────────────
  if (lower === '!fedmood') {
    const moodEmoji = { relaxed: '😌', amused: '😏', sharp: '🧠', playful: '😈', invested: '🫶' };
    const elapsed   = Date.now() - moodLastChangedAt;
    const mins      = Math.floor(elapsed / 60000);
    const timeStr   = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`;
    const who       = moodLastTriggeredBy ? ` — last shifted by **${moodLastTriggeredBy}**` : '';
    await msg.reply(`${moodEmoji[currentMood] || '🌀'} Fed's current mood: **${currentMood}**${who} (${timeStr})`);
    return;
  }

  // ── Admin Commands ────────────────────────────────────────────────────────
  if (isAdmin) {

    if (lower.startsWith('!vault add ')) {
      const fact = content.slice('!vault add '.length).trim();
      if (fact) { vault.push(fact); saveVault(); await msg.reply(`vault updated.`); } return;
    }
    if (lower === '!vault show') {
      await msg.reply(vault.length === 0 ? 'vault is empty.' : `**vault (${vault.length}):**\n${vault.map((v,i) => `${i+1}. ${v}`).join('\n')}`); return;
    }
    if (lower.startsWith('!vault clear ')) {
      const idx = parseInt(content.slice('!vault clear '.length).trim()) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < vault.length) { const [r] = vault.splice(idx, 1); saveVault(); await msg.reply(`removed: "${r}"`); }
      else await msg.reply('invalid number.'); return;
    }

    if (lower.startsWith('!rule add ')) {
      const rule = content.slice('!rule add '.length).trim();
      if (rule) { liveRules.push(rule); saveRules(); await msg.reply(`rule added.`); } return;
    }
    if (lower === '!rule show') {
      await msg.reply(liveRules.length === 0 ? 'no rules.' : `**rules:**\n${liveRules.map((r,i) => `${i+1}. ${r}`).join('\n')}`); return;
    }
    if (lower.startsWith('!rule clear ')) {
      const idx = parseInt(content.slice('!rule clear '.length).trim()) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < liveRules.length) { const [r] = liveRules.splice(idx, 1); saveRules(); await msg.reply(`removed: "${r}"`); }
      else await msg.reply('invalid number.'); return;
    }
    if (lower === '!rate now') {
      await msg.reply('dropping the review...');
      await postDailyRating();
      return;
    }

    // Identity cleanup — remove users who have no knownAs and no chat history
    if (lower === '!identity cleanup') {
      const before = Object.keys(identity).length;
      for (const uid of Object.keys(identity)) {
        const hasName = identity[uid]?.knownAs;
        const hasHistory = userData[uid]?.history?.length > 0;
        if (!hasName && !hasHistory) delete identity[uid];
      }
      const after = Object.keys(identity).length;
      saveIdentity();
      await msg.reply(`cleaned up identity file — removed ${before - after} inactive entries. ${after} remain.`);
      return;
    }

    // Global language lock — !lang hindi / !lang english / !lang auto
    if (lower.startsWith('!lang ')) {
      const arg = lower.replace('!lang ', '').trim();
      if (arg === 'auto' || arg === 'off' || arg === 'reset') {
        globalLangLock = null;
        saveLangLock();
        for (const uid of Object.keys(userData)) userData[uid].langMode = null;
        saveMemory();
        await msg.reply('language lock removed — back to auto-detect per user.');
      } else if (SUPPORTED_LANGS[arg] || arg === 'english') {
        globalLangLock = arg === 'english' ? null : (SUPPORTED_LANGS[arg] || arg);
        saveLangLock();
        if (!globalLangLock) { for (const uid of Object.keys(userData)) userData[uid].langMode = null; saveMemory(); }
        await msg.reply(globalLangLock ? `language locked to **${globalLangLock}** for ALL replies until you run \`!lang auto\`.` : 'language lock removed.');
      } else {
        await msg.reply('usage: `!lang hindi` / `!lang english` / `!lang auto`');
      }
      return;
    }

    // Relationship map commands — !rel @user1 @user2 friends/beef/ship/clear/show
    if (lower.startsWith('!rel ')) {
      const mentioned = [...msg.mentions.users.values()].filter(u => u.id !== client.user.id);
      if (mentioned.length < 1) { await msg.reply('mention at least one user.'); return; }
      const uid1  = mentioned[0]?.id || id;
      const uid2  = mentioned[1]?.id || id;
      const arg   = lower.split(/\s+/).pop();
      const name1 = resolveId(uid1, mentioned[0]?.username || 'user1');
      const name2 = resolveId(uid2, mentioned[1]?.username || 'user2');

      if (arg === 'show') {
        const rel = getRel(uid1, uid2);
        await msg.reply(`**${name1} ↔ ${name2}**: ${rel.type} (level ${rel.level}/10)${rel.notes.length ? `\nnotes: ${rel.notes.join(', ')}` : ''}`);
      } else if (arg === 'clear') {
        delete relationships[relKey(uid1, uid2)];
        saveRelationships();
        await msg.reply(`relationship cleared for ${name1} & ${name2}.`);
      } else if (['friends', 'beef', 'ship', 'neutral'].includes(arg)) {
        setRel(uid1, uid2, arg, 0);
        relationships[relKey(uid1, uid2)].level = 5; // start at mid-strength when manually set
        saveRelationships();
        await msg.reply(`${name1} & ${name2} marked as **${arg}** (level 5/10).`);
      } else {
        await msg.reply('usage: `!rel @user1 @user2 friends/beef/ship/neutral/show/clear`');
      }
      return;
    }

    if (lower.startsWith('!reset memory')) {
      const mentioned = msg.mentions.users.first();
      if (mentioned && userData[mentioned.id]) {
        userData[mentioned.id].history = [];
        userData[mentioned.id].bio     = '';
        saveMemory();
        await msg.reply(`memory cleared for ${resolveId(mentioned.id, mentioned.username)}. identity and location still locked.`);
      } else if (!mentioned) {
        if (userData[id]) { userData[id].history = []; userData[id].bio = ''; saveMemory(); }
        await msg.reply('your memory cleared.');
      } return;
    }

    if (lower.startsWith('!bio set ') || lower.startsWith('!bio clear')) {
      const mentioned = msg.mentions.users.first();
      if (mentioned) {
        if (lower.startsWith('!bio clear')) {
          if (userData[mentioned.id]) { userData[mentioned.id].bio = ''; saveMemory(); }
          await msg.reply(`bio cleared for ${resolveId(mentioned.id, mentioned.username)}.`);
        } else {
          const bioText = content.replace(/!bio set\s+<@!?\d+>\s*/i, '').trim();
          if (!userData[mentioned.id]) autoTrack(mentioned.id, mentioned.username, mentioned.globalName || mentioned.username);
          userData[mentioned.id].bio = bioText;
          saveMemory(); await msg.reply(`bio set for ${resolveId(mentioned.id, mentioned.username)}.`);
        }
      } return;
    }

    // !location @user CityOrCountry — manually set someone's location
    // Also: !location @user clear — remove their location
    if (lower.startsWith('!location ')) {
      const mentioned = msg.mentions.users.first();
      if (mentioned) {
        const locInput = content.replace(/!location\s+<@!?\d+>\s*/i, '').trim();
        if (locInput.toLowerCase() === 'clear') {
          if (identity[mentioned.id]) { identity[mentioned.id].location = null; identity[mentioned.id].timezone = null; saveIdentity(); }
          await msg.reply(`location cleared for ${resolveId(mentioned.id, mentioned.username)}.`);
        } else {
          const locLower = locInput.toLowerCase();
          let tz = LOCATION_TZ[locLower];
          if (!tz) {
            for (const [key, val] of Object.entries(LOCATION_TZ)) {
              if (locLower.includes(key) || key.includes(locLower)) { tz = val; break; }
            }
          }
          if (tz) {
            if (!identity[mentioned.id]) identity[mentioned.id] = { knownAs: null, gender: null, aliases: [], location: null, timezone: null };
            identity[mentioned.id].location = capitalise(locInput);
            identity[mentioned.id].timezone = tz;
            saveIdentity();
            const localTime = getUserLocalTime(tz);
            await msg.reply(`got it. ${resolveId(mentioned.id, mentioned.username)} is in ${capitalise(locInput)} — currently ${localTime}.`);
          } else {
            await msg.reply(`couldn't map "${locInput}" to a timezone. try a country name or major city.`);
          }
        }
      } else {
        await msg.reply('usage: `!location @user India` or `!location @user clear`');
      }
      return;
    }

    // !know commands
    if (lower.startsWith('!know')) {
      if (lower === '!know show') {
        const known = Object.entries(identity).filter(([,i]) => i.knownAs);
        if (known.length === 0) {
          await msg.reply('nobody locked yet.');
        } else {
          const lines = known.map(([uid, i]) => {
            const al  = (i.aliases || []).filter(a => a !== i.knownAs).slice(-3).join(', ');
            const loc = i.location ? ` | ${i.location} (${getUserLocalTime(i.timezone) || i.timezone})` : '';
            return `**${i.knownAs}** (${i.gender || '?'})${loc} — \`${uid}\`${al ? `\n  seen as: ${al}` : ''}`;
          });
          await msg.reply(`**known identities (${lines.length}):**\n${lines.join('\n\n')}`);
        }
        return;
      }
      if (lower.startsWith('!know remove ')) {
        const mentioned = msg.mentions.users.first();
        if (mentioned && identity[mentioned.id]) {
          const was = identity[mentioned.id].knownAs;
          identity[mentioned.id].knownAs = null; identity[mentioned.id].gender = null;
          saveIdentity();
          await msg.reply(`unlocked ${was || mentioned.username}.`);
        } return;
      }
      const mentioned = msg.mentions.users.first();
      if (mentioned) {
        if (lower.includes(' gender ')) {
          const gMatch = content.match(/gender\s+(male|female|gay)/i);
          if (gMatch) {
            if (!identity[mentioned.id]) identity[mentioned.id] = { knownAs: null, gender: null, aliases: [], location: null, timezone: null };
            identity[mentioned.id].gender = gMatch[1].toLowerCase();
            saveIdentity();
            await msg.reply(`${resolveId(mentioned.id, mentioned.username)} → ${gMatch[1].toLowerCase()}.`);
          }
        } else {
          const parts   = content.replace(/!know\s+<@!?\d+>\s*/i, '').trim().split(/\s+/);
          const knownAs = parts[0];
          const gender  = ['male','female','gay'].includes(parts[1]?.toLowerCase()) ? parts[1].toLowerCase() : null;
          if (knownAs) {
            if (!identity[mentioned.id]) identity[mentioned.id] = { knownAs: null, gender: null, aliases: [], location: null, timezone: null };
            identity[mentioned.id].knownAs = knownAs;
            if (gender) identity[mentioned.id].gender = gender;
            saveIdentity();
            await msg.reply(`locked. → **${knownAs}**${gender ? ` (${gender})` : ''}. survives any memory reset.`);
          } else { await msg.reply('usage: `!know @user Name [male/female/gay]`'); }
        }
      } else { await msg.reply('usage: `!know @user Name [male/female/gay]` | `!know show` | `!know remove @user`'); }
      return;
    }

    if (lower.startsWith('!roast ')) {
      const mentioned = msg.mentions.users.first();
      if (mentioned) {
        if (!userData[mentioned.id]) autoTrack(mentioned.id, mentioned.username, mentioned.globalName || mentioned.username);
        userData[mentioned.id].roastMode = true; userData[mentioned.id].jerkScore = 5;
        saveMemory(); await msg.reply(`roast mode on for ${resolveId(mentioned.id, mentioned.username)}.`);
      } return;
    }
    if (lower.startsWith('!unroast ')) {
      const mentioned = msg.mentions.users.first();
      if (mentioned && userData[mentioned.id]) {
        userData[mentioned.id].roastMode = false; userData[mentioned.id].jerkScore = 0;
        saveMemory(); await msg.reply(`roast mode off for ${resolveId(mentioned.id, mentioned.username)}.`);
      } return;
    }
  }

  const user = userData[id];
  if (user.respect   === undefined) user.respect   = isCreator ? 88 : isMainPerson ? 95 : 55;
  if (!user.history)  user.history  = [];
  if (!user.bio)      user.bio      = '';
  if (!user.jerkScore) user.jerkScore = 0;
  if (user.roastMode === undefined) user.roastMode = false;

  // Time-based jerkScore reset — if they've been gone for 2+ hours, cut their score in half
  if (user.lastSeen && (Date.now() - user.lastSeen) > 7200000) {
    user.jerkScore = Math.max(0, (user.jerkScore || 0) * 0.4);
  }

  if (isRude(content)) {
    user.jerkScore = Math.min(10, (user.jerkScore || 0) + 1.5);
    user.respect   = Math.max(0, (user.respect   || 55) - 5);
  } else {
    user.jerkScore = Math.max(0, (user.jerkScore || 0) - 0.6); // 2x faster decay than before
  }

  // Mercy detection — if someone explicitly asks to be treated kindly, honour it once
  const mercyPatterns = [
    /\bpls (be )?(a bit )?(kind|nice|gentle|cool|chill|sweet)\b/i,
    /\bplease (be )?(kind|nice|gentle|nicer|kinder|stop)\b/i,
    /\bstop (roasting|being mean|being rude|bullying)\b/i,
    /\bbe (kind|nice|nicer|kinder|a bit kind|gentle)\b/i,
    /\bi('m| am) (sad|lonely|feeling down|not okay|hurting)\b/i,
  ];
  const isKindnessPlea = mercyPatterns.some(p => p.test(content));
  if (isKindnessPlea) {
    user.jerkScore = Math.max(0, (user.jerkScore || 0) - 2.5);
  }

  // Topic drop counter — tracks how many times user has asked to stop/change topic
  const stopSignals = [
    /\b(leave me alone|chhod de|chhodo|chod de|chodo|drop (it|the topic)|stop (it|this|now)|not interested|move on|change (the )?topic|new topic|nvm|nevermind|forget it|bas kar|bas karo|ruk ja|enough)\b/i,
    /^(nah|nope|no|stop|bye|cya|done|finished|enough|ok bye|alr bye|alright bye)$/i,
    /\b(bhai chhod|yaar chhod|bhai bas|yaar bas|isse chhod|isko chhod)\b/i,
    /\b(please|pls|bro|yaar)\s+forget\b/i,
    /\bforget (about )?(it|that|this|her|him|them|everything)\b/i,
  ];
  const isStopSignal = stopSignals.some(p => p.test(content));
  if (isStopSignal) {
    user.topicDropCount = (user.topicDropCount || 0) + 1;
  } else if (!isRude(content) && !/\b(why|what|how|who|when|where)\b/i.test(content)) {
    // Decay slowly on neutral/new messages
    user.topicDropCount = Math.max(0, (user.topicDropCount || 0) - 0.5);
  }

  const roastActive = !isKindnessPlea && (user.roastMode || (user.jerkScore || 0) >= 3);
  tickMood(isMainPerson, resolveId(id, displayName));

  const mentionContext = [];
  const mentionedIds   = [];
  for (const [uid, mentionedUser] of msg.mentions.users) {
    if (uid === client.user.id) continue;
    mentionedIds.push(uid);
    autoUpdateRelationship(id, uid, content);
    const knownName   = resolveId(uid, null);
    const visibleName = mentionedUser.globalName || mentionedUser.username;
    const gender      = identity[uid]?.gender;
    const loc         = identity[uid]?.location;
    const time        = identity[uid]?.timezone ? getUserLocalTime(identity[uid].timezone) : null;
    let line = knownName && knownName !== 'someone'
      ? `@${visibleName} = ${knownName}${gender ? ` (${gender})` : ''}${loc ? ` from ${loc}${time ? `, ${time}` : ''}` : ''} — ID: ${uid}`
      : `@${visibleName} (ID: ${uid}) — identity not locked yet`;
    mentionContext.push(line);
  }
  const relationshipNote = getRelationshipNote(id, mentionedIds);

  const prankWarning = getPrankWarning(id, content);

  user.history.push({ role: 'user', content: `${displayName} (${id}): ${content}` });
  if (user.history.length > 40) user.history.shift(); // was 10

  const historyTranscript = user.history.slice(0, -1)
    .map(h => h.role === 'user' ? h.content : `Fed: ${h.content}`)
    .join('\n');

  const recentChannel = channelLog.slice(-6, -1);

  // ── Low-effort skip — Fed ignores very short low-effort messages sometimes ──
  // Never skips: mentions of Fed, replies to Fed, mainPerson, commands
  const isMentioned   = msg.mentions.users.has(client.user.id);
  const isReplyToFed  = msg.reference?.messageId != null;
  const wordCount     = content.trim().split(/\s+/).length;
  const LOW_EFFORT    = /^(lol|lmao|lmfao|haha|hehe|ok|okay|k|kk|yep|yup|nah|nope|sure|fr|ong|aye|💀|😭|😂|🤣|👀|👍|👎|🔥|💯)$/i;
  const isLowEffort   = wordCount <= 2 && (wordCount === 1 || LOW_EFFORT.test(content.trim()));
  if (isLowEffort && !isMentioned && !isReplyToFed && !isMainPerson && !isCreator && Math.random() < 0.20) {
    // silentWatch already fired above — Fed just quietly watched this one
    return;
  }

  // ── Image attachment detection ─────────────────────────────────────────────
  const imageAttachment = msg.attachments.find(a => IMAGE_TYPES.includes(a.contentType?.split(';')[0]));
  let imageBase64 = null;
  let imageMime   = null;
  if (imageAttachment) {
    try {
      const fetched = await fetchImageBase64(imageAttachment.url);
      imageBase64   = fetched.base64;
      imageMime     = fetched.mime;
      console.log(`🖼️ Image fetched from ${resolveId(id, displayName)} (${imageMime})`);
    } catch (e) {
      console.log(`Image fetch failed: ${e.message}`);
    }
  }

  // Typing indicator — refreshes every 8s so it doesn't disappear during long API calls
  let typingActive = true;
  const typingInterval = setInterval(() => { if (typingActive) try { msg.channel.sendTyping(); } catch {} }, 8000);
  try { msg.channel.sendTyping(); } catch {}

  // Auto-summarize every 10 messages
  user.summaryTick = (user.summaryTick || 0) + 1;
  if (user.history.length >= 10 && user.summaryTick % 20 === 0) {
    try {
      const summaryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEYS[groqIndex % GROQ_KEYS.length]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: `Summarize what Fed learned about ${resolveId(id, displayName)} in 2 sentences.\n\n${user.history.map(h => h.content).join('\n')}` }],
          max_tokens: 100, temperature: 0.3
        })
      });
      const sd = await summaryRes.json();
      const summary = sd.choices?.[0]?.message?.content;
      if (summary) {
        user.bio = (user.bio ? user.bio + ' | ' : '') + `[Memory: ${summary.trim()}]`;
        if (user.bio.length > 500) user.bio = user.bio.slice(-400);
      }
    } catch {}
  }

  try {
    const inputLen = content.trim().split(/\s+/).length;
    const maxTok   = roastActive ? 220 : inputLen <= 3 ? 80 : inputLen <= 10 ? 130 : inputLen <= 25 ? 180 : 240;

    // Owes detection — did this message ask Fed for something?
    if (detectOwes(content)) {
      if (!user.owesCount) user.owesCount = 0;
      user.owesCount++;
      saveMemory();
    }
    // Anti-repeat — extract Fed's last 2 reply openings and hard-block them
    const recentFedReplies = user.history
      .filter(h => h.role === 'assistant')
      .slice(-3)
      .map(h => `"${h.content.slice(0, 60).trim()}..."`)
      .join(' | ');

    // Greeting-specific pattern check — looks across shared history so Fed can't
    // repeat the same morning/hi response even across different days/users
    const isGreeting = /^(morning|good morning|hi|hey|hello|hii|heyy|heya|sup|yo)\b/i.test(content.trim());
    const greetingPatternNote = isGreeting
      ? (() => {
          const recentGreetingReplies = sharedHistory
            .filter(h => h.role === 'fed')
            .slice(-40)
            .map(h => h.content.slice(0, 55).trim())
            .filter(Boolean)
            .slice(-4)
            .map(r => `"${r}..."`)
            .join(' | ');
          return recentGreetingReplies
            ? `\nGREETING VARIATION: You recently replied to greetings like this: ${recentGreetingReplies}. Your response to this greeting must start completely differently — different first word, different angle, different energy. No "morning beautiful", no "about time", no "was starting to think". Be unpredictable.`
            : '';
        })()
      : '';

    const antiRepeatNote = (recentFedReplies
      ? `\n\nANTI-REPEAT: Your last replies to this person started with: ${recentFedReplies}. Do NOT start this reply with anything similar. Find a completely different angle, different opening, different energy. This is a hard rule.`
      : '') + greetingPatternNote;

    const owesNote      = getOwesNote(user, resolveId(id, displayName));
    const heatNoteBase  = getHeatNote(id, content, resolveId(id, displayName));
    const pivotReset    = (!roastActive && isConversationPivot(content, user.history))
      ? `\nTOPIC RESET: they've explicitly moved on or changed subject — drop whatever thread was running (debt, roast, any ongoing bit) completely. Do NOT circle back to it at the end of your reply. Fresh start, full stop.`
      : '';
    const mercyNote     = isKindnessPlea
      ? `\nMERCY OVERRIDE: they've explicitly asked you to ease off and be kind — honour it. drop the roast completely this once, be a actual human with them.`
      : '';
    const topicDropNote = (user.topicDropCount || 0) >= 3
      ? `\nHARD STOP: this person has asked you to drop the current topic or leave them alone MULTIPLE TIMES. Do NOT bring up ANY previous topic threads. Completely fresh — respond only to what they literally just said right now. This is non-negotiable.`
      : (user.topicDropCount || 0) >= 1
      ? `\nNOTE: they've signalled wanting to move on or be left alone. Don't circle back to previous topics unless they bring it up first.`
      : '';
    const heatNote      = heatNoteBase + pivotReset + mercyNote + topicDropNote;

    // Language mode — detect request, update userData, inject note
    const langRequest = detectLangRequest(content);
    if (langRequest === 'reset') {
      user.langMode = null;
      if (isAdminOrMod) { globalLangLock = null; saveLangLock(); }
      saveMemory();
    } else if (langRequest) {
      user.langMode = langRequest;
      // If admin says "talk in X until told" or "for everyone" → global lock
      const isGlobalCmd = /\b(until|everyone|all|for all|whole server|always|from now)\b/i.test(content);
      if (isAdminOrMod && isGlobalCmd) { globalLangLock = langRequest; saveLangLock(); console.log(`🌐 Global lang locked: ${langRequest}`); }
      saveMemory();
    }
    // Detect "switch back to english / reset to english" type unlocks from admin
    if (isAdminOrMod && /\b(switch back|reset (to|back)|back to english|speak english (now|again|back)|now speak english)\b/i.test(content)) {
      globalLangLock = null; saveLangLock();
    }
    const langNote = getLangNote(globalLangLock || user.langMode || null);

    // Inject full shared history (all 60 entries) + full identity roster
    const sharedCtx = getSharedContext();
    const systemPrompt = buildPrompt(id, user, historyTranscript, isMainPerson, isCreator, roastActive, inputLen, mentionContext, sharedCtx, prankWarning, null, milestone, null, '', heatNote, antiRepeatNote, langNote, '');
    const messages     = [{ role: 'system', content: systemPrompt }, ...user.history.slice(-40).map(h => ({ role: h.role, content: h.content.length > 600 ? h.content.slice(0, 600) + '...' : h.content }))];
    // Higher temperature + top_p diversity + frequency penalty prevents same reply to same input
    const temperature  = roastActive ? 1.25 : isMainPerson ? 1.15 : 1.10;
    const top_p        = 0.92;
    const frequency_penalty = 0.5; // penalises repeating tokens from earlier in the reply
    let reply = null;

    // If message has an image — skip Groq (no vision support) and go straight to Gemini
    if (imageBase64 && GEMINI_KEYS.length > 0) {
      const visionModels = ['gemini-3-flash-preview', 'gemini-2.0-flash'];
      outer: for (const model of visionModels) {
        for (let i = 0; i < GEMINI_KEYS.length; i++) {
          const key    = GEMINI_KEYS[geminiIndex];
          const keyNum = geminiIndex;
          geminiIndex  = (geminiIndex + 1) % GEMINI_KEYS.length;
          if (isGeminiCooling(key, model)) continue;
          try {
            reply = await callGeminiWithImage(key, model, systemPrompt, messages, maxTok, temperature, imageBase64, imageMime);
            if (reply) { console.log(`✅ Gemini vision (${model}) key ${keyNum} responded`); break outer; }
          } catch (e) {
            if (e.message.startsWith('429')) coolGemini(key, model);
            else console.log(`Gemini vision error: ${e.message.slice(0,80)}`);
          }
        }
      }
    }

    if (!imageBase64 && GROQ_KEYS.length > 0) {
      for (let i = 0; i < GROQ_KEYS.length; i++) {
        const key = GROQ_KEYS[groqIndex];
        const keyNum = groqIndex;
        groqIndex = (groqIndex + 1) % GROQ_KEYS.length;
        if (isKeyCooling(key)) { console.log(`Groq key ${keyNum} cooling, skipping`); continue; }
        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature, top_p, frequency_penalty, max_tokens: maxTok, stop: ['\n\n', `${resolveId(id, displayName)}:`, 'Fed:', 'Federico:'] })
          });
          const d = await res.json();
          if (res.ok && d.choices?.[0]?.message?.content) {
            reply = d.choices[0].message.content;
            console.log(`✅ Groq key ${keyNum} responded`);
            break;
          } else if (res.status === 429) {
            coolKey(key);
            console.log(`Groq key ${keyNum} rate limited (429)`);
          } else if (res.status === 413) {
            console.log(`Groq key ${keyNum} 413 too large — compact retry`);
            const compact = [
              { role: 'system', content: `You are Fed (Federico Vitale). Lowercase, nonchalant, no emojis, no exclamation marks, charming and real, never an AI. Talking to ${resolveId(id, displayName)}.` },
              ...messages.slice(-7).filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content.slice(0, 300) }))
            ];
            try {
              const r2 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: compact, temperature, top_p, max_tokens: maxTok })
              });
              const d2 = await r2.json();
              if (r2.ok && d2.choices?.[0]?.message?.content) { reply = d2.choices[0].message.content; console.log(`✅ Groq key ${keyNum} responded (compact)`); break; }
            } catch {}
          } else {
            console.log(`Groq key ${keyNum} failed (${res.status})`);
          }
        } catch (e) { console.log(`Groq key ${keyNum} error: ${e.message}`); }
      }
    }

    // Gemini fallback — tries each model (flash → flash-8b) across all keys with cooldown
    if (!reply && GEMINI_KEYS.length > 0) {
      outer: for (const model of GEMINI_MODELS) {
        for (let i = 0; i < GEMINI_KEYS.length; i++) {
          const key    = GEMINI_KEYS[geminiIndex];
          const keyNum = geminiIndex;
          geminiIndex  = (geminiIndex + 1) % GEMINI_KEYS.length;
          if (isGeminiCooling(key, model)) {
            const sM = model.replace('gemini-2.0-', '').replace('gemini-1.5-', '');
            console.log(`Gemini ${sM} key ${keyNum} cooling, skipping`);
            continue;
          }
          try {
            reply = await callGemini(key, model, systemPrompt, messages, maxTok, temperature);
            if (reply) {
              const shortModel = model.replace('gemini-2.0-', '').replace('gemini-1.5-', '');
              console.log(`✅ Gemini ${shortModel} key ${keyNum} responded`);
              break outer;
            }
          } catch (e) {
            if (e.message.startsWith('429')) {
              const shortM = model.replace('gemini-2.0-', '').replace('gemini-1.5-', '');
              console.log(`Gemini ${shortM} key ${keyNum} rate limited (429)`);
            } else {
              console.log(`Gemini ${model} key ${keyNum} error: ${e.message.slice(0,80)}`);
            }
          }
        }
      }
    }

    typingActive = false;
    clearInterval(typingInterval);

    if (!reply) {
      // All keys exhausted — wait for cooldowns then retry once before giving up
      console.log('⏳ All keys busy — waiting 8s then one more pass...');
      await new Promise(r => setTimeout(r, 8000));
      // One more Groq pass
      for (let i = 0; i < GROQ_KEYS.length && !reply; i++) {
        const key = GROQ_KEYS[groqIndex];
        groqIndex = (groqIndex + 1) % GROQ_KEYS.length;
        if (isKeyCooling(key)) continue;
        try {
          reply = await callGroq(key, messages, maxTok, temperature, top_p, frequency_penalty);
          if (reply) console.log(`✅ Retry Groq key ${groqIndex} responded`);
        } catch (e) { if (e.message.startsWith('429')) coolKey(key); }
      }
      // One more Gemini pass
      if (!reply) {
        for (const model of GEMINI_MODELS) {
          for (let i = 0; i < GEMINI_KEYS.length && !reply; i++) {
            const key = GEMINI_KEYS[geminiIndex];
            geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
            if (isGeminiCooling(key, model)) continue;
            try {
              reply = await callGemini(key, model, systemPrompt, messages, maxTok, temperature);
              if (reply) console.log(`✅ Retry Gemini (${model}) responded`);
            } catch (e) { if (e.message.startsWith('429')) coolGemini(key, model); }
          }
          if (reply) break;
        }
      }
    }

    if (!reply) { try { await msg.reply('not now.'); } catch { try { await msg.channel.send('not now.'); } catch {} } return; }

    const userNicknames = identity[id]?.nicknames || [];
    reply = cleanReply(reply, resolveId(id, displayName), userNicknames);
    user.history.push({ role: 'assistant', content: reply });
    addToShared('Fed', 'fed', 'fed', reply);  // log Fed's reply to shared history
    saveMemory();

    const useReply = inputLen > 8 || Math.random() < 0.45;
    try {
      if (useReply) await msg.reply(reply);
      else          await msg.channel.send(reply);
    } catch (sendErr) {
      try { await msg.channel.send(reply); } catch {}
    }

    // Emoji reaction — fires after reply so it only triggers when Fed actually responds
    maybeReact(msg, content, id).catch(() => {});

    // GIF — fires after text reply, async so it never delays Fed's response
    maybeGif(msg, content, reply, roastActive).catch(() => {});

  } catch (err) {
    typingActive = false;
    clearInterval(typingInterval);
    console.error('Error:', err);
    try { await msg.reply('not now.'); } catch { try { await msg.channel.send('not now.'); } catch {} }
  }
});

client.on('error', err => console.error('Discord error:', err.message));
client.on('warn',  msg => console.warn('Discord warning:', msg));
client.once('ready', () => {
  console.log('Fed 13.0 live.');
  startDailyRating();
});

// ─── Daily Chat Rating ────────────────────────────────────────────────────────
// Every 24 hours Fed drops an unsolicited review of how the server did that day.
// Who was entertaining, who was dry, who caused drama — zero filter, full Fed voice.

const DAILY_RATING_FILE = path.join(__dirname, 'fed_daily_rating.json');
let dailyRatingState = { lastRated: 0 };
try {
  dailyRatingState = JSON.parse(fs.readFileSync(DAILY_RATING_FILE, 'utf8'));
  console.log('Daily rating state loaded — last rated: ' + new Date(dailyRatingState.lastRated).toLocaleString());
} catch (e) { console.log('Daily rating starting fresh.'); }
const saveDailyRatingState = () => fs.writeFileSync(DAILY_RATING_FILE, JSON.stringify(dailyRatingState, null, 2));

function getDayTranscript() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const msgs   = sharedHistory.filter(h => h.ts && h.ts >= since);
  if (msgs.length < 5) return null; // not enough activity to rate
  return msgs
    .map(h => h.role === 'fed' ? `Fed: ${h.content}` : `${h.name}: ${h.content}`)
    .join('\n');
}

async function postDailyRating() {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const transcript = getDayTranscript();
  if (!transcript) {
    console.log('Daily rating skipped — not enough activity today.');
    return;
  }

  const prompt = `You are Fed (Federico Vitale) — nonchalant, witty, lowercase, no emojis, no exclamation marks.
Based on today's chat transcript below, drop your unsolicited daily review of how the server performed.
Rate who was entertaining, who was boring, who caused drama, who surprised you, who needs to do better.
Be specific — use actual names and reference actual things they said today. Keep it under 120 words.
Don't announce it as a "daily rating" — just drop it naturally like a thought you had.
Never start with "so" or "well". Don't be preachy. Be Fed.

Today's transcript:
${transcript}`;

  let review = null;

  // Try Groq first
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[groqIndex];
    groqIndex = (groqIndex + 1) % GROQ_KEYS.length;
    if (isKeyCooling(key)) continue;
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 180,
          temperature: 1.1,
        })
      });
      const d = await res.json();
      if (res.ok && d.choices?.[0]?.message?.content) {
        review = d.choices[0].message.content.trim();
        break;
      } else if (res.status === 429) { coolKey(key); }
    } catch (e) { console.log(`Daily rating Groq error: ${e.message}`); }
  }

  // Gemini fallback
  if (!review) {
    for (const model of GEMINI_MODELS) {
      for (let i = 0; i < GEMINI_KEYS.length; i++) {
        const key = GEMINI_KEYS[geminiIndex];
        geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
        if (isGeminiCooling(key, model)) continue;
        try {
          review = await callGemini(key, model, '', [{ role: 'user', content: prompt }], 180, 1.1);
          if (review) break;
        } catch (e) { if (e.message.startsWith('429')) coolGemini(key, model); }
      }
      if (review) break;
    }
  }

  if (!review) { console.log('Daily rating failed — all keys busy.'); return; }

  // Clean it up like a normal Fed reply
  review = review.replace(/^(fed:|federico vitale:|federico:)/i, '').trim();

  await channel.send(review);
  dailyRatingState.lastRated = Date.now();
  saveDailyRatingState();
  console.log('📊 Daily rating posted.');
}

function startDailyRating() {
  const INTERVAL    = 60 * 60 * 1000; // check every hour
  const PERIOD      = 24 * 60 * 60 * 1000; // fire every 24h
  // Random offset 0-4h so it doesn't always fire at the exact same time
  const JITTER      = Math.floor(Math.random() * 4 * 60 * 60 * 1000);

  setInterval(async () => {
    const now       = Date.now();
    const timeSince = now - (dailyRatingState.lastRated || 0);
    if (timeSince >= PERIOD + JITTER) {
      console.log('⏰ Daily rating triggered.');
      await postDailyRating();
    }
  }, INTERVAL);

  console.log('Daily rating scheduler started.');
}

console.log('Starting up, waiting 5s before connecting to Discord...');
setTimeout(() => {
  client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Login failed:', err.message));
}, 5000);

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException',  err => console.error('Uncaught exception:',  err.message));
