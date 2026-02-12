# Converse — Chrome Extension for Twitch Chat

## What This Is
A Chrome extension that replaces Twitch's native chat with a custom container. Manifest V3.

## File Structure
- `src/manifest.json` — Extension manifest (v3). Background is a module service worker.
- `src/background.js` — Service worker. IRC WebSocket, port management, Helix API calls, emote/badge fetching.
- `src/content.js` — Content script injected on `twitch.tv/*`. Builds chat UI, renders messages, handles resize/scroll/tooltips/usercards.
- `src/chat.css` — All chat styling.
- `src/popup.html` / `src/popup.js` — Extension popup for account management and settings.
- `src/lib/auth.js` — OAuth helpers, account CRUD in `chrome.storage.local`.
- `src/lib/irc.js` — TMI IRC message parser (tags, prefix, command, channel, trailing, username).
- `src/lib/badges.js` — Fetches global + channel badges from Helix API. Global cached in memory. Channel overrides global. Returns map of `"set_id/version" -> url`.
- `src/lib/emotes.js` — Fetches 7TV, BTTV, FFZ emotes (global + channel). Cached in `chrome.storage.local` with TTLs (6h global, 1h channel). Priority on name collision: 7TV > BTTV > FFZ.

## Architecture

### Communication
Content script connects a long-lived port (`name: "chat"`) to the background service worker. Messages:
- **content -> background:** `channel-changed`, `send-message`, `get-user-profile`
- **background -> content:** `irc-message`, `recent-messages`, `channel-data` (badges + emotes + settings), `account-info`, `user-profile`

Settings changes propagate via `chrome.storage.onChanged` listener in content script.

### IRC Connection
Single WebSocket to `wss://irc-ws.chat.twitch.tv:443`. Requests `twitch.tv/tags` and `twitch.tv/commands` capabilities. Authenticates as the active account or anonymous (`justinfan`). Reconnects with exponential backoff (1s to 30s). Joins/parts channels based on which content script ports are active — only parts when no port is watching a channel.

### Channel Detection
`getChannel()` parses `location.pathname` for a channel name, excluding known non-channel paths (directory, settings, payments, etc.). Polled every 1.5s + on MutationObserver fires. On channel change: clears messages, clears `seenMsgIds`, resets `messageBuffer`, closes usercard.

### Recent Messages
On channel join, fetches backfill from `recent-messages.robotty.de`. Deduplication via `seenMsgIds` Set (keyed on `msg.tags.id`) prevents overlap with live messages.

## Features

### Emote Rendering
Twitch emotes parsed from IRC `emotes` tag (position-based). Third-party emotes matched by word against the `thirdPartyEmotes` map (populated from background on channel join). Each provider individually toggleable in settings.

### Emote Tooltip
Hover an emote to see a 3x preview, name, provider label (7TV/BetterTTV/FrankerFaceZ/Twitch), and scope (Native/Channel/Global). Positioned above the emote, flips below if clipped at top, clamped horizontally.

**Scroll lock:** `tooltipLocked` flag prevents scroll-triggered tooltip switching. When `mouseover` fires on an emote (e.g. a new message scrolling under the cursor), the tooltip shows and `tooltipLocked` is set. While locked, further `mouseover` events are ignored. Any `mousemove` clears the lock and re-evaluates normally. This way the tooltip sticks to the original emote until the user physically moves the mouse.

### Usercard
Click a username to open a card showing avatar, display name, account creation date, and that user's message history from the current session (from `messageBuffer`). Profile fetched via Helix `users?login=` API. Positioned with top-right at click point, opens left and down. Dismissed by close button or click-outside.

### Chat Collapse Toggle
A button (`#cvs-toggle-chat`) injected into `.player-controls__right-control-group`. Toggles chat column to width 0 with CSS overrides (mode-aware, same as resize). Button opacity dims to 0.5 when collapsed. Starting a resize drag un-collapses.

### Auto-scroll / Pause Bar
Chat auto-scrolls to bottom. When user scrolls up (>30px from bottom), `autoScroll` is set false and the "Chat paused" bar appears. Clicking the bar or scrolling back to bottom resumes.

### Chat Input
Text input at bottom of chat. Sends `PRIVMSG` via background port on Enter. Shows "Chat as {username}" when logged in, "Log in to chat" (disabled) when anonymous.

### Message Moderation
- `CLEARCHAT` with trailing: removes all messages from that user. Without trailing: clears entire chat.
- `CLEARMSG`: removes single message by `target-msg-id` tag.

### Alternating Row Colors
Messages alternate odd/even backgrounds via `cvs-line-even` class. Colors set via CSS custom properties `--cvs-bg-odd` / `--cvs-bg-even`, configurable in popup settings.

### Username Colors
Uses `msg.tags.color` if present, otherwise generates a deterministic HSL color from a hash of the username.

### Account Management
OAuth flow via `chrome.identity.launchWebAuthFlow` with scopes `chat:read chat:edit`. Multiple accounts stored in `chrome.storage.local`, one active at a time. Switch/remove from popup. Changing account closes IRC and reconnects.

