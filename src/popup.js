// Converse — popup script
// Manages accounts and settings.

const DEFAULT_SETTINGS = {
  fontSize: 13,
  messageSpacing: 2,
  showTimestamps: true,
  showBadges: true,
  emoteProviders: { twitch: true, "7tv": true, bttv: true, ffz: true },
  messageCap: 500,
  chatWidth: null,
  bgOdd: "#0e0e10",
  bgEven: "#111114",
};

// --- Accounts ---
const accountList = document.getElementById("account-list");
const addAccountBtn = document.getElementById("add-account");

async function renderAccounts() {
  const { accounts } = await chrome.storage.local.get("accounts");
  accountList.innerHTML = "";
  if (!accounts || accounts.length === 0) {
    accountList.innerHTML =
      '<div style="color:#898395;font-size:13px;padding:4px 0">No accounts. Add one to chat.</div>';
    return;
  }
  for (const acc of accounts) {
    const div = document.createElement("div");
    div.className = "account" + (acc.active ? " active" : "");
    div.innerHTML = `
      <span class="account-name">${acc.login}</span>
      <span class="account-actions">
        ${acc.active ? "" : `<button data-switch="${acc.userId}">Switch</button>`}
        <button data-remove="${acc.userId}">Remove</button>
      </span>
    `;
    accountList.appendChild(div);
  }

  // Bind switch/remove buttons
  for (const btn of accountList.querySelectorAll("[data-switch]")) {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.switch;
      const { accounts } = await chrome.storage.local.get("accounts");
      for (const a of accounts) a.active = a.userId === userId;
      await chrome.storage.local.set({ accounts });
      chrome.runtime.sendMessage({ type: "account-changed" });
      renderAccounts();
    });
  }
  for (const btn of accountList.querySelectorAll("[data-remove]")) {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.remove;
      let { accounts } = await chrome.storage.local.get("accounts");
      accounts = accounts.filter((a) => a.userId !== userId);
      if (accounts.length && !accounts.some((a) => a.active))
        accounts[0].active = true;
      await chrome.storage.local.set({ accounts });
      chrome.runtime.sendMessage({ type: "account-changed" });
      renderAccounts();
    });
  }
}

