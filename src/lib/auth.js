// Twitch OAuth helpers
// Register your app at https://dev.twitch.tv/console/apps
// Set redirect URL to the value of chrome.identity.getRedirectURL()
export const CLIENT_ID = "8nt0ugk7fjossuquolsvewm056awxo";
const SCOPES = "chat:read chat:edit";
const AUTH_BASE = "https://id.twitch.tv/oauth2";

export async function launchOAuthFlow() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl =
    `${AUTH_BASE}/authorize?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
    `&response_type=token&scope=${encodeURIComponent(SCOPES)}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const hash = new URL(responseUrl).hash.substring(1);
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  if (!token) throw new Error("No access token in OAuth response");
  return token;
}

export async function validateToken(token) {
  const res = await fetch(`${AUTH_BASE}/validate`, {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!res.ok) return null;
  return res.json(); // { login, user_id, ... }
}

// Account storage: [{ login, userId, token, active }]
export async function getAccounts() {
  const { accounts } = await chrome.storage.local.get("accounts");
  return accounts || [];
}

export async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

export async function getActiveAccount() {
  const accounts = await getAccounts();
  return accounts.find((a) => a.active) || null;
}

export async function addAccount(token) {
  const validation = await validateToken(token);
  if (!validation) throw new Error("Token validation failed");

  const account = {
    login: validation.login,
    userId: validation.user_id,
    token,
    active: true,
  };

  const accounts = await getAccounts();
  // Deactivate all others
  for (const a of accounts) a.active = false;
  // Replace if same user, otherwise append
  const idx = accounts.findIndex((a) => a.userId === account.userId);
  if (idx >= 0) accounts[idx] = account;
  else accounts.push(account);

  await saveAccounts(accounts);
  return account;
}

export async function switchAccount(userId) {
  const accounts = await getAccounts();
  for (const a of accounts) a.active = a.userId === userId;
  await saveAccounts(accounts);
  return accounts.find((a) => a.active);
}

export async function removeAccount(userId) {
  let accounts = await getAccounts();
  accounts = accounts.filter((a) => a.userId !== userId);
  // If we removed the active one, activate the first remaining
  if (accounts.length && !accounts.some((a) => a.active)) {
    accounts[0].active = true;
  }
  await saveAccounts(accounts);
  return accounts;
}
