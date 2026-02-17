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
let settingsPanel = null;
let scrollThumb = null;
let userColors = {}; // username -> color from Twitch IRC tags
let vodId = null;
let vodChannel = null;
let vodPollTimer = null;
let lastVodOffset = -1;

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
    "videos",
  ];
  if (exclude.includes(name)) return null;
  return name;
}

function getVodId() {
  const match = location.pathname.match(/^\/videos\/(\d+)/);
  return match ? match[1] : null;
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
    if (msg.type === "vod-channel-data") {
      badges = msg.badges || {};
      thirdPartyEmotes = msg.emotes || {};
      vodChannel = msg.channel;
      if (msg.settings) applySettings(msg.settings);
      updateInputPlaceholder();
    }
    if (msg.type === "vod-comments") {
      for (const m of msg.comments) handleIRCMessage(m);
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

  // Re-announce channel/VOD so background rejoins after service worker restart
  if (vodId) {
    port.postMessage({ type: "vod-changed", videoId: vodId });
    const video = document.querySelector("video");
    if (video) port.postMessage({ type: "vod-seek", videoId: vodId, offset: Math.floor(video.currentTime) });
  } else if (currentChannel) {
    port.postMessage({ type: "channel-changed", channel: currentChannel });
  }
}

// --- Settings ---
function applySettings(s) {
  settings = { ...settings, ...s };
  if (chatContainer) {
    chatContainer.style.fontSize = settings.fontSize + "px";
    chatContainer.style.setProperty("--cvs-msg-spacing", settings.messageSpacing + "px");
    if (settings.bgOdd) chatContainer.style.setProperty("--cvs-bg-odd", settings.bgOdd);
    if (settings.bgEven) chatContainer.style.setProperty("--cvs-bg-even", settings.bgEven);
  }
  applyChatVisibility();
  updateSettingsPanel();
}

function applyChatVisibility() {
  const shell = document.querySelector(".chat-shell, [class*='chat-shell']");
  extensionEnabled = !settings.useNativeChat;
  chatCollapsed = !!settings.hideChat;
  if (!extensionEnabled) {
    if (shell) shell.classList.remove("cvs-active");
    if (cvsStyleEl) cvsStyleEl.textContent = "";
  } else {
    if (shell) shell.classList.add("cvs-active");
    if (chatCollapsed) {
      ensureResizeStyle();
      cvsStyleEl.textContent = collapsedCSS();
    } else if (settings.chatWidth) {
      setChatWidth(getChatWidthPx());
    } else if (cvsStyleEl) {
      cvsStyleEl.textContent = "";
    }
  }
}

function saveSetting(key, value) {
  chrome.storage.local.get("settings", ({ settings: s }) => {
    chrome.storage.local.set({ settings: { ...s, [key]: value } });
  });
}

function updateSettingsPanel() {
  if (!settingsPanel) return;
  for (const input of settingsPanel.querySelectorAll("[data-setting]")) {
    const key = input.dataset.setting;
    const val = key.startsWith("ep-")
      ? settings.emoteProviders?.[key.slice(3)]
      : settings[key];
    if (input.type === "checkbox") input.checked = !!val;
    else input.value = val ?? "";
  }
  for (const sw of settingsPanel.querySelectorAll("[data-swatch]")) {
    sw.style.background = settings[sw.dataset.swatch] || "";
  }
}

function closeSettingsPanel(e) {
  if (settingsPanel && !settingsPanel.contains(e.target) && !e.target.closest(".cvs-settings-btn")) {
    settingsPanel.classList.add("cvs-hidden");
    document.removeEventListener("click", closeSettingsPanel);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) applySettings(changes.settings.newValue);
});