### Settings (Popup)
Font size (10-20), message spacing (0-20), timestamps toggle, badges toggle, message cap (100-2000), odd/even row background colors, emote provider toggles (Twitch/7TV/BTTV/FFZ). All persisted to `chrome.storage.local` under `settings` key. Applied live to content script.

## Current State of Chat Resize Feature

The resize handle is on the left edge of `#cvs-chat`. Dragging left makes chat wider, dragging right makes it narrower. Width is persisted to `chrome.storage.local` under `settings.chatWidth`.

### Architecture
Resize works by injecting a single `<style id="cvs-resize-overrides">` element with `!important` CSS rules. The CSS is regenerated on every drag frame and when mode changes. `chatWidthCSS(w, dragging)` generates mode-specific CSS. `isTheatreMode()` detects the current mode. A MutationObserver watches for mode switches and re-applies the CSS.

### How It Works
- **Theatre mode:** Player `right` pushed to chat width, `width: auto`. Column anchored with `left: auto`, `right: 0`.
- **Normal mode:** Chat column `width`/`transform` overridden, player `right`/`width: auto`, info section `padding-right: calc(w - 340px)` (only excess beyond Twitch default).
- **Video centering:** `height: 100%` + `padding-bottom: 0` on entire player chain, `object-fit: contain` on video. `padding-bottom: 0` neutralizes tw-aspect's aspect ratio padding; letterbox bars split top/bottom at wide chat widths.
- **Info section alignment:** `margin-top: calc(-16rem + 100vh)` matches our forced player height, preventing overlap from Twitch's stale inline margin-top.
- **Sidebar:** Player auto-sizes via `left: 0` + `right: w` + `width: auto` — browser calculates width, works regardless of sidebar state.
- **Resize handle:** Tracks clamped `lastWidth` during drag instead of reading DOM on mouseup.

---

## Twitch Page Layout Reference

### Overall Page Structure (Normal Mode)
```
body
  top-nav (50px tall)
  flex-row (full width):
    left-nav sidebar (240px expanded, ~50px collapsed)
    twilight-main (flex: 1 1 auto)
      scrollable-area > root-scrollable__wrapper (position: relative, fills twilight-main)
        channel-root (static)
          channel-root__main--with-chat (display: flex)
            channel-root__player--with-chat (position: absolute, max-height: calc(-16rem + 100vh))
            channel-root__info--with-chat (position: relative, margin-top: 741px, FULL WIDTH)
        persistent-player (position: absolute, sibling of channel-root, inline width/left/top from Twitch JS)
    0-width flex items containing right-column:
      right-column--beside (position: relative, width: 0)
        wrapper divs...
          channel-root__right-column (position: absolute, transform: translateX(-34rem), inline styles from Twitch JS)
            chat-shell (our chat lives here)
```

### Overall Page Structure (Theatre Mode)
```
body
  top-nav
  flex-row:
    left-nav sidebar
    twilight-main
      persistent-player (position: FIXED, inline: top:0, left:0, width:Xpx, z-index:3000)
    right-column--theatre (position: FIXED, right:0, left:Xpx, width:340px, transition: all)
      wrapper divs...
        channel-root__right-column (position: absolute, transform: translateX(-340px), inline from Twitch JS)
          chat-shell
```

### Key Elements

**`persistent-player`**
- Normal mode: `position: absolute` inside `root-scrollable__wrapper`. Twitch JS sets inline `width`, `left: 0`, `top: 0`. Width = scrollWrapper - defaultChatWidth.
- Theatre mode: `position: fixed` filling most of viewport. Twitch JS sets inline `width`, `right`, `inset-inline-start: 0`.
- Both modes have `overflow: hidden`, `max-height: calc(-16rem + 100vh)`, `height: auto` from inline styles.

**Player child chain**: `persistent-player > ScAspectRatio(tw-aspect) > video-player > video-player__container > video-ref > video`
- `tw-aspect` is `position: relative` and natively enforces 16:9 via padding-bottom. We neutralize this with `padding-bottom: 0 !important`.
- `video-player__container` has inline `max-height: calc(-16rem + 100vh)`.
- All elements in the chain get `height: 100% !important` + `padding-bottom: 0 !important` so the video fills the player, and `object-fit: contain` handles letterboxing.

**`channel-root__right-column`** (inner column where chat lives)
- Always `position: absolute` with Twitch-applied inline styles.
- Normal: `transform: translateX(-34rem) translateZ(0px); transition: transform 500ms; opacity: 1;` — 34rem = 340px at 10px root font.
- Theatre: similar transform + opacity inline styles.
- CSS has `width: 340px` (default), but inline styles may override.

**`right-column--theatre`** / **`right-column--beside`** (outer wrapper)
- Theatre: `position: fixed; right: 0; left: Xpx; width: 340px; transition: all`. The `left` is what anchors it — we override with `left: auto` so `right: 0` + `width` controls positioning.
- Normal (beside): `position: relative; width: 0`. Part of the flex layout but takes no space. Chat overlays via the absolute-positioned inner column.