addAccountBtn.addEventListener("click", async () => {
  try {
    // Dynamically import auth helpers — we can't use ES modules in popup
    // so we talk to background instead
    const CLIENT_ID = await getClientId();
    const SCOPES = "chat:read chat:edit";
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl =
      `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
      `&response_type=token&scope=${encodeURIComponent(SCOPES)}&force_verify=true`;

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    const hash = new URL(responseUrl).hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    if (!token) throw new Error("No access token");

    // Validate
    const validation = await fetch(
      "https://id.twitch.tv/oauth2/validate",
      { headers: { Authorization: `OAuth ${token}` } },
    );
    if (!validation.ok) throw new Error("Validation failed");
    const info = await validation.json();

    // Store
    let { accounts } = await chrome.storage.local.get("accounts");
    accounts = accounts || [];
    for (const a of accounts) a.active = false;
    const idx = accounts.findIndex((a) => a.userId === info.user_id);
    const account = {
      login: info.login,
      userId: info.user_id,
      token,
      active: true,
    };
    if (idx >= 0) accounts[idx] = account;
    else accounts.push(account);
    await chrome.storage.local.set({ accounts });
    chrome.runtime.sendMessage({ type: "account-changed" });
    renderAccounts();
  } catch (e) {
    console.error("OAuth failed:", e);
  }
});

async function getClientId() {
  // Read from background's auth module via a message
  return new Promise((resolve) => {
    // We embed the client ID here for simplicity — must match lib/auth.js
    resolve("8nt0ugk7fjossuquolsvewm056awxo");
  });
}

// --- Settings ---
const fontSizeEl = document.getElementById("fontSize");
const fontSizeDec = document.getElementById("fontSizeDec");
const fontSizeInc = document.getElementById("fontSizeInc");
const msgSpacingEl = document.getElementById("messageSpacing");
const msgSpacingDec = document.getElementById("messageSpacingDec");
const msgSpacingInc = document.getElementById("messageSpacingInc");
const showTimestampsEl = document.getElementById("showTimestamps");
const showBadgesEl = document.getElementById("showBadges");
const messageCapEl = document.getElementById("messageCap");
const bgOddEl = document.getElementById("bgOdd");
const bgOddSwatch = document.getElementById("bgOddSwatch");
const bgEvenEl = document.getElementById("bgEven");
const bgEvenSwatch = document.getElementById("bgEvenSwatch");
const epTwitch = document.getElementById("ep-twitch");
const ep7tv = document.getElementById("ep-7tv");
const epBttv = document.getElementById("ep-bttv");
const epFfz = document.getElementById("ep-ffz");

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...settings };
  fontSizeEl.value = s.fontSize;
  msgSpacingEl.value = s.messageSpacing;
  showTimestampsEl.checked = s.showTimestamps;
  showBadgesEl.checked = s.showBadges;
  messageCapEl.value = s.messageCap;
  bgOddEl.value = s.bgOdd;
  bgOddSwatch.style.background = s.bgOdd;
  bgEvenEl.value = s.bgEven;
  bgEvenSwatch.style.background = s.bgEven;
  epTwitch.checked = s.emoteProviders.twitch;
  ep7tv.checked = s.emoteProviders["7tv"];
  epBttv.checked = s.emoteProviders.bttv;
  epFfz.checked = s.emoteProviders.ffz;
}

function readSettings() {
  return {
    fontSize: parseInt(fontSizeEl.value),
    messageSpacing: parseInt(msgSpacingEl.value),
    showTimestamps: showTimestampsEl.checked,
    showBadges: showBadgesEl.checked,
    messageCap: parseInt(messageCapEl.value),
    bgOdd: bgOddEl.value,
    bgEven: bgEvenEl.value,
    emoteProviders: {
      twitch: epTwitch.checked,
      "7tv": ep7tv.checked,
      bttv: epBttv.checked,
      ffz: epFfz.checked,
    },
  };
}

function saveSettings() {
  const s = readSettings();
  chrome.storage.local.set({ settings: s });
}

function clampFontSize(v) {
  return Math.min(20, Math.max(10, v));
}
fontSizeDec.addEventListener("click", () => {
  fontSizeEl.value = clampFontSize(parseInt(fontSizeEl.value) - 1);
  saveSettings();
});
fontSizeInc.addEventListener("click", () => {
  fontSizeEl.value = clampFontSize(parseInt(fontSizeEl.value) + 1);
  saveSettings();
});
fontSizeEl.addEventListener("change", saveSettings);

function clampMsgSpacing(v) {
  return Math.min(20, Math.max(0, v));
}
msgSpacingDec.addEventListener("click", () => {
  msgSpacingEl.value = clampMsgSpacing(parseInt(msgSpacingEl.value) - 1);
  saveSettings();
});
msgSpacingInc.addEventListener("click", () => {
  msgSpacingEl.value = clampMsgSpacing(parseInt(msgSpacingEl.value) + 1);
  saveSettings();
});
msgSpacingEl.addEventListener("change", saveSettings);
showTimestampsEl.addEventListener("change", saveSettings);
showBadgesEl.addEventListener("change", saveSettings);
messageCapEl.addEventListener("change", saveSettings);
for (const [el, swatch] of [[bgOddEl, bgOddSwatch], [bgEvenEl, bgEvenSwatch]]) {
  el.addEventListener("input", () => {
    if (/^#[0-9a-fA-F]{6}$/.test(el.value)) {
      swatch.style.background = el.value;
      saveSettings();
    }
  });
}
epTwitch.addEventListener("change", saveSettings);
ep7tv.addEventListener("change", saveSettings);
epBttv.addEventListener("change", saveSettings);
epFfz.addEventListener("change", saveSettings);

// --- Init ---
renderAccounts();
loadSettings();
