// Fetch third-party emotes from 7TV, BTTV, FFZ.
// Returns a unified map: emoteName -> { url, provider }

const CACHE_TTL_GLOBAL = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_TTL_CHANNEL = 1 * 60 * 60 * 1000; // 1 hour

async function getCached(key) {
  const { [key]: entry } = await chrome.storage.local.get(key);
  if (entry && Date.now() - entry.ts < entry.ttl) return entry.data;
  return null;
}

async function setCache(key, data, ttl) {
  await chrome.storage.local.set({ [key]: { data, ts: Date.now(), ttl } });
}

// --- 7TV ---
async function fetch7TVGlobal() {
  const cached = await getCached("emotes_7tv_global");
  if (cached) return cached;
  const res = await fetch("https://7tv.io/v3/emote-sets/global");
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const e of data.emotes || []) {
    const host = e.data?.host;
    if (host) {
      map[e.name] = {
        url: `https:${host.url}/1x.webp`,
        provider: "7tv",
        scope: "global",
      };
    }
  }
  await setCache("emotes_7tv_global", map, CACHE_TTL_GLOBAL);
  return map;
}

async function fetch7TVChannel(userId) {
  const key = `emotes_7tv_${userId}`;
  const cached = await getCached(key);
  if (cached) return cached;
  const res = await fetch(`https://7tv.io/v3/users/twitch/${userId}`);
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const e of data.emote_set?.emotes || []) {
    const host = e.data?.host;
    if (host) {
      map[e.name] = {
        url: `https:${host.url}/1x.webp`,
        provider: "7tv",
        scope: "channel",
      };
    }
  }
  await setCache(key, map, CACHE_TTL_CHANNEL);
  return map;
}

// --- BTTV ---
async function fetchBTTVGlobal() {
  const cached = await getCached("emotes_bttv_global");
  if (cached) return cached;
  const res = await fetch(
    "https://api.betterttv.net/3/cached/emotes/global",
  );
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const e of data) {
    map[e.code] = {
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
      provider: "bttv",
      scope: "global",
    };
  }
  await setCache("emotes_bttv_global", map, CACHE_TTL_GLOBAL);
  return map;
}

async function fetchBTTVChannel(userId) {
  const key = `emotes_bttv_${userId}`;
  const cached = await getCached(key);
  if (cached) return cached;
  const res = await fetch(
    `https://api.betterttv.net/3/cached/users/twitch/${userId}`,
  );
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const e of [...(data.channelEmotes || []), ...(data.sharedEmotes || [])]) {
    map[e.code] = {
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
      provider: "bttv",
      scope: "channel",
    };
  }
  await setCache(key, map, CACHE_TTL_CHANNEL);
  return map;
}

// --- FFZ ---
async function fetchFFZGlobal() {
  const cached = await getCached("emotes_ffz_global");
  if (cached) return cached;
  const res = await fetch("https://api.frankerfacez.com/v1/set/global");
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const set of Object.values(data.sets || {})) {
    for (const e of set.emoticons || []) {
      map[e.name] = {
        url: e.urls["1"] || Object.values(e.urls)[0],
        provider: "ffz",
        scope: "global",
      };
    }
  }
  await setCache("emotes_ffz_global", map, CACHE_TTL_GLOBAL);
  return map;
}

async function fetchFFZChannel(userId) {
  const key = `emotes_ffz_${userId}`;
  const cached = await getCached(key);
  if (cached) return cached;
  const res = await fetch(
    `https://api.frankerfacez.com/v1/room/id/${userId}`,
  );
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const set of Object.values(data.sets || {})) {
    for (const e of set.emoticons || []) {
      map[e.name] = {
        url: e.urls["1"] || Object.values(e.urls)[0],
        provider: "ffz",
        scope: "channel",
      };
    }
  }
  await setCache(key, map, CACHE_TTL_CHANNEL);
  return map;
}

// --- Unified fetch ---
// Priority: 7TV > BTTV > FFZ (later spreads win on collision)
export async function fetchAllEmotes(userId) {
  const [s7g, s7c, btg, btc, fzg, fzc] = await Promise.all([
    fetch7TVGlobal(),
    fetch7TVChannel(userId),
    fetchBTTVGlobal(),
    fetchBTTVChannel(userId),
    fetchFFZGlobal(),
    fetchFFZChannel(userId),
  ]);
  // FFZ < BTTV < 7TV — last spread wins, so 7TV goes last
  return { ...fzg, ...fzc, ...btg, ...btc, ...s7g, ...s7c };
}
