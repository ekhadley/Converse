import {
  getAccounts,
  getActiveAccount,
  validateToken,
  CLIENT_ID,
} from "./lib/auth.js";
import { parseIRCMessage } from "./lib/irc.js";
import { fetchBadges } from "./lib/badges.js";
import { fetchAllEmotes, clearEmoteCache } from "./lib/emotes.js";
import { DEFAULT_SETTINGS } from "./lib/settings.js";

// --- State ---
let ircSocket = null;
let ircReady = false;
let reconnectDelay = 1000;
let ircPingInterval = null;
let ircPongReceived = true;
let joinedChannels = new Set();
let ports = []; // connected content script ports
let currentAccount = null; // { login, userId, token }
let predictionPolls = {}; // channel -> { timer, lastPrediction }
let pinnedPolls = {}; // channel -> { timer, lastJSON }
let channelUserIds = {}; // channelLogin -> numericUserId

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

// --- IRC ---
function connectIRC() {
  if (!currentAccount) return;
  if (ircSocket && ircSocket.readyState <= 1) return; // already open/connecting

  ircSocket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ircReady = false;

  ircSocket.onopen = () => {
    ircSocket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ircSocket.send(`PASS oauth:${currentAccount.token}`);
    ircSocket.send(`NICK ${currentAccount.login}`);
  };

  ircSocket.onmessage = (event) => {
    const lines = event.data.split("\r\n").filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("PING")) {
        ircSocket.send("PONG :tmi.twitch.tv");
        continue;
      }
      const msg = parseIRCMessage(line);
      if (!msg) continue;

      if (msg.command === "001") {
        // Successfully connected
        ircReady = true;
        reconnectDelay = 1000;
        startIRCPing();
        // Rejoin all channels
        for (const ch of joinedChannels) {
          ircSocket.send(`JOIN #${ch}`);
        }
      }

      if (msg.command === "PONG") {
        ircPongReceived = true;
        continue;
      }

      if (msg.command === "RECONNECT") {
        ircSocket.close();
        continue;
      }

      if (
        msg.command === "PRIVMSG" ||
        msg.command === "CLEARCHAT" ||
        msg.command === "CLEARMSG" ||
        msg.command === "USERNOTICE" ||
        msg.command === "NOTICE"
      ) {
        broadcast({ type: "irc-message", data: msg });
      }
    }
  };

  ircSocket.onclose = () => {
    ircReady = false;
    clearInterval(ircPingInterval);
    ircPingInterval = null;
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectIRC();
    }, reconnectDelay);
  };

  ircSocket.onerror = () => {
    ircSocket.close();
  };
}

function startIRCPing() {
  clearInterval(ircPingInterval);
  ircPongReceived = true;
  ircPingInterval = setInterval(() => {
    if (!ircReady) return;
    if (!ircPongReceived) {
      // No PONG since last ping — connection is dead
      console.warn("IRC ping timeout, reconnecting");
      ircSocket.close();
      return;
    }
    ircPongReceived = false;
    ircSocket.send("PING :converse");
  }, 60000);
}

function joinChannel(channel) {
  if (joinedChannels.has(channel)) return;
  joinedChannels.add(channel);
  if (ircReady) ircSocket.send(`JOIN #${channel}`);
}

function partChannel(channel) {
  if (!joinedChannels.has(channel)) return;
  joinedChannels.delete(channel);
  if (ircReady) ircSocket.send(`PART #${channel}`);
}

function sendMessage(channel, text, replyParentMsgId) {
  if (!currentAccount || !ircReady) return;
  if (replyParentMsgId) {
    ircSocket.send(`@reply-parent-msg-id=${replyParentMsgId} PRIVMSG #${channel} :${text}`);
  } else {
    ircSocket.send(`PRIVMSG #${channel} :${text}`);
  }
}

function broadcast(msg, channel) {
  ports = ports.filter((port) => {
    if (channel && port._channel !== channel) return true;
    try { port.postMessage(msg); return true; } catch { return false; }
  });
}

