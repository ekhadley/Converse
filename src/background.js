import {
  getAccounts,
  getActiveAccount,
  validateToken,
  CLIENT_ID,
} from "./lib/auth.js";
import { parseIRCMessage } from "./lib/irc.js";
import { fetchBadges } from "./lib/badges.js";
import { fetchAllEmotes } from "./lib/emotes.js";
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

// --- EventSub state ---
let eventSubSocket, eventSubSessionId, eventSubReconnectDelay = 1000;
let eventSubKeepaliveTimeout, eventSubKeepaliveSeconds = 10;
let eventSubSubscriptions = {}; // subId -> { type, channel }
let eventSubChannelSubs = {}; // channel -> [subIds]
let eventSubReady = false, eventSubHasScopes = false;
let eventSubOldSocket = null; // during session_reconnect transition
let userPredictions = {}; // predictionId -> { outcomeId, points }

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
    const map = {};
    for (const r of rewards) map[r.id] = r.title;
    return map;
  } catch (e) {
    console.error("Failed to fetch channel rewards:", e);
    return {};
  }
}

async function fetchPrediction(channelLogin) {
  try {
    const data = await gqlFetch({
      operationName: "ChannelPointsPredictionContext",
      variables: { count: 1, channelLogin },
      extensions: { persistedQuery: { version: 1, sha256Hash: GQL_PREDICTIONS_HASH } },
    }, currentAccount ? { auth: true } : {});
    // Navigate the response — exact path may vary, log on first success to verify
    const channel = data?.data?.community?.channel;
    if (!channel) return null;
    const event = channel.activePredictionEvent || channel.activePredictionEvents?.[0] || channel.communityPointsSettings?.activePredictionEvent;
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
    winningOutcomeId: event.winningOutcomeID || event.winningOutcomeId || null,
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

function startPredictionPoll(channel) {
  if (predictionPolls[channel]) return;
  const poll = { timer: null, lastPrediction: null, lastJSON: null };
  predictionPolls[channel] = poll;
  async function tick() {
    if (!predictionPolls[channel]) return;
    const prediction = await fetchPrediction(channel);
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
      checkEventSubScopes().then(() => { disconnectEventSub(); connectEventSub(); });
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

async function helixPost(endpoint, body) {
  if (!currentAccount) throw new Error("Not authenticated");
  const doFetch = () =>
    fetch(`https://api.twitch.tv/helix/${endpoint}`, {
      method: "POST",
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${currentAccount.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const res = await doFetch();
  if (res.ok) return res.json();
  if (res.status === 401 && (await silentReauth())) {
    const retry = await doFetch();
    if (retry.ok) return retry.json();
  }
  throw new Error(`Helix POST ${endpoint}: ${res.status}`);
}

async function helixDelete(endpoint) {
  if (!currentAccount) throw new Error("Not authenticated");
  const doFetch = () =>
    fetch(`https://api.twitch.tv/helix/${endpoint}`, {
      method: "DELETE",
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${currentAccount.token}` },
    });
  const res = await doFetch();
  if (res.status === 204 || res.ok) return;
  if (res.status === 401 && (await silentReauth())) {
    const retry = await doFetch();
    if (retry.status === 204 || retry.ok) return;
  }
  throw new Error(`Helix DELETE ${endpoint}: ${res.status}`);
}

async function getUserId(login) {
  const data = await helixFetch(`users?login=${login}`);
  return data.data?.[0]?.id || null;
}

// --- EventSub WebSocket ---
async function checkEventSubScopes() {
  if (!currentAccount) { eventSubHasScopes = false; return; }
  const validation = await validateToken(currentAccount.token);
  eventSubHasScopes = (validation?.scopes || []).includes("channel:read:predictions");
}

function connectEventSub(url) {
  if (!currentAccount || !eventSubHasScopes) return;
  const ws = new WebSocket(url || "wss://eventsub.wss.twitch.tv/ws");

  ws.onopen = () => { eventSubReconnectDelay = 1000; };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const type = data.metadata?.message_type;

    if (type === "session_welcome") {
      eventSubSessionId = data.payload.session.id;
      eventSubKeepaliveSeconds = data.payload.session.keepalive_timeout_seconds || 10;
      resetEventSubKeepalive();
      if (eventSubOldSocket) {
        eventSubOldSocket.close();
        eventSubOldSocket = null;
      } else {
        eventSubReady = true;
        eventSubSocket = ws;
        resubscribeAllEventSub();
      }
      return;
    }

    if (type === "session_keepalive" || type === "notification") resetEventSubKeepalive();

    if (type === "session_reconnect") {
      eventSubOldSocket = ws;
      connectEventSub(data.payload.session.reconnect_url);
      return;
    }

    if (type === "notification") {
      handleEventSubNotification(data.metadata.subscription_type, data.payload);
    }

    if (type === "revocation") {
      const sub = data.payload.subscription;
      console.warn("EventSub revocation:", sub.type, sub.status);
      const tracked = eventSubSubscriptions[sub.id];
      if (tracked) {
        delete eventSubSubscriptions[sub.id];
        const subs = eventSubChannelSubs[tracked.channel];
        if (subs) {
          eventSubChannelSubs[tracked.channel] = subs.filter(id => id !== sub.id);
          if (!eventSubChannelSubs[tracked.channel].length) {
            delete eventSubChannelSubs[tracked.channel];
            startPredictionPoll(tracked.channel);
          }
        }
      }
    }
  };

  ws.onclose = () => {
    clearTimeout(eventSubKeepaliveTimeout);
    if (ws === eventSubOldSocket) { eventSubOldSocket = null; return; }
    eventSubReady = false;
    eventSubSessionId = null;
    eventSubSubscriptions = {};
    eventSubChannelSubs = {};
    for (const ch of joinedChannels) {
      if (!predictionPolls[ch]) startPredictionPoll(ch);
    }
    setTimeout(() => {
      eventSubReconnectDelay = Math.min(eventSubReconnectDelay * 2, 30000);
      connectEventSub();
    }, eventSubReconnectDelay);
  };

  ws.onerror = () => { ws.close(); };
}

function resetEventSubKeepalive() {
  clearTimeout(eventSubKeepaliveTimeout);
  eventSubKeepaliveTimeout = setTimeout(() => {
    console.warn("EventSub keepalive timeout, reconnecting");
    if (eventSubSocket) eventSubSocket.close();
  }, (eventSubKeepaliveSeconds + 5) * 1000);
}

function disconnectEventSub() {
  clearTimeout(eventSubKeepaliveTimeout);
  eventSubReady = false;
  eventSubSessionId = null;
  eventSubSubscriptions = {};
  eventSubChannelSubs = {};
  if (eventSubOldSocket) { eventSubOldSocket.close(); eventSubOldSocket = null; }
  if (eventSubSocket) { const ws = eventSubSocket; eventSubSocket = null; ws.close(); }
}

// --- EventSub subscription management ---
async function eventSubSubscribe(type, version, condition, channel) {
  if (!eventSubSessionId) return;
  try {
    const data = await helixPost("eventsub/subscriptions", {
      type, version, condition,
      transport: { method: "websocket", session_id: eventSubSessionId },
    });
    const sub = data.data?.[0];
    if (sub) {
      eventSubSubscriptions[sub.id] = { type, channel };
      if (!eventSubChannelSubs[channel]) eventSubChannelSubs[channel] = [];
      eventSubChannelSubs[channel].push(sub.id);
    }
  } catch (e) {
    console.error(`EventSub subscribe ${type} failed:`, e);
  }
}

async function eventSubUnsubscribeChannel(channel) {
  const subIds = eventSubChannelSubs[channel];
  if (!subIds) return;
  delete eventSubChannelSubs[channel];
  for (const id of subIds) {
    delete eventSubSubscriptions[id];
    helixDelete(`eventsub/subscriptions?id=${id}`).catch(e => console.error("EventSub unsub failed:", e));
  }
}

async function subscribeChannelPredictions(channel, broadcasterId) {
  const cond = { broadcaster_user_id: broadcasterId };
  await Promise.all([
    eventSubSubscribe("channel.prediction.begin", "1", cond, channel),
    eventSubSubscribe("channel.prediction.progress", "1", cond, channel),
    eventSubSubscribe("channel.prediction.lock", "1", cond, channel),
    eventSubSubscribe("channel.prediction.end", "1", cond, channel),
  ]);
}

// Stub — subscribe logic ready, no UI yet
async function subscribeChannelPolls(_channel, _broadcasterId) {}

async function resubscribeAllEventSub() {
  for (const ch of joinedChannels) {
    const uid = channelUserIds[ch];
    if (!uid) continue;
    await subscribeChannelPredictions(ch, uid);
    stopPredictionPoll(ch);
  }
}

// --- EventSub notification handling ---
function handleEventSubNotification(subscriptionType, payload) {
  if (subscriptionType.startsWith("channel.prediction.")) {
    const event = payload.event;
    const channel = Object.keys(channelUserIds).find(ch => channelUserIds[ch] === event.broadcaster_user_id);
    if (channel) handlePredictionEvent(subscriptionType, event, channel);
  }
}

function handlePredictionEvent(subscriptionType, event, channel) {
  const prediction = normalizeEventSubPrediction(subscriptionType, event);
  const cached = userPredictions[prediction.id];
  if (cached) prediction.userPrediction = cached;

  if (subscriptionType === "channel.prediction.end") {
    const endEvent = prediction.status === "CANCELED" ? "canceled" : "resolved";
    broadcast({ type: "prediction-event", event: endEvent, prediction }, channel);
    delete userPredictions[prediction.id];
  } else {
    const eventMap = {
      "channel.prediction.begin": "started",
      "channel.prediction.lock": "locked",
    };
    if (eventMap[subscriptionType]) broadcast({ type: "prediction-event", event: eventMap[subscriptionType], prediction }, channel);
  }

  broadcast({ type: "prediction-update", prediction }, channel);

  if (subscriptionType === "channel.prediction.begin" && currentAccount) {
    fetchPrediction(channel).then(gqlPred => {
      if (gqlPred?.userPrediction) userPredictions[gqlPred.id] = gqlPred.userPrediction;
    }).catch(() => {});
  }
}

function normalizeEventSubPrediction(subscriptionType, event) {
  const statusMap = {
    "channel.prediction.begin": "ACTIVE",
    "channel.prediction.progress": "ACTIVE",
    "channel.prediction.lock": "LOCKED",
    "channel.prediction.end": event.status === "canceled" ? "CANCELED" : "RESOLVED",
  };
  const outcomes = (event.outcomes || []).map(o => ({
    id: o.id,
    title: o.title,
    color: o.color?.toUpperCase() || "BLUE",
    totalPoints: o.channel_points || 0,
    totalUsers: o.users || 0,
  }));
  return {
    id: event.id,
    title: event.title,
    status: statusMap[subscriptionType] || "ACTIVE",
    createdAt: event.started_at,
    lockedAt: event.locked_at || null,
    endedAt: event.ended_at || null,
    predictionWindowSeconds: event.prediction_window || 120,
    outcomes,
    winningOutcomeId: event.winning_outcome_id || null,
    userPrediction: null,
  };
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
      // Prediction poll starts as GQL fallback; stopped if EventSub takes over below
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
          if (eventSubHasScopes && eventSubReady) {
            subscribeChannelPredictions(channel, userId);
            stopPredictionPoll(channel);
          }
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
          // Force-fetch to update userPrediction state
          const prediction = await fetchPrediction(port._channel);
          if (prediction) {
            if (prediction.userPrediction) userPredictions[prediction.id] = prediction.userPrediction;
            const poll = predictionPolls[port._channel];
            if (poll) { poll.lastPrediction = prediction; poll.lastJSON = JSON.stringify(prediction); }
            broadcast({ type: "prediction-update", prediction }, port._channel);
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
        eventSubUnsubscribeChannel(port._channel);
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

        // Reconnect IRC + EventSub with new account
        currentAccount = account;
        if (ircSocket) ircSocket.close();
        connectIRC();
        disconnectEventSub();
        checkEventSubScopes().then(() => connectEventSub());
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
      disconnectEventSub();
      checkEventSubScopes().then(() => connectEventSub());
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
  await checkEventSubScopes();
  connectEventSub();
}

init();
