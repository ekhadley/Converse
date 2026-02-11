// Fetch and merge global + channel badges from Twitch Helix API.
// Returns a map: "set_id/version" -> image_url

let globalBadgesCache = null;

async function fetchGlobalBadges(clientId, token) {
  if (globalBadgesCache) return globalBadgesCache;
  const headers = { "Client-Id": clientId };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(
    "https://api.twitch.tv/helix/chat/badges/global",
    { headers },
  );
  if (!res.ok) throw new Error(`Global badges: ${res.status}`);
  const { data } = await res.json();
  globalBadgesCache = parseBadgeResponse(data);
  return globalBadgesCache;
}

async function fetchChannelBadges(clientId, token, broadcasterId) {
  const headers = { "Client-Id": clientId };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(
    `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`,
    { headers },
  );
  if (!res.ok) throw new Error(`Channel badges: ${res.status}`);
  const { data } = await res.json();
  return parseBadgeResponse(data);
}

function parseBadgeResponse(data) {
  const map = {};
  for (const set of data) {
    for (const version of set.versions) {
      map[`${set.set_id}/${version.id}`] = version.image_url_1x;
    }
  }
  return map;
}

export async function fetchBadges(clientId, token, broadcasterId) {
  const [global, channel] = await Promise.all([
    fetchGlobalBadges(clientId, token),
    fetchChannelBadges(clientId, token, broadcasterId),
  ]);
  // Channel overrides global
  return { ...global, ...channel };
}
