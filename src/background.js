import {
  getAccounts,
  getActiveAccount,
  validateToken,
  CLIENT_ID,
} from "./lib/auth.js";
import { parseIRCMessage } from "./lib/irc.js";
import { fetchBadges } from "./lib/badges.js";
import { fetchAllEmotes } from "./lib/emotes.js";

// --- State ---
let ircSocket = null;
let ircReady = false;
let reconnectDelay = 1000;
let ircPingInterval = null;
let ircPongReceived = true;
let joinedChannels = new Set();
let ports = []; // connected content script ports
let currentAccount = null; // { login, userId, token }

// --- Settings defaults ---
const DEFAULT_SETTINGS = {
  fontSize: 13,
  showTimestamps: true,
  showBadges: true,
  emoteProviders: { twitch: true, "7tv": true, bttv: true, ffz: true },
  messageCap: 500,
  chatWidth: null,
};

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

function sendMessage(channel, text) {
  if (!currentAccount || !ircReady) return;
  ircSocket.send(`PRIVMSG #${channel} :${text}`);
}

function broadcast(msg) {
  ports = ports.filter((port) => {
    try {
      port.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  });
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
        `&response_type=token&scope=${encodeURIComponent("chat:read chat:edit")}`;
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
          const [badges, emotes, recentMessages] = await Promise.all([
            fetchBadges(helixFetch, userId),
            fetchAllEmotes(userId),
            fetchRecentMessages(channel).catch((e) => {
              console.error("Failed to fetch recent messages:", e);
              return [];
            }),
          ]);
          port.postMessage({ type: "channel-data", badges, emotes, settings });
          if (recentMessages.length) {
            port.postMessage({ type: "recent-messages", messages: recentMessages });
          }
        }
      } catch (e) {
        console.error("Failed to fetch channel data:", e);
      }
    }

    if (msg.type === "send-message") {
      sendMessage(msg.channel, msg.text);
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
      if (!stillWatched) partChannel(port._channel);
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
          `&response_type=token&scope=${encodeURIComponent("chat:read chat:edit")}&force_verify=true`;

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

        // Reconnect IRC with new account
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
