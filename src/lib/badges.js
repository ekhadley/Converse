// Fetch and merge global + channel badges from Twitch Helix API.
// Returns a map: "set_id/version" -> image_url

let globalBadgesCache = null;

async function fetchGlobalBadges(helixFetch) {
  if (globalBadgesCache) return globalBadgesCache;
  const { data } = await helixFetch("chat/badges/global");
  globalBadgesCache = parseBadgeResponse(data);
  return globalBadgesCache;
}

async function fetchChannelBadges(helixFetch, broadcasterId) {
  const { data } = await helixFetch(
    `chat/badges?broadcaster_id=${broadcasterId}`,
  );
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

export async function fetchBadges(helixFetch, broadcasterId) {
  const [global, channel] = await Promise.all([
    fetchGlobalBadges(helixFetch),
    fetchChannelBadges(helixFetch, broadcasterId),
  ]);
  // Channel overrides global
  return { ...global, ...channel };
}
