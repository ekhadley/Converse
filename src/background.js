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
let joinedChannels = new Set();
let ports = []; // connected content script ports
let currentAccount = null; // { login, userId, token } or null for anon

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
  if (ircSocket && ircSocket.readyState <= 1) return; // already open/connecting

  ircSocket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ircReady = false;

  ircSocket.onopen = () => {
    ircSocket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    if (currentAccount) {
      ircSocket.send(`PASS oauth:${currentAccount.token}`);
      ircSocket.send(`NICK ${currentAccount.login}`);
    } else {
      const anonNick = `justinfan${Math.floor(1000 + Math.random() * 99000)}`;
      ircSocket.send(`PASS SCHMOOPIIE`);
      ircSocket.send(`NICK ${anonNick}`);
    }
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
        // Rejoin all channels
        for (const ch of joinedChannels) {
          ircSocket.send(`JOIN #${ch}`);
        }
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
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectIRC();
    }, reconnectDelay);
  };

  ircSocket.onerror = () => {
    ircSocket.close();
  };
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
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {}
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

// --- Helix API helper ---
async function helixFetch(endpoint) {
  const account = currentAccount || (await getActiveAccount());
  const token = account?.token;
  const headers = { "Client-Id": CLIENT_ID };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`https://api.twitch.tv/helix/${endpoint}`, {
    headers,
  });
  if (!res.ok) throw new Error(`Helix ${endpoint}: ${res.status}`);
  return res.json();
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
      try {
        const userId = await getUserId(channel);
        if (userId) {
          const [badges, emotes, settings, recentMessages] = await Promise.all([
            fetchBadges(CLIENT_ID, currentAccount?.token, userId),
            fetchAllEmotes(userId),
            getSettings(),
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