// --- DOM setup ---
function buildChatUI(shell) {
  // Hide native Twitch chat children via class (keeps Twitch JS alive)
  shell.classList.add("cvs-active", "cvs-shell");

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
    if (userSpan) {
      const line = userSpan.closest(".cvs-line");
      if (line) openUsercard(line.dataset.user, e);
      return;
    }
    const mention = e.target.closest(".cvs-mention");
    if (mention) openUsercard(mention.dataset.user, e);
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

  // Settings gear button + full settings panel
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "cvs-settings-btn";
  settingsBtn.title = "Settings";
  settingsBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 512 512" fill="currentColor"><path d="M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z"/></svg>`;
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle("cvs-hidden");
    if (!settingsPanel.classList.contains("cvs-hidden")) {
      setTimeout(() => document.addEventListener("click", closeSettingsPanel), 0);
    }
  });

  settingsPanel = document.createElement("div");
  settingsPanel.className = "cvs-settings-panel cvs-hidden";

  // Toggle rows
  const toggles = [
    { label: "Hide chat", key: "hideChat" },
    { label: "Twitch chat", key: "useNativeChat" },
    { label: "Timestamps", key: "showTimestamps" },
    { label: "Badges", key: "showBadges" },
  ];
  for (const { label, key } of toggles) {
    const row = document.createElement("div");
    row.className = "cvs-settings-row";
    row.innerHTML = `<span>${label}</span><label class="cvs-toggle"><input type="checkbox" data-setting="${key}"><span class="cvs-slider"></span></label>`;
    row.querySelector("input").checked = !!settings[key];
    row.querySelector("input").addEventListener("change", (e) => saveSetting(key, e.target.checked));
    settingsPanel.appendChild(row);
  }

  // Spinner rows
  const spinners = [
    { label: "Font size", key: "fontSize", min: 10, max: 20 },
    { label: "Spacing", key: "messageSpacing", min: 0, max: 20 },
  ];
  for (const { label, key, min, max } of spinners) {
    const row = document.createElement("div");
    row.className = "cvs-settings-row";
    row.innerHTML = `<span>${label}</span><div class="cvs-spinner"><button>\u2212</button><input type="number" data-setting="${key}" min="${min}" max="${max}"><button>+</button></div>`;
    const input = row.querySelector("input");
    const [dec, inc] = row.querySelectorAll("button");
    input.value = settings[key] ?? min;
    dec.addEventListener("click", () => { input.value = Math.max(min, parseInt(input.value) - 1); saveSetting(key, parseInt(input.value)); });
    inc.addEventListener("click", () => { input.value = Math.min(max, parseInt(input.value) + 1); saveSetting(key, parseInt(input.value)); });
    input.addEventListener("change", () => { input.value = Math.max(min, Math.min(max, parseInt(input.value))); saveSetting(key, parseInt(input.value)); });
    settingsPanel.appendChild(row);
  }

  // Message cap
  const capRow = document.createElement("div");
  capRow.className = "cvs-settings-row";
  capRow.innerHTML = `<span>Msg cap</span><input type="number" class="cvs-settings-num" data-setting="messageCap" min="100" max="2000">`;
  capRow.querySelector("input").value = settings.messageCap ?? 500;
  capRow.querySelector("input").addEventListener("change", (e) => {
    e.target.value = Math.max(100, Math.min(2000, parseInt(e.target.value)));
    saveSetting("messageCap", parseInt(e.target.value));
  });
  settingsPanel.appendChild(capRow);

  // Color rows
  for (const { label, key } of [{ label: "Odd bg", key: "bgOdd" }, { label: "Even bg", key: "bgEven" }]) {
    const row = document.createElement("div");
    row.className = "cvs-settings-row";
    row.innerHTML = `<span>${label}</span><div class="cvs-color-field"><span class="cvs-swatch" data-swatch="${key}"></span><input type="text" data-setting="${key}" maxlength="7"></div>`;
    const input = row.querySelector("input");
    const swatch = row.querySelector(".cvs-swatch");
    input.value = settings[key] || "";
    swatch.style.background = settings[key] || "";
    input.addEventListener("input", () => {
      if (/^#[0-9a-fA-F]{6}$/.test(input.value)) {
        swatch.style.background = input.value;
        saveSetting(key, input.value);
      }
    });
    settingsPanel.appendChild(row);
  }

  // Emote providers
  const emoteRow = document.createElement("div");
  emoteRow.className = "cvs-settings-row cvs-settings-emotes";
  emoteRow.innerHTML = `<span>Emotes</span><div class="cvs-emote-checks"></div>`;
  const emoteChecks = emoteRow.querySelector(".cvs-emote-checks");
  for (const [key, name] of [["twitch", "Tw"], ["7tv", "7TV"], ["bttv", "BT"], ["ffz", "FFZ"]]) {
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="checkbox" data-setting="ep-${key}"> ${name}`;
    lbl.querySelector("input").checked = settings.emoteProviders?.[key] !== false;
    lbl.querySelector("input").addEventListener("change", (e) => {
      chrome.storage.local.get("settings", ({ settings: s }) => {
        chrome.storage.local.set({ settings: { ...s, emoteProviders: { ...s?.emoteProviders, [key]: e.target.checked } } });
      });
    });
    emoteChecks.appendChild(lbl);
  }
  settingsPanel.appendChild(emoteRow);

  // Extension actions
  const actionsRow = document.createElement("div");
  actionsRow.className = "cvs-settings-actions";
  actionsRow.innerHTML = `<button title="Chrome extensions page"><svg width="12" height="12" viewBox="0 0 512 512" fill="currentColor"><path d="M352 320c88.4 0 160-71.6 160-160c0-15.3-2.2-30.1-6.2-44.2c-3.1-10.8-16.4-13.2-24.3-5.3l-76.8 76.8c-3 3-7.1 4.7-11.3 4.7L336 192c-8.8 0-16-7.2-16-16l0-57.4c0-4.2 1.7-8.3 4.7-11.3l76.8-76.8c7.9-7.9 5.4-21.2-5.3-24.3C382.1 2.2 367.3 0 352 0C263.6 0 192 71.6 192 160c0 19.1 3.4 37.5 9.5 54.5L19.9 396.1C7.2 408.8 0 426.1 0 444.1C0 481.6 30.4 512 67.9 512c18 0 35.3-7.2 48-19.9L297.5 310.5c17 6.2 35.4 9.5 54.5 9.5zM80 408a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/></svg></button><button title="Reload extension"><svg width="12" height="12" viewBox="0 0 512 512" fill="currentColor"><path d="M463.5 224l8.5 0c13.3 0 24-10.7 24-24l0-128c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8l119.5 0z"/></svg></button>`;
  const [extBtn, reloadBtn] = actionsRow.querySelectorAll("button");
  extBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-extensions" }));
  reloadBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "reload-extension" }));
  settingsPanel.appendChild(actionsRow);

  inputWrap.appendChild(inputEl);
  chatContainer.appendChild(messageList);
  chatContainer.appendChild(scrollbar);
  chatContainer.appendChild(pauseBar);
  chatContainer.appendChild(inputWrap);
  shell.appendChild(chatContainer);
  shell.appendChild(settingsBtn);
  shell.appendChild(settingsPanel);
  shell.appendChild(resizeHandle);
}