**`channel-root__info--with-chat`** (info panel below stream)
- Full width of scrollWrapper (extends under chat in default Twitch).
- Twitch JS sets inline `margin-top` (e.g. `741px`) to position it below the video. We override with `margin-top: calc(-16rem + 100vh) !important` to match our forced player height exactly.
- NOT constrained by chat width in default Twitch — chat just overlays on top.

### CSS Transitions That Cause Problems
- `right-column--theatre`: `transition: all` (from CSS)
- `channel-root__right-column`: `transition: transform 500ms` (from inline)
- `persistent-player`: `transition: transform 0.5s` (from inline)
- These MUST be overridden with `transition: none !important` during drag or resize is sluggish/animated.

### Root Font Size
Twitch uses `10px` root font size. `34rem = 340px`, `16rem = 160px`.

---

## Resize Approach History

Failed approaches kept as reference to avoid re-attempting them.

### Failed: Direct inline style manipulation
Set `container.style.width` etc. on `channel-root__right-column`. Race conditions with Twitch JS setting inline styles on the same elements. Width grows rightward (wrong direction) due to absolute positioning + transform.

### Failed: Inline styles + transform adjustment
Parsed `getComputedStyle` transform matrix and adjusted proportionally. Fragile, and theatre/normal modes need completely different logic.

### Failed: Flex wrapper manipulation
Gave the outer wrapper actual width via `flex: 0 0 chatWidth`. Twitch JS ALSO accounts for chat width independently → double offset (2x shrink).

### Failed: Video centering via flex/positioning
- `display: flex; align-items: center` on player — absolute children escape flex flow.
- `position: relative !important` on video-player__container — broke video entirely.
- `top:0; bottom:0; height:auto` on container — tw-aspect constrained chain to ~604px, black bar at bottom only.
- `object-fit: contain` alone — only works if video element fills player height; needs `height: 100%` on every element in chain.

### Failed: Info section offset via margin/max-width
- `margin-right: chatWidth` — overflowed on flex item.
- `max-width: calc(100% - chatWidth)` — constrained more than Twitch default.
- `padding-right: chatWidth` — too much at default 340px; needs to only compensate for excess.

---

## Custom Scrollbar

Native scrollbar is hidden (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`). A JS-driven custom scrollbar (`div.cvs-scrollbar` > `div.cvs-scrollbar-thumb`) is absolutely positioned over the right edge of `.cvs-messages`, overlaying content with no reserved horizontal space. CSS controls visibility: `opacity: 0` by default, `opacity: 1` on `#cvs-chat:hover`. Thumb is 14px wide, rectangular (no border-radius). Drag and track-click are handled in JS (`startScrollDrag`, track mousedown). `updateScrollbar()` is called on scroll events and after every message DOM mutation (add, prune, clear).

### Why not CSS-only scrollbar styling
`::-webkit-scrollbar` pseudo-elements are disabled in modern Chrome when standard `scrollbar-color`/`scrollbar-width` properties are inherited from the page (Twitch sets these). Standard properties don't support custom width or shape. `overflow: overlay` is deprecated. The JS approach was the only reliable path.

---

## TODO
- [ ] Emote autocomplete — type `:` or start a word in input, dropdown of matching emotes from loaded set, tab to complete
- [ ] Username autocomplete — tab-complete usernames from `messageBuffer` for @mentions
- [ ] Username highlighting — when @user_name shows up in chat, style it and make it clickable to show the usercard
- [ ] Reply threading — render reply-parent IRC tags with visual indicator (quoted parent text or reply line) instead of flat
- [ ] Reply thread view. Clicking a reply thread message shows a popup chat or similar to scroll through.
- [ ] Input history (up arrow) — press up in input to cycle through previously sent messages
- [ ] Chat box broken — sent messages don't appear in chat
- [ ] Gift sub alerts — display gift sub events in chat
- [ ] First message highlights — visually highlight a user's first message in the channel
- [ ] Channel points counter — display current channel points balance
- [ ] Extension toggle — swap between native Twitch chat and extension chat without disabling the extension entirely
- [ ] Badge hovering — tooltip on badge hover showing badge info (normal Twitch, 7TV, other providers)
- [ ] Channel point redeems. Currently only show up as normal messages.
- [ ] Chat input restyle — hide the input box when not hovering; on hover, show it as a rounded floating box overlayed on chat history (like the "scroll to top" pause bar style)

## Popup Header Buttons
Top-right of the popup has two icon buttons: wrench opens `chrome://extensions`, refresh arrow calls `chrome.runtime.reload()` to reload the extension source.

## Player Controls Hover Fix
The `chatWidthCSS()` `playerChildCap` rule uses `.persistent-player > *` to force `height: 100%` on the player child chain. This selector must exclude `#cvs-btn-container` (our toggle buttons injected into the player) via `:not(#cvs-btn-container)`, otherwise the button container stretches to the full player height and steals hover from Twitch's controls layer.

## Extension Reload Rules
- Content script / CSS changes: just reload the Twitch tab.
- Background script / manifest changes: use the reload button in the popup header, then reload tab.
- Popup changes: close and reopen the popup.
