// Converse — content script
// Replaces Twitch's native chat with a custom container.
// Communicates with background.js via long-lived port.

let port = null;
let currentChannel = null;
let badges = {};
let thirdPartyEmotes = {};
let settings = {
  fontSize: 13,
  messageSpacing: 2,
  showTimestamps: true,
  showBadges: true,
  emoteProviders: { twitch: true, "7tv": true, bttv: true, ffz: true },
  messageCap: 500,
  chatWidth: null,
};
let account = null; // { login, userId } or null
let autoScroll = true;
let seenMsgIds = new Set();
let messageBuffer = [];
let usercardEl = null;
let chatCollapsed = false;
let extensionEnabled = true;
let chatContainer = null;
let messageList = null;
let msgEven = false;
let inputEl = null;
let pauseBar = null;
let toggleBtn = null;
let extToggleBtn = null;
let btnContainer = null;
let scrollThumb = null;

// --- Channel detection ---
function getChannel() {
  const match = location.pathname.match(/^\/([a-zA-Z0-9_]{1,25})(?:\/|$)/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  // Exclude known non-channel paths
  const exclude = [
    "directory",
    "settings",
    "payments",
    "inventory",
    "wallet",
    "friends",
    "subscriptions",
    "drops",
    "search",
  ];
  if (exclude.includes(name)) return null;
  return name;
}

// --- Port setup ---
function connectPort() {
  port = chrome.runtime.connect({ name: "chat" });

  port.onMessage.addListener((msg) => {
    if (msg.type === "irc-message") handleIRCMessage(msg.data);
    if (msg.type === "recent-messages") {
      for (const m of msg.messages) handleIRCMessage(m);
    }
    if (msg.type === "channel-data") {
      badges = msg.badges || {};
      thirdPartyEmotes = msg.emotes || {};
      if (msg.settings) applySettings(msg.settings);
    }
    if (msg.type === "account-info") {
      account = msg.account;
      updateInputPlaceholder();
    }
    if (msg.type === "user-profile") {
      fillUsercardProfile(msg.login, msg.profile);
    }
  });

  port.onDisconnect.addListener(() => {
    // Extension context dies on extension reload — don't reconnect
    if (!chrome.runtime?.id) return;
    setTimeout(connectPort, 1000);
  });
}

// --- Settings ---
function applySettings(s) {
  settings = { ...settings, ...s };
  if (chatContainer) {
    chatContainer.style.fontSize = settings.fontSize + "px";
    chatContainer.style.setProperty("--cvs-msg-spacing", settings.messageSpacing + "px");
    if (settings.bgOdd) chatContainer.style.setProperty("--cvs-bg-odd", settings.bgOdd);
    if (settings.bgEven) chatContainer.style.setProperty("--cvs-bg-even", settings.bgEven);
    if (settings.chatWidth) setChatWidth(settings.chatWidth);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) applySettings(changes.settings.newValue);
});