function updateInputPlaceholder() {
  if (!inputEl) return;
  if (vodId) {
    inputEl.placeholder = "Replay chat";
    inputEl.disabled = true;
  } else if (account) {
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

// Chat width is stored as a ratio (0-1) of viewport width.
// Legacy pixel values (> 1) are auto-converted.
function getChatWidthPx() {
  const cw = settings.chatWidth;
  if (!cw) return 340;
  if (cw > 1) return cw; // legacy absolute pixels
  return Math.round(cw * window.innerWidth);
}

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
    .persistent-player > *,
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
    chrome.storage.local.get("settings", ({ settings: s }) => {
      chrome.storage.local.set({ settings: { ...s, hideChat: false } });
    });
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
    const ratio = lastWidth / window.innerWidth;
    chrome.storage.local.get("settings", ({ settings: s }) => {
      chrome.storage.local.set({
        settings: { ...settings, ...s, chatWidth: ratio },
      });
    });
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// --- Chat collapse ---

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
  if (msg.channel !== currentChannel && msg.channel !== vodChannel) return;

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
    if (vodId && msg._vodOffset != null) {
      const secs = msg._vodOffset;
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      ts.textContent = h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    } else {
      const d = msg.tags?.["tmi-sent-ts"]
        ? new Date(parseInt(msg.tags["tmi-sent-ts"]))
        : new Date();
      ts.textContent =
        d.getHours().toString().padStart(2, "0") +
        ":" +
        d.getMinutes().toString().padStart(2, "0");
    }
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

  // Track user color from IRC tags (skip unreadable dark colors)
  const tagColor = msg.tags?.color;
  if (tagColor && isColorReadable(tagColor)) userColors[msg.username] = tagColor;

  // Username
  const userSpan = document.createElement("span");
  userSpan.className = "cvs-user";
  const displayName = msg.tags?.["display-name"] || msg.username;
  userSpan.textContent = displayName;
  const color = (tagColor && isColorReadable(tagColor) ? tagColor : null) || userColors[msg.username] || hashColor(msg.username);
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

  // Highlight messages that mention the logged-in user
  if (account && msg.trailing) {
    const mentionRe = new RegExp(`@${account.login}\\b`, "i");
    if (mentionRe.test(msg.trailing)) line.classList.add("cvs-line-mention");
  }

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
        } else if (/^@[a-zA-Z0-9_]+/.test(word)) {
          const mention = document.createElement("span");
          mention.className = "cvs-mention";
          const login = word.slice(1).toLowerCase();
          const mentionColor = userColors[login] || hashColor(login);
          mention.style.color = mentionColor;
          mention.textContent = word;
          mention.dataset.user = login;
          container.appendChild(mention);
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

function isColorReadable(hex) {
  if (!hex || hex[0] !== "#") return true;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 >= 30;
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

// --- VOD time polling ---
function startVodPoll() {
  stopVodPoll();
  lastVodOffset = -1;
  vodPollTimer = setInterval(() => {
    const video = document.querySelector("video");
    if (!video || video.paused) return;
    const offset = Math.floor(video.currentTime);
    if (offset === lastVodOffset) return;
    // Detect seeks (jump > 5s)
    if (lastVodOffset >= 0 && Math.abs(offset - lastVodOffset) > 5) {
      if (messageList) messageList.innerHTML = "";
      messageBuffer = [];
      msgEven = false;
      port.postMessage({ type: "vod-seek", videoId: vodId, offset });
    } else {
      port.postMessage({ type: "vod-time", videoId: vodId, offset });
    }
    lastVodOffset = offset;
  }, 500);
}

function stopVodPoll() {
  if (vodPollTimer) { clearInterval(vodPollTimer); vodPollTimer = null; }
}

// --- Channel polling + MutationObserver ---
function pollChannel() {
  // VOD detection — check before live channel logic
  const vid = getVodId();
  if (vid !== vodId) {
    // Leaving a VOD
    if (vodId) {
      stopVodPoll();
      vodChannel = null;
      lastVodOffset = -1;
    }
    vodId = vid;
    if (vid) {
      // Entering a VOD page
      currentChannel = null;
      if (messageList) messageList.innerHTML = "";
      seenMsgIds.clear();
      messageBuffer = [];
      closeUsercard();
      updateInputPlaceholder();
      if (port) port.postMessage({ type: "vod-changed", videoId: vid });
      startVodPoll();
      return;
    }
  }
  if (vodId) return; // Still on same VOD, skip live channel logic

  const ch = getChannel();
  if (ch !== currentChannel) {
    currentChannel = ch;
    if (ch && port) {
      port.postMessage({ type: "channel-changed", channel: ch });
    }
    // Navigated away from a channel — clear resize overrides so Twitch
    // can manage the player (mini-player, PiP, etc.)
    if (!ch && cvsStyleEl) cvsStyleEl.textContent = "";
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
  pollChannel();
  // Re-apply resize CSS when mode changes (theatre <-> normal)
  if (settings.chatWidth && cvsStyleEl) {
    const theatre = isTheatreMode();
    if (theatre !== lastTheatreMode) {
      lastTheatreMode = theatre;
      setChatWidth(getChatWidthPx());
    }
  }
});

function init() {
  connectPort();
  injectChat();
  pollChannel();

  observer.observe(document.body, { childList: true, subtree: true });

  // Recalculate chat width on window resize to maintain proportional width
  window.addEventListener("resize", () => {
    if (!settings.chatWidth || !cvsStyleEl || chatCollapsed || !extensionEnabled) return;
    setChatWidth(getChatWidthPx());
  });

  // Also poll periodically as a fallback for SPA navigations
  setInterval(pollChannel, 1500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