// --- GQL ---
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_VOD_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";
const GQL_REWARDS_HASH = "7fe050e3761eb2cf258d70ee1a21cbd76fa8cf3d7e7b12fc437e7029d446b5e3";
const GQL_PREDICTIONS_HASH = "beb846598256b75bd7c1fe54a80431335996153e358ca9c7837ce7bb83d7d383";
const GQL_MAKE_PREDICTION_HASH = "b44682ecc88358817009f20e69d75081b1e58825bb40aa53d5dbadcc17c881d8";
const GQL_PINNED_CHAT_HASH = "2d099d4c9b6af80a07d8440140c4f3dbb04d516b35c401aab7ce8f60765308d5";

async function gqlFetch(body, { auth = false } = {}) {
  const headers = { "Client-Id": GQL_CLIENT_ID, "Content-Type": "application/json" };
  if (auth) {
    if (!currentAccount) throw new Error("Not authenticated");
    headers["Authorization"] = `OAuth ${currentAccount.token}`;
  }
  const res = await fetch("https://gql.twitch.tv/gql", { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GQL: ${res.status}`);
  return res.json();
}

async function fetchChannelRewards(channelLogin) {
  try {
    const data = await gqlFetch({
      operationName: "ChannelPointsContext",
      variables: { channelLogin, includeGoalTypes: ["CREATOR", "BOOST"] },
      extensions: { persistedQuery: { version: 1, sha256Hash: GQL_REWARDS_HASH } },
    });
    const rewards = data?.data?.community?.channel?.communityPointsSettings?.customRewards || [];
    return rewards.map(r => ({
      id: r.id, title: r.title, cost: r.cost,
      image: r.image?.url || r.defaultImage?.url || null,
      backgroundColor: r.backgroundColor || "#9147ff",
      isEnabled: r.isEnabled !== false, isPaused: !!r.isPaused,
      isInStock: r.isInStock !== false, cooldownExpiresAt: r.cooldownExpiresAt || null,
    }));
  } catch (e) {
    console.error("Failed to fetch channel rewards:", e);
    return [];
  }
}

async function fetchPrediction(channelLogin) {
  try {
    const data = await gqlFetch({
      operationName: "ChannelPointsPredictionContext",
      variables: { count: 1, channelLogin },
      extensions: { persistedQuery: { version: 1, sha256Hash: GQL_PREDICTIONS_HASH } },
    });
    const channel = data?.data?.community?.channel;
    if (!channel) return null;
    const event = channel.activePredictionEvents?.[0] || channel.lockedPredictionEvents?.[0] || channel.resolvedPredictionEvents?.edges?.[0]?.node;
    if (!event) return null;
    return normalizePrediction(event);
  } catch (e) {
    console.error("Failed to fetch prediction:", e);
    return null;
  }
}

function normalizePrediction(event) {
  const outcomes = (event.outcomes || []).map(o => ({
    id: o.id,
    title: o.title,
    color: o.color || "BLUE",
    totalPoints: o.totalPoints ?? o.channelPoints ?? 0,
    totalUsers: o.totalUsers ?? o.users ?? 0,
  }));
  const prediction = {
    id: event.id,
    title: event.title,
    status: event.status,
    createdAt: event.createdAt,
    lockedAt: event.lockedAt || null,
    endedAt: event.endedAt || null,
    predictionWindowSeconds: event.predictionWindowSeconds ?? event.predictionWindow ?? 120,
    outcomes,
    winningOutcomeId: event.winningOutcomeID || event.winningOutcomeId || event.winningOutcome?.id || null,
    userPrediction: null,
  };
  // Extract user's own prediction if present
  const userPred = event.prediction || event.self?.prediction;
  if (userPred) {
    prediction.userPrediction = {
      outcomeId: userPred.outcomeID || userPred.outcomeId || userPred.outcome?.id,
      points: userPred.points ?? userPred.amount ?? 0,
    };
  }
  return prediction;
}

async function fetchStreamStartedAt(channelLogin) {
  try {
    const data = await helixFetch(`streams?user_login=${channelLogin}`);
    return data.data?.[0]?.started_at || null;
  } catch {
    return null;
  }
}

function startPredictionPoll(channel) {
  if (predictionPolls[channel]) return;
  const poll = { timer: null, lastPrediction: null, lastJSON: null, streamStartedAt: undefined };
  predictionPolls[channel] = poll;
  async function tick() {
    if (!predictionPolls[channel]) return;
    if (poll.streamStartedAt === undefined) poll.streamStartedAt = await fetchStreamStartedAt(channel);
    let prediction = await fetchPrediction(channel);
    // GQL activePredictionEvent returns null for locked predictions — preserve non-terminal state
    if (!prediction && poll.lastPrediction && (poll.lastPrediction.status === "ACTIVE" || poll.lastPrediction.status === "LOCKED")) return;
    // Restore persisted user bet if GQL didn't return one
    if (prediction && !prediction.userPrediction) {
      const stored = await chrome.storage.local.get(`predBet:${prediction.id}`);
      if (stored[`predBet:${prediction.id}`]) prediction.userPrediction = stored[`predBet:${prediction.id}`];
    }
    // Clean up persisted bet on terminal states
    if (prediction && (prediction.status === "RESOLVED" || prediction.status === "CANCELED")) {
      chrome.storage.local.remove(`predBet:${prediction.id}`);
    }
    // Skip resolved/canceled predictions from before the current stream
    if (prediction && poll.streamStartedAt && (prediction.status === "RESOLVED" || prediction.status === "CANCELED") && prediction.createdAt && new Date(prediction.createdAt) < new Date(poll.streamStartedAt)) {
      prediction = null;
    }
    const json = JSON.stringify(prediction);
    if (json === poll.lastJSON) return;
    const prev = poll.lastPrediction;
    // Detect state transitions
    if (prediction && prev && prev.id === prediction.id && prev.status !== prediction.status) {
      const eventMap = { LOCKED: "locked", RESOLVED: "resolved", CANCELED: "canceled" };
      if (eventMap[prediction.status]) broadcast({ type: "prediction-event", event: eventMap[prediction.status], prediction }, channel);
    } else if (prediction && (!prev || prev.id !== prediction.id) && prediction.status === "ACTIVE") {
      broadcast({ type: "prediction-event", event: "started", prediction }, channel);
    }
    poll.lastPrediction = prediction;
    poll.lastJSON = json;
    broadcast({ type: "prediction-update", prediction }, channel);
  }
  tick();
  poll.timer = setInterval(tick, 5000);
}

function stopPredictionPoll(channel) {
  const poll = predictionPolls[channel];
  if (!poll) return;
  clearInterval(poll.timer);
  delete predictionPolls[channel];
}

// --- Pinned Chat GQL ---
async function fetchPinnedChat(channelUserId) {
  try {
    const data = await gqlFetch({
      operationName: "GetPinnedChat",
      variables: { channelID: channelUserId, count: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: GQL_PINNED_CHAT_HASH } },
    });
    const node = data?.data?.channel?.pinnedChatMessages?.edges?.[0]?.node;
    if (!node) return null;
    const pm = node.pinnedMessage;
    return {
      id: node.id,
      type: node.type,
      startsAt: node.startsAt,
      endsAt: node.endsAt,
      pinnedBy: node.pinnedBy ? { displayName: node.pinnedBy.displayName } : null,
      sender: pm?.sender ? {
        displayName: pm.sender.displayName,
        chatColor: pm.sender.chatColor,
        badges: (pm.sender.displayBadges || []).map(b => b.setID + "/" + b.version),
      } : null,
      text: pm?.content?.text || "",
    };
  } catch (e) {
    console.error("Failed to fetch pinned chat:", e);
    return null;
  }
}

function startPinnedPoll(channel) {
  if (pinnedPolls[channel]) return;
  const uid = channelUserIds[channel];
  if (!uid) return;
  const poll = { timer: null, lastJSON: null };
  pinnedPolls[channel] = poll;
  async function tick() {
    if (!pinnedPolls[channel]) return;
    const pin = await fetchPinnedChat(uid);
    const json = JSON.stringify(pin);
    if (json === poll.lastJSON) return;
    poll.lastJSON = json;
    broadcast({ type: "pinned-message", pin }, channel);
  }
  tick();
  poll.timer = setInterval(tick, 30000);
}

function stopPinnedPoll(channel) {
  const poll = pinnedPolls[channel];
  if (!poll) return;
  clearInterval(poll.timer);
  delete pinnedPolls[channel];
}

async function fetchVodInfo(videoId) {
  const data = await helixFetch(`videos?id=${videoId}`);
  const video = data.data?.[0];
  if (!video) return null;
  return { channel: video.user_login, userId: video.user_id };
}

async function fetchVodCommentsByOffset(videoId, offsetSeconds) {
  const data = await gqlFetch({
    operationName: "VideoCommentsByOffsetOrCursor",
    variables: { videoID: videoId, contentOffsetSeconds: offsetSeconds },
    extensions: { persistedQuery: { version: 1, sha256Hash: GQL_VOD_HASH } },
  });
  const comments = data?.data?.video?.comments;
  return {
    edges: comments?.edges || [],
    hasNext: comments?.pageInfo?.hasNextPage || false,
    cursor: comments?.edges?.at(-1)?.cursor || null,
  };
}

async function fetchVodCommentsByCursor(videoId, cursor) {
  const data = await gqlFetch({
    operationName: "VideoCommentsByOffsetOrCursor",
    variables: { videoID: videoId, cursor },
    extensions: { persistedQuery: { version: 1, sha256Hash: GQL_VOD_HASH } },
  });
  const comments = data?.data?.video?.comments;
  return {
    edges: comments?.edges || [],
    hasNext: comments?.pageInfo?.hasNextPage || false,
    cursor: comments?.edges?.at(-1)?.cursor || null,
  };
}

function vodCommentToIRC(edge, channel) {
  const node = edge.node;
  const commenter = node.commenter;
  if (!commenter) return null; // deleted user

  const fragments = node.message?.fragments || [];
  const trailing = fragments.map((f) => f.text).join("");

  // Build emotes tag from fragments that have emote data
  let emoteTag = "";
  const emoteParts = [];
  let charIdx = 0;
  for (const frag of fragments) {
    if (frag.emote) {
      const start = charIdx;
      const end = charIdx + frag.text.length - 1;
      emoteParts.push(`${frag.emote.emoteID}:${start}-${end}`);
    }
    charIdx += frag.text.length;
  }
  if (emoteParts.length) emoteTag = emoteParts.join("/");

  // Build badges tag
  const userBadges = node.message?.userBadges || [];
  const badgeStr = userBadges.map((b) => `${b.setID}/${b.version}`).join(",");

  return {
    command: "PRIVMSG",
    channel,
    username: commenter.login,
    trailing,
    _vodOffset: node.contentOffsetSeconds,
    tags: {
      "display-name": commenter.displayName,
      color: node.message?.userColor || "",
      id: node.id,
      badges: badgeStr,
      emotes: emoteTag || undefined,
    },
  };
}

async function drainVodComments(port, offset) {
  const vod = port._vod;
  if (!vod?.channel) return;

  // Fetch more if buffer doesn't cover this offset
  while (vod.endOffset < offset) {
    if (vod.fetching) return; // another fetch in progress, it'll drain when done
    vod.fetching = true;
    try {
      const result = vod.cursor
        ? await fetchVodCommentsByCursor(vod.videoId, vod.cursor)
        : await fetchVodCommentsByOffset(vod.videoId, offset);
      for (const edge of result.edges) {
        const irc = vodCommentToIRC(edge, vod.channel);
        if (irc) vod.comments.push(irc);
      }
      vod.cursor = result.cursor;
      if (result.edges.length) {
        vod.endOffset = result.edges.at(-1).node.contentOffsetSeconds;
      }
      if (!result.hasNext) {
        // Don't set Infinity — VOD may have comments later after a gap.
        // Advance to current offset so we re-check as video progresses.
        vod.endOffset = Math.max(vod.endOffset, offset);
        vod.cursor = null;
        break;
      }
    } catch (e) {
      console.error("VOD comment fetch error:", e);
      break;
    } finally {
      vod.fetching = false;
    }
  }

  // Drain comments up to current offset
  let i = 0;
  while (i < vod.comments.length && vod.comments[i]._vodOffset <= offset) i++;
  const ready = i > 0 ? vod.comments.splice(0, i) : [];
  if (ready.length) {
    port.postMessage({ type: "vod-comments", comments: ready });
  }
}

// --- Recent messages (robotty) ---
async function fetchRecentMessages(channel) {
  const res = await fetch(
    `https://recent-messages.robotty.de/api/v2/recent-messages/${channel}`,
  );
  if (!res.ok) throw new Error(`recent-messages: ${res.status}`);
  const { messages } = await res.json();
  const parsed = [];
  for (const raw of messages) {
    const msg = parseIRCMessage(raw);
    if (msg && (msg.command === "PRIVMSG" || msg.command === "CLEARCHAT" || msg.command === "CLEARMSG")) {
      parsed.push(msg);
    }
  }
  return parsed;
}

// --- Silent re-auth ---
let reauthPromise = null;

async function silentReauth() {
  if (reauthPromise) return reauthPromise;
  reauthPromise = (async () => {
    try {
      const redirectUrl = chrome.identity.getRedirectURL();
      const authUrl =
        `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
        `&response_type=token&scope=${encodeURIComponent("chat:read chat:edit channel:read:predictions channel:read:polls")}`;
      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: false,
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: 10000,
      });
      const hash = new URL(responseUrl).hash.substring(1);
      const token = new URLSearchParams(hash).get("access_token");
      if (!token) throw new Error("No token");
      const validation = await validateToken(token);
      if (!validation) throw new Error("Invalid token");
      const accounts = await getAccounts();
      const idx = accounts.findIndex((a) => a.userId === currentAccount.userId);
      if (idx >= 0) {
        accounts[idx].token = token;
        await chrome.storage.local.set({ accounts });
      }
      currentAccount = { ...currentAccount, token };
      if (ircSocket) ircSocket.close();
      connectIRC();
      return true;
    } catch (e) {
      console.error("Silent re-auth failed:", e);
      currentAccount = null;
      broadcast({ type: "account-info", account: null });
      return false;
    } finally {
      reauthPromise = null;
    }
  })();
  return reauthPromise;
}

// --- Helix API helper ---
async function helixFetch(endpoint) {
  if (!currentAccount) throw new Error("Not authenticated");
  const doFetch = () =>
    fetch(`https://api.twitch.tv/helix/${endpoint}`, {
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${currentAccount.token}` },
    });
  const res = await doFetch();
  if (res.ok) return res.json();
  if (res.status === 401 && (await silentReauth())) {
    const retry = await doFetch();
    if (retry.ok) return retry.json();
  }
  throw new Error(`Helix ${endpoint}: ${res.status}`);
}

async function getUserId(login) {
  const data = await helixFetch(`users?login=${login}`);
  return data.data?.[0]?.id || null;
}

// --- Port management ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return;
  ports.push(port);

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "channel-changed") {
      const { channel } = msg;
      // Store port's channel for cleanup
      port._channel = channel;
      joinChannel(channel);
      startPredictionPoll(channel);

      // Send account info
      port.postMessage({
        type: "account-info",
        account: currentAccount
          ? { login: currentAccount.login, userId: currentAccount.userId }
          : null,
      });

      // Fetch and send badges + emotes for this channel
      const settings = await getSettings();
      if (!currentAccount) {
        port.postMessage({ type: "channel-data", badges: {}, emotes: {}, settings });
        return;
      }
      try {
        const userId = await getUserId(channel);
        if (userId) {
          channelUserIds[channel] = userId;
          startPinnedPoll(channel);
          const [badges, emotes, recentMessages, rewards] = await Promise.all([
            fetchBadges(helixFetch, userId),
            fetchAllEmotes(userId),
            fetchRecentMessages(channel).catch((e) => {
              console.error("Failed to fetch recent messages:", e);
              return [];
            }),
            fetchChannelRewards(channel),
          ]);
          port.postMessage({ type: "channel-data", badges, emotes, rewards, settings });
          if (recentMessages.length) {
            port.postMessage({ type: "recent-messages", messages: recentMessages });
          }
        }
      } catch (e) {
        console.error("Failed to fetch channel data:", e);
      }
    }

    if (msg.type === "refresh-rewards") {
      const channel = port._channel;
      if (!channel) return;
      fetchChannelRewards(channel).then(rewards => {
        port.postMessage({ type: "rewards-updated", rewards });
      });
    }

    if (msg.type === "refresh-emotes") {
      const channel = port._channel;
      if (!channel || !currentAccount) return;
      try {
        const userId = channelUserIds[channel] || await getUserId(channel);
        if (userId) {
          await clearEmoteCache(userId);
          const emotes = await fetchAllEmotes(userId);
          port.postMessage({ type: "emotes-refreshed", emotes });
        }
      } catch (e) {
        console.error("Failed to refresh emotes:", e);
      }
    }

    if (msg.type === "vod-changed") {
      const { videoId } = msg;
      port._channel = null; // not a live channel
      port._vod = { videoId, comments: [], cursor: null, endOffset: -1, fetching: false };
      (async () => {
        const settings = await getSettings();
        const info = await fetchVodInfo(videoId);
        if (!info) return;
        port._vod.channel = info.channel;
        port._vod.userId = info.userId;
        const [vodBadges, vodEmotes] = await Promise.all([
          currentAccount ? fetchBadges(helixFetch, info.userId).catch(() => ({})) : {},
          fetchAllEmotes(info.userId).catch(() => ({})),
        ]);
        port.postMessage({
          type: "vod-channel-data",
          channel: info.channel,
          badges: vodBadges,
          emotes: vodEmotes,
          settings,
        });
        port.postMessage({
          type: "account-info",
          account: currentAccount ? { login: currentAccount.login, userId: currentAccount.userId } : null,
        });
      })().catch((e) => console.error("vod-changed error:", e));
    }

    if (msg.type === "vod-seek") {
      const vod = port._vod;
      if (!vod || msg.videoId !== vod.videoId) return;
      // Reset buffer and fetch from new offset
      vod.comments = [];
      vod.cursor = null;
      vod.endOffset = -1;
      drainVodComments(port, msg.offset);
    }

    if (msg.type === "vod-time") {
      const vod = port._vod;
      if (!vod || msg.videoId !== vod.videoId) return;
      drainVodComments(port, msg.offset);
    }

    if (msg.type === "send-message") {
      sendMessage(msg.channel, msg.text, msg.replyParentMsgId);
    }

    if (msg.type === "make-prediction") {
      if (!currentAccount) { port.postMessage({ type: "prediction-result", success: false, error: "Not logged in" }); return; }
      (async () => {
        try {
          await gqlFetch({
            operationName: "MakePrediction",
            variables: { input: { eventID: msg.eventId, outcomeID: msg.outcomeId, points: msg.points, transactionID: crypto.randomUUID() } },
            extensions: { persistedQuery: { version: 1, sha256Hash: GQL_MAKE_PREDICTION_HASH } },
          }, { auth: true });
          port.postMessage({ type: "prediction-result", success: true });
          // Persist user bet — GQL won't return it without matching auth
          const userPrediction = { outcomeId: msg.outcomeId, points: msg.points };
          chrome.storage.local.set({ [`predBet:${msg.eventId}`]: userPrediction });
          const poll = predictionPolls[port._channel];
          if (poll?.lastPrediction && poll.lastPrediction.id === msg.eventId) {
            poll.lastPrediction.userPrediction = userPrediction;
            poll.lastJSON = JSON.stringify(poll.lastPrediction);
            broadcast({ type: "prediction-update", prediction: poll.lastPrediction }, port._channel);
          }
        } catch (e) {
          port.postMessage({ type: "prediction-result", success: false, error: e.message });
        }
      })();
    }

    if (msg.type === "get-user-profile") {
      if (!currentAccount) {
        port.postMessage({ type: "user-profile", login: msg.login, profile: null });
        return;
      }
      helixFetch(`users?login=${msg.login}`).then((data) => {
        const user = data.data?.[0];
        port.postMessage({
          type: "user-profile",
          login: msg.login,
          profile: user
            ? {
                displayName: user.display_name,
                profileImageUrl: user.profile_image_url,
                createdAt: user.created_at,
              }
            : null,
        });
      });
    }
  });

  port.onDisconnect.addListener(() => {
    ports = ports.filter((p) => p !== port);
    if (port._channel) {
      // Only part if no other port is watching this channel
      const stillWatched = ports.some((p) => p._channel === port._channel);
      if (!stillWatched) {
        partChannel(port._channel);
        stopPredictionPoll(port._channel);
        stopPinnedPoll(port._channel);
      }
    }
  });
});

// --- Message handler for popup ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get-accounts") {
    getAccounts().then(sendResponse);
    return true;
  }
  if (msg.type === "add-account") {
    (async () => {
      try {
        const redirectUrl = chrome.identity.getRedirectURL();
        const authUrl =
          `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
          `&response_type=token&scope=${encodeURIComponent("chat:read chat:edit channel:read:predictions channel:read:polls")}&force_verify=true`;

        const responseUrl = await chrome.identity.launchWebAuthFlow({
          url: authUrl,
          interactive: true,
        });

        const hash = new URL(responseUrl).hash.substring(1);
        const params = new URLSearchParams(hash);
        const token = params.get("access_token");
        if (!token) throw new Error("No access token");

        const validation = await validateToken(token);
        if (!validation) throw new Error("Validation failed");

        let accounts = await getAccounts();
        for (const a of accounts) a.active = false;
        const idx = accounts.findIndex((a) => a.userId === validation.user_id);
        const account = {
          login: validation.login,
          userId: validation.user_id,
          token,
          active: true,
        };
        if (idx >= 0) accounts[idx] = account;
        else accounts.push(account);
        await chrome.storage.local.set({ accounts });

        currentAccount = account;
        if (ircSocket) ircSocket.close();
        connectIRC();
        broadcast({
          type: "account-info",
          account: { login: account.login, userId: account.userId },
        });

        sendResponse({ ok: true });
      } catch (e) {
        console.error("OAuth failed:", e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === "open-extensions") {
    chrome.tabs.create({ url: "chrome://extensions" });
    return;
  }
  if (msg.type === "reload-extension") {
    chrome.runtime.reload();
    return;
  }
  if (msg.type === "account-changed") {
    (async () => {
      currentAccount = await getActiveAccount();
      if (ircSocket) ircSocket.close();
      connectIRC();
      broadcast({
        type: "account-info",
        account: currentAccount
          ? { login: currentAccount.login, userId: currentAccount.userId }
          : null,
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// --- Init ---
async function init() {
  currentAccount = await getActiveAccount();
  connectIRC();
}

init();