// --- DOM setup ---
function buildChatUI(shell) {
  // Hide native Twitch chat children via class (keeps Twitch JS alive)
  shell.classList.add("cvs-active");

  chatContainer = document.createElement("div");
  chatContainer.id = "cvs-chat";
  chatContainer.style.fontSize = settings.fontSize + "px";
  chatContainer.style.setProperty("--cvs-msg-spacing", settings.messageSpacing + "px");

  // Message list
  messageList = document.createElement("div");
  messageList.className = "cvs-messages";
  messageList.addEventListener("scroll", onScroll);
  messageList.addEventListener("mouseover", (e) => {
    if (tooltipLocked) return;
    const emote = e.target.closest(".cvs-emote");
    if (emote) { showTooltip(emote); tooltipLocked = true; }
  });
  messageList.addEventListener("mousemove", (e) => {
    tooltipLocked = false;
    const emote = e.target.closest(".cvs-emote");
    if (emote) showTooltip(emote);
    else hideTooltip();
  });
  messageList.addEventListener("mouseleave", hideTooltip);
  messageList.addEventListener("click", (e) => {
    const userSpan = e.target.closest(".cvs-user");
    if (!userSpan) return;
    const line = userSpan.closest(".cvs-line");
    if (!line) return;
    openUsercard(line.dataset.user, e);
  });

  // Pause bar
  pauseBar = document.createElement("div");
  pauseBar.className = "cvs-pause-bar cvs-hidden";
  pauseBar.textContent = "Chat paused";
  pauseBar.addEventListener("click", resumeScroll);

  // Input area
  const inputWrap = document.createElement("div");
  inputWrap.className = "cvs-input-wrap";

  inputEl = document.createElement("input");
  inputEl.className = "cvs-input";
  inputEl.type = "text";
  inputEl.maxLength = 500;
  updateInputPlaceholder();
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && inputEl.value.trim()) {
      const text = inputEl.value.trim();
      if (account && currentChannel) {
        port.postMessage({
          type: "send-message",
          channel: currentChannel,
          text,
        });
        // Local echo — Twitch IRC doesn't echo back your own PRIVMSGs
        handleIRCMessage({
          command: "PRIVMSG",
          channel: currentChannel,
          username: account.login,
          trailing: text,
          tags: {
            "display-name": account.login,
            "tmi-sent-ts": String(Date.now()),
          },
        });
        inputEl.value = "";
      }
    }
  });

  // Resize handle
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "cvs-resize-handle";
  resizeHandle.addEventListener("mousedown", startResize);

  // Custom scrollbar
  const scrollbar = document.createElement("div");
  scrollbar.className = "cvs-scrollbar";
  scrollThumb = document.createElement("div");
  scrollThumb.className = "cvs-scrollbar-thumb";
  scrollbar.appendChild(scrollThumb);
  scrollThumb.addEventListener("mousedown", startScrollDrag);
  scrollbar.addEventListener("mousedown", (e) => {
    if (e.target !== scrollbar) return;
    const rect = scrollbar.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    messageList.scrollTop = ratio * (messageList.scrollHeight - messageList.clientHeight);
  });
  messageList.addEventListener("scroll", updateScrollbar);

  inputWrap.appendChild(inputEl);
  chatContainer.appendChild(resizeHandle);
  chatContainer.appendChild(messageList);
  chatContainer.appendChild(scrollbar);
  chatContainer.appendChild(pauseBar);
  chatContainer.appendChild(inputWrap);
  shell.appendChild(chatContainer);
}

function updateInputPlaceholder() {
  if (!inputEl) return;
  if (account) {
    inputEl.placeholder = `Chat as ${account.login}`;
    inputEl.disabled = false;
  } else {
    inputEl.placeholder = "Log in to chat";
    inputEl.disabled = true;
  }
}

// --- Scroll ---
function onScroll() {
  const el = messageList;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  if (atBottom && !autoScroll) resumeScroll();
  if (!atBottom && autoScroll) {
    autoScroll = false;
    pauseBar.classList.remove("cvs-hidden");
  }
}

function resumeScroll() {
  autoScroll = true;
  pauseBar.classList.add("cvs-hidden");
  messageList.scrollTop = messageList.scrollHeight;
}

function scrollIfNeeded() {
  if (autoScroll) messageList.scrollTop = messageList.scrollHeight;
}

// --- Custom scrollbar ---
function updateScrollbar() {
  if (!scrollThumb || !messageList) return;
  const el = messageList;
  const track = scrollThumb.parentElement;
  track.style.top = el.offsetTop + "px";
  track.style.height = el.offsetHeight + "px";
  if (el.scrollHeight <= el.clientHeight) {
    track.style.display = "none";
    return;
  }
  track.style.display = "";
  const ratio = el.clientHeight / el.scrollHeight;
  const thumbH = Math.max(30, ratio * el.clientHeight);
  const maxScroll = el.scrollHeight - el.clientHeight;
  const thumbTop = (el.scrollTop / maxScroll) * (el.clientHeight - thumbH);
  scrollThumb.style.height = thumbH + "px";
  scrollThumb.style.top = thumbTop + "px";
}

function startScrollDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  scrollThumb.classList.add("cvs-dragging");
  const startY = e.clientY;
  const startScroll = messageList.scrollTop;
  const maxScroll = messageList.scrollHeight - messageList.clientHeight;
  const ratio = messageList.clientHeight / messageList.scrollHeight;
  const thumbH = Math.max(30, ratio * messageList.clientHeight);
  const trackH = messageList.clientHeight - thumbH;

  function onMove(e) {
    messageList.scrollTop = startScroll + ((e.clientY - startY) / trackH) * maxScroll;
  }
  function onUp() {
    scrollThumb.classList.remove("cvs-dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// --- Resize ---
// We inject a single <style> element with !important overrides to resize the chat,
// player, and info panel. Theatre and normal modes have different Twitch layouts:
//
// Theatre: right-column--theatre is position:fixed with right:0 and left:Xpx.
//   Player is position:fixed filling viewport. We override left:auto so width
//   controls the column, and set the player's right edge to match.
//
// Normal: right-column is 0-width in flex layout. Chat overlays via
//   position:absolute + translateX(-34rem) on the inner column. Player has
//   inline width set by Twitch JS. Info panel is full-width under the chat.
//   We override the chat column transform, player right/width, and info margin.

let cvsStyleEl = null;

function ensureResizeStyle() {
  if (cvsStyleEl) return;
  cvsStyleEl = document.createElement("style");
  cvsStyleEl.id = "cvs-resize-overrides";
  document.head.appendChild(cvsStyleEl);
}

function isTheatreMode() {
  return !!document.querySelector("[class*='right-column--theatre'], [class*='right-column--theater']");
}

function chatWidthCSS(w, dragging) {
  const t = dragging ? "transition: none !important;" : "";

  const playerVisuals = `
    background: #000 !important;
  `;
  // Force every element in the player chain to fill the player height.
  // padding-bottom:0 neutralizes tw-aspect's aspect ratio enforcement.
  // height:100% + object-fit:contain handles letterboxing + centering.
  const playerChildCap = `
    .persistent-player > :not(#cvs-btn-container),
    .persistent-player [class*='video-player'],
    .persistent-player [class*='video-player__container'],
    .persistent-player [class*='video-ref'] {
      height: 100% !important;
      padding-bottom: 0 !important;
    }
    .persistent-player video {
      object-fit: contain !important;
      width: 100% !important;
      height: 100% !important;
    }
  `;

  if (isTheatreMode()) {
    // Theatre: fixed container anchored to right edge of viewport
    return `
      [class*='right-column--theatre'],
      [class*='right-column--theater'] {
        width: ${w} !important;
        left: auto !important;
        ${t}
      }
      [class*='right-column--theatre'] [class*='channel-root__right-column'],
      [class*='right-column--theater'] [class*='channel-root__right-column'] {
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        transform: none !important;
        ${t}
      }
      .persistent-player {
        right: ${w} !important;
        width: auto !important;
        height: 100% !important;
        max-height: none !important;
        ${playerVisuals}
        ${t}
      }
      ${playerChildCap}
    `;
  }

  // Normal: chat overlays from right, player/info need explicit offsets
  return `
    [class*='channel-root__right-column'] {
      width: ${w} !important;
      min-width: ${w} !important;
      max-width: ${w} !important;
      transform: translateX(-${w}) !important;
      ${t}
    }
    .persistent-player {
      right: ${w} !important;
      width: auto !important;
      height: calc(-16rem + 100vh) !important;
      ${playerVisuals}
      ${t}
    }
    [class*='channel-root__info'] {
      padding-right: calc(${w} - 340px) !important;
      box-sizing: border-box !important;
      margin-top: calc(-16rem + 100vh) !important;
    }
    ${playerChildCap}
  `;
}

function setChatWidth(width) {
  ensureResizeStyle();
  cvsStyleEl.textContent = chatWidthCSS(width + "px", false);
}

function startResize(e) {
  e.preventDefault();
  if (chatCollapsed) {
    chatCollapsed = false;
    updateToggleIcon();
  }
  const startX = e.clientX;
  const startWidth = chatContainer.getBoundingClientRect().width;
  let lastWidth = startWidth;

  function onMove(e) {
    const delta = startX - e.clientX;
    lastWidth = Math.max(250, Math.min(800, startWidth + delta));
    ensureResizeStyle();
    cvsStyleEl.textContent = chatWidthCSS(lastWidth + "px", true);
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    setChatWidth(lastWidth);
    chrome.storage.local.get("settings", ({ settings: s }) => {
      chrome.storage.local.set({
        settings: { ...settings, ...s, chatWidth: lastWidth },
      });
    });
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// --- Chat collapse toggle ---

const chatToggleSVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M2 3h16a1 1 0 011 1v10a1 1 0 01-1 1h-5.6l-2.7 2.7a1 1 0 01-1.4 0L5.6 15H2a1 1 0 01-1-1V4a1 1 0 011-1zm1 2v8h3.4l1.6 1.6L9.6 13H17V5H3z"/></svg>`;
// "C" logo for Converse extension toggle
const extToggleSVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zm1.2 3.2a4 4 0 00-4.5 1.5.75.75 0 001.2.9 2.5 2.5 0 014.1 2.4 2.5 2.5 0 01-4.1 1.3.75.75 0 00-1.1 1A4 4 0 1011.2 6.7z"/></svg>`;

function collapsedCSS() {
  if (isTheatreMode()) {
    return `
      [class*='right-column--theatre'],
      [class*='right-column--theater'] {
        width: 0 !important;
        left: auto !important;
        overflow: hidden !important;
        transition: none !important;
      }
      [class*='right-column--theatre'] [class*='channel-root__right-column'],
      [class*='right-column--theater'] [class*='channel-root__right-column'] {
        transform: none !important;
        transition: none !important;
      }
      .persistent-player {
        right: 0 !important;
        width: auto !important;
      }
    `;
  }
  return `
    [class*='channel-root__right-column'] {
      width: 0 !important;
      min-width: 0 !important;
      max-width: 0 !important;
      transform: none !important;
      overflow: hidden !important;
      transition: none !important;
    }
    .persistent-player {
      right: 0 !important;
      width: auto !important;
    }
    [class*='channel-root__info'] {
      padding-right: 0 !important;
    }
  `;
}

function toggleChat() {
  chatCollapsed = !chatCollapsed;
  ensureResizeStyle();
  if (chatCollapsed) {
    cvsStyleEl.textContent = collapsedCSS();
  } else {
    const w = settings.chatWidth || 340;
    setChatWidth(w);
  }
  updateToggleIcon();
}

function updateToggleIcon() {
  if (!toggleBtn) return;
  toggleBtn.style.opacity = chatCollapsed ? "0.5" : "1";
}

function toggleExtension() {
  extensionEnabled = !extensionEnabled;
  const shell = document.querySelector(".chat-shell, [class*='chat-shell']");
  if (!extensionEnabled) {
    // Show native Twitch chat, hide Converse
    if (shell) shell.classList.remove("cvs-active");
    if (cvsStyleEl) cvsStyleEl.textContent = "";
  } else {
    // Show Converse, hide native Twitch chat
    if (shell) shell.classList.add("cvs-active");
    if (chatCollapsed) {
      ensureResizeStyle();
      cvsStyleEl.textContent = collapsedCSS();
    } else if (settings.chatWidth) {
      setChatWidth(settings.chatWidth);
    }
  }
  updateExtToggleIcon();
}

function updateExtToggleIcon() {
  if (!extToggleBtn) return;
  extToggleBtn.style.opacity = extensionEnabled ? "1" : "0.5";
}

function injectToggleButton() {
  // Place buttons in a container anchored to top-right of the player area
  const player = document.querySelector(".persistent-player");
  if (!player || document.querySelector("#cvs-btn-container")) return;

  btnContainer = document.createElement("div");
  btnContainer.id = "cvs-btn-container";

  extToggleBtn = document.createElement("button");
  extToggleBtn.id = "cvs-toggle-ext";
  extToggleBtn.title = "Toggle Converse / Twitch chat";
  extToggleBtn.innerHTML = extToggleSVG;
  extToggleBtn.addEventListener("click", toggleExtension);

  toggleBtn = document.createElement("button");
  toggleBtn.id = "cvs-toggle-chat";
  toggleBtn.title = "Toggle chat visibility";
  toggleBtn.innerHTML = chatToggleSVG;
  toggleBtn.addEventListener("click", toggleChat);

  btnContainer.appendChild(extToggleBtn);
  btnContainer.appendChild(toggleBtn);
  player.appendChild(btnContainer);
  updateToggleIcon();
  updateExtToggleIcon();
}

// --- IRC message rendering ---
function handleIRCMessage(msg) {
  if (!messageList) return;

  if (msg.command === "CLEARCHAT") {
    if (msg.trailing) {
      // Clear specific user
      const els = messageList.querySelectorAll(
        `[data-user="${msg.trailing}"]`,
      );
      for (const el of els) el.remove();
    } else {
      messageList.innerHTML = "";
    }
    updateScrollbar();
    return;
  }

  if (msg.command === "CLEARMSG") {
    const targetId = msg.tags?.["target-msg-id"];
    if (targetId) {
      const el = messageList.querySelector(`[data-msg-id="${targetId}"]`);
      if (el) el.remove();
    }
    updateScrollbar();
    return;
  }

  if (msg.command !== "PRIVMSG") return;
  if (msg.channel !== currentChannel) return;

  // Deduplicate history vs live messages
  const msgId = msg.tags?.id;
  if (msgId) {
    if (seenMsgIds.has(msgId)) return;
    seenMsgIds.add(msgId);
  }

  // Buffer message for usercard history
  messageBuffer.push(msg);
  if (messageBuffer.length > settings.messageCap) {
    messageBuffer = messageBuffer.slice(-settings.messageCap);
  }

  const line = document.createElement("div");
  line.className = "cvs-line" + (msgEven ? " cvs-line-even" : "");
  msgEven = !msgEven;
  line.dataset.user = msg.username;
  if (msg.tags?.id) line.dataset.msgId = msg.tags.id;

  // Timestamp
  if (settings.showTimestamps) {
    const ts = document.createElement("span");
    ts.className = "cvs-ts";
    const d = msg.tags?.["tmi-sent-ts"]
      ? new Date(parseInt(msg.tags["tmi-sent-ts"]))
      : new Date();
    ts.textContent =
      d.getHours().toString().padStart(2, "0") +
      ":" +
      d.getMinutes().toString().padStart(2, "0");
    line.appendChild(ts);
  }

  // Badges
  if (settings.showBadges && msg.tags?.badges) {
    const badgeStr = msg.tags.badges;
    for (const badge of badgeStr.split(",")) {
      if (!badge) continue;
      const url = badges[badge];
      if (url) {
        const img = document.createElement("img");
        img.className = "cvs-badge";
        img.src = url;
        img.alt = badge.split("/")[0];
        line.appendChild(img);
      }
    }
  }

  // Username
  const userSpan = document.createElement("span");
  userSpan.className = "cvs-user";
  const displayName = msg.tags?.["display-name"] || msg.username;
  userSpan.textContent = displayName;
  const color = msg.tags?.color || hashColor(msg.username);
  userSpan.style.color = color;
  line.appendChild(userSpan);

  // Separator
  const sep = document.createElement("span");
  sep.className = "cvs-sep";
  sep.textContent = ": ";
  line.appendChild(sep);

  // Message body with emotes
  const bodySpan = document.createElement("span");
  bodySpan.className = "cvs-body";
  renderMessageBody(bodySpan, msg.trailing || "", msg.tags?.emotes);
  line.appendChild(bodySpan);

  messageList.appendChild(line);
  pruneMessages();
  scrollIfNeeded();
  updateScrollbar();
}

// --- Emote rendering ---
function renderMessageBody(container, text, emotesTag) {
  // Parse Twitch emotes from tag: "25:0-4,6-10/354:12-18"
  const twitchEmotes = []; // [{id, start, end}]
  if (emotesTag && settings.emoteProviders.twitch) {
    for (const emoteEntry of emotesTag.split("/")) {
      const [id, positions] = emoteEntry.split(":");
      for (const pos of positions.split(",")) {
        const [start, end] = pos.split("-").map(Number);
        twitchEmotes.push({ id, start, end });
      }
    }
    twitchEmotes.sort((a, b) => a.start - b.start);
  }

  // Build segments: mix of text and twitch emotes
  const segments = [];
  let lastIdx = 0;
  for (const e of twitchEmotes) {
    if (e.start > lastIdx) {
      segments.push({ type: "text", value: text.substring(lastIdx, e.start) });
    }
    segments.push({
      type: "twitch-emote",
      id: e.id,
      name: text.substring(e.start, e.end + 1),
    });
    lastIdx = e.end + 1;
  }
  if (lastIdx < text.length) {
    segments.push({ type: "text", value: text.substring(lastIdx) });
  }

  // Render segments, checking third-party emotes in text segments
  for (const seg of segments) {
    if (seg.type === "twitch-emote") {
      const img = document.createElement("img");
      img.className = "cvs-emote";
      img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${seg.id}/static/dark/1.0`;
      img.alt = seg.name;
      img.dataset.provider = "twitch";
      img.dataset.scope = "native";
      container.appendChild(img);
    } else {
      // Check words against third-party emotes
      const words = seg.value.split(/( +)/);
      for (const word of words) {
        const emote = thirdPartyEmotes[word];
        if (emote && isProviderEnabled(emote.provider)) {
          const img = document.createElement("img");
          img.className = "cvs-emote";
          img.src = emote.url;
          img.alt = word;
          img.dataset.provider = emote.provider;
          img.dataset.scope = emote.scope || "global";
          container.appendChild(img);
        } else {
          container.appendChild(document.createTextNode(word));
        }
      }
    }
  }
}

function isProviderEnabled(provider) {
  return settings.emoteProviders[provider] !== false;
}

// --- Emote tooltip ---
const PROVIDER_LABELS = { "7tv": "7TV", bttv: "BetterTTV", ffz: "FrankerFaceZ", twitch: "Twitch" };

function emoteUrl3x(src, provider) {
  if (provider === "twitch") return src.replace("/1.0", "/3.0");
  if (provider === "7tv") return src.replace("/1x.webp", "/3x.webp");
  if (provider === "bttv") return src.replace("/1x.webp", "/3x.webp");
  if (provider === "ffz") return src.replace(/\/1($|\?)/, "/4$1");
  return src;
}

let tooltipEl = null;
let tooltipLocked = false; // true while cursor hasn't moved since last tooltip trigger

function ensureTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "cvs-tooltip cvs-hidden";
  tooltipEl.innerHTML = `<img class="cvs-tooltip-img"><div class="cvs-tooltip-details"><span class="cvs-tooltip-name"></span><span class="cvs-tooltip-provider"></span></div><div class="cvs-tooltip-scope"></div>`;
  document.body.appendChild(tooltipEl);
}

function showTooltip(emoteImg) {
  ensureTooltip();
  const provider = emoteImg.dataset.provider;
  const scope = emoteImg.dataset.scope;
  const name = emoteImg.alt;

  tooltipEl.querySelector(".cvs-tooltip-img").src = emoteUrl3x(emoteImg.src, provider);
  tooltipEl.querySelector(".cvs-tooltip-name").textContent = name;
  tooltipEl.querySelector(".cvs-tooltip-provider").textContent = PROVIDER_LABELS[provider] || provider;
  tooltipEl.querySelector(".cvs-tooltip-scope").textContent = scope === "native" ? "Native" : scope === "channel" ? "Channel" : "Global";
  tooltipEl.classList.remove("cvs-hidden");

  const rect = emoteImg.getBoundingClientRect();
  const tipW = tooltipEl.offsetWidth;
  const tipH = tooltipEl.offsetHeight;
  let left = rect.left + rect.width / 2 - tipW / 2;
  let top = rect.top - tipH - 6;
  // Flip below if clipped at top
  if (top < 4) top = rect.bottom + 6;
  // Clamp horizontally
  left = Math.max(4, Math.min(left, window.innerWidth - tipW - 4));
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.add("cvs-hidden");
}

function hashColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function pruneMessages() {
  while (messageList.childElementCount > settings.messageCap) {
    messageList.firstElementChild.remove();
  }
}

// --- Usercard ---
function openUsercard(username, clickEvent) {
  closeUsercard();

  usercardEl = document.createElement("div");
  usercardEl.className = "cvs-usercard";
  usercardEl.dataset.login = username;

  // Close button
  const closeBtn = document.createElement("button");
  closeBtn.className = "cvs-usercard-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", closeUsercard);

  // Header
  const header = document.createElement("div");
  header.className = "cvs-usercard-header";

  const avatar = document.createElement("img");
  avatar.className = "cvs-usercard-avatar";
  avatar.src = "";
  avatar.style.visibility = "hidden";

  const info = document.createElement("div");
  info.className = "cvs-usercard-info";

  const nameEl = document.createElement("span");
  nameEl.className = "cvs-usercard-name";
  nameEl.textContent = username;
  const clickedUser = clickEvent.target.closest(".cvs-user");
  nameEl.style.color = clickedUser?.style.color || hashColor(username);

  const createdEl = document.createElement("span");
  createdEl.className = "cvs-usercard-created";
  createdEl.textContent = "Loading\u2026";

  info.appendChild(nameEl);
  info.appendChild(createdEl);
  header.appendChild(avatar);
  header.appendChild(info);

  // Messages section
  const msgSection = document.createElement("div");
  msgSection.className = "cvs-usercard-messages";

  const userMsgs = messageBuffer.filter((m) => m.username === username);
  if (userMsgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cvs-usercard-empty";
    empty.textContent = "No messages this session";
    msgSection.appendChild(empty);
  } else {
    for (let i = 0; i < userMsgs.length; i++) {
      const m = userMsgs[i];
      const row = document.createElement("div");
      row.className = "cvs-line" + (i % 2 ? " cvs-line-even" : "");

      const ts = document.createElement("span");
      ts.className = "cvs-ts";
      const d = m.tags?.["tmi-sent-ts"]
        ? new Date(parseInt(m.tags["tmi-sent-ts"]))
        : new Date();
      ts.textContent =
        d.getHours().toString().padStart(2, "0") +
        ":" +
        d.getMinutes().toString().padStart(2, "0");
      row.appendChild(ts);

      const body = document.createElement("span");
      body.className = "cvs-body";
      renderMessageBody(body, m.trailing || "", m.tags?.emotes);
      row.appendChild(body);

      msgSection.appendChild(row);
    }
  }

  msgSection.addEventListener("mouseover", (e) => {
    if (tooltipLocked) return;
    const emote = e.target.closest(".cvs-emote");
    if (emote) { showTooltip(emote); tooltipLocked = true; }
  });
  msgSection.addEventListener("mousemove", (e) => {
    tooltipLocked = false;
    const emote = e.target.closest(".cvs-emote");
    if (emote) showTooltip(emote);
    else hideTooltip();
  });
  msgSection.addEventListener("mouseleave", hideTooltip);

  usercardEl.appendChild(closeBtn);
  usercardEl.appendChild(header);
  usercardEl.appendChild(msgSection);
  document.body.appendChild(usercardEl);

  // Position: top-right corner at click point, opens left and down
  const cardW = usercardEl.offsetWidth;
  const cardH = usercardEl.offsetHeight;
  let left = clickEvent.clientX - cardW;
  let top = clickEvent.clientY;

  // Clamp: don't overflow bottom — flip upward
  if (top + cardH > window.innerHeight) top = clickEvent.clientY - cardH;
  // Clamp left
  if (left < 0) left = 0;

  usercardEl.style.left = left + "px";
  usercardEl.style.top = top + "px";

  // Scroll messages to bottom
  msgSection.scrollTop = msgSection.scrollHeight;

  // Request profile from background
  port.postMessage({ type: "get-user-profile", login: username });

  // Click-outside listener (delayed so this click doesn't close it)
  setTimeout(() => {
    document.addEventListener("click", usercardOutsideClick);
  }, 0);
}

function closeUsercard() {
  if (usercardEl) {
    usercardEl.remove();
    usercardEl = null;
  }
  document.removeEventListener("click", usercardOutsideClick);
}

function usercardOutsideClick(e) {
  if (usercardEl && !usercardEl.contains(e.target) && !e.target.closest(".cvs-user")) {
    closeUsercard();
  }
}

function fillUsercardProfile(login, profile) {
  if (!usercardEl || usercardEl.dataset.login !== login) return;
  const nameEl = usercardEl.querySelector(".cvs-usercard-name");
  const createdEl = usercardEl.querySelector(".cvs-usercard-created");
  const avatar = usercardEl.querySelector(".cvs-usercard-avatar");

  if (!profile) {
    createdEl.textContent = "User not found";
    return;
  }

  nameEl.textContent = profile.displayName;
  createdEl.textContent =
    "Created " +
    new Date(profile.createdAt).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  avatar.src = profile.profileImageUrl;
  avatar.style.visibility = "visible";
}

// --- Chat shell injection ---
function injectChat() {
  const shell = document.querySelector(
    ".chat-shell, [class*='chat-shell']",
  );
  if (!shell || shell.dataset.cvsInjected) return false;
  shell.dataset.cvsInjected = "true";
  buildChatUI(shell);
  return true;
}

// --- Channel polling + MutationObserver ---
function pollChannel() {
  const ch = getChannel();
  if (ch !== currentChannel) {
    currentChannel = ch;
    if (ch && port) {
      port.postMessage({ type: "channel-changed", channel: ch });
    }
    // Clear messages on channel switch
    if (messageList) messageList.innerHTML = "";
    seenMsgIds.clear();
    messageBuffer = [];
    closeUsercard();
  }
}

// Watch for SPA navigations and chat-shell appearing
let lastTheatreMode = null;
const observer = new MutationObserver(() => {
  injectChat();
  injectToggleButton();
  pollChannel();
  // Re-apply resize CSS when mode changes (theatre <-> normal)
  if (settings.chatWidth && cvsStyleEl) {
    const theatre = isTheatreMode();
    if (theatre !== lastTheatreMode) {
      lastTheatreMode = theatre;
      setChatWidth(settings.chatWidth);
    }
  }
});

function init() {
  connectPort();
  injectChat();
  injectToggleButton();
  pollChannel();

  observer.observe(document.body, { childList: true, subtree: true });

  // Also poll periodically as a fallback for SPA navigations
  setInterval(pollChannel, 1500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
