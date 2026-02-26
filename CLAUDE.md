# Converse — Chrome Extension for Twitch Chat

## What This Is
A Chrome extension that replaces Twitch's native chat with a custom container. Manifest V3.

## File Structure
- `src/manifest.json` — Extension manifest (v3). Background is a module service worker.
- `src/background.js` — Service worker. IRC WebSocket, port management, Helix API calls, emote/badge fetching, VOD comment fetching via GQL.
- `src/content.js` — Content script injected on `twitch.tv/*`. Builds chat UI, renders messages, handles resize/scroll/tooltips/usercards, VOD detection and time-synced playback.
- `src/chat.css` — All chat styling.
- `src/popup.html` / `src/popup.js` — Extension popup for account management and settings.
- `src/lib/auth.js` — OAuth helpers, account CRUD in `chrome.storage.local`.
- `src/lib/irc.js` — TMI IRC message parser (tags, prefix, command, channel, trailing, username).
- `src/lib/badges.js` — Fetches global + channel badges from Helix API. Global cached in memory. Channel overrides global. Returns map of `"set_id/version" -> url`.
- `src/lib/emotes.js` — Fetches 7TV, BTTV, FFZ emotes (global + channel). Cached in `chrome.storage.local` with TTLs (6h global, 1h channel) and a `CACHE_VERSION` — bump the version when the emote data structure changes to auto-invalidate stale cache entries. Priority on name collision: 7TV > BTTV > FFZ. Each provider fetch is wrapped in `safe()` so one failure doesn't break all emotes.
- `src/lib/settings.js` — Shared `DEFAULT_SETTINGS` object imported by background.js and popup.js.

## Architecture

### Communication
Content script connects a long-lived port (`name: "chat"`) to the background service worker. On port disconnect (e.g. service worker restart), the content script reconnects and re-sends `channel-changed` to restore state. `broadcast()` in background auto-prunes dead ports. Messages:
- **content -> background (port):** `channel-changed`, `send-message`, `get-user-profile`, `vod-changed`, `vod-time`, `vod-seek`, `keepalive`
- **background -> content (port):** `irc-message`, `recent-messages`, `channel-data` (badges + emotes + settings), `account-info`, `user-profile`, `vod-channel-data`, `vod-comments`
- **content -> background (runtime message):** `open-extensions`, `reload-extension`

**Service worker keepalive:** MV3 service workers terminate after 30s of no extension API events. WebSocket `onmessage` and `setInterval` callbacks with delays ≥30s do NOT count as extension events. VOD pages are immune (content script sends `vod-time` every 500ms), but live channels sent nothing after the initial `channel-changed`, so the worker would die and kill the IRC WebSocket. The content script now sends a `keepalive` port message every 25s (under Chrome's 30s threshold) to prevent this. The background has no handler for it — the port message event itself resets Chrome's idle timer.

Settings changes propagate via `chrome.storage.onChanged` listener in content script. Content script cannot call `chrome.tabs.create()` or `chrome.runtime.reload()` directly — these are proxied through runtime messages to the background script.

### IRC Connection
Single WebSocket to `wss://irc-ws.chat.twitch.tv:443`. Requests `twitch.tv/tags` and `twitch.tv/commands` capabilities. Authenticates as the active account or anonymous (`justinfan`). Reconnects with exponential backoff (1s to 30s). Joins/parts channels based on which content script ports are active — only parts when no port is watching a channel. Client-side PING sent every 60s; if no PONG received before the next ping, the connection is assumed dead and force-closed. Handles Twitch `RECONNECT` command by closing the socket to trigger reconnect.

### Channel Detection
`getChannel()` parses `location.pathname` for a channel name, excluding known non-channel paths (directory, settings, payments, videos, etc.). Polled every 1.5s + on MutationObserver fires. On channel change: clears messages, clears `seenMsgIds`, resets `messageBuffer`, closes usercard. When navigating away from a channel (channel becomes null), resize CSS overrides are cleared so Twitch can manage the player (mini-player, PiP, etc.).

### VOD Detection
`getVodId()` parses `/videos/(\d+)` from pathname. `pollChannel()` checks for VOD pages before live channel logic. On VOD entry: sends `vod-changed` to background, starts 500ms time polling via `startVodPoll()`. On VOD exit: stops polling, clears VOD state. While on a VOD, live channel logic is skipped entirely.

### Recent Messages
On channel join, fetches backfill from `recent-messages.robotty.de`. Deduplication via `seenMsgIds` Set (keyed on `msg.tags.id`) prevents overlap with live messages.

## Features

### Emote Rendering
Twitch emotes parsed from IRC `emotes` tag (position-based). Third-party emotes matched by word against the `thirdPartyEmotes` map (populated from background on channel join). Each provider individually toggleable in settings. Zero-width emotes (7TV `flags & 1`) are stacked onto the preceding emote via `.cvs-emote-stack` wrappers with absolute positioning. Messages are rendered via RAF-batched `queueLine()` / `flushMessages()` for performance.

### Emote Tooltip
Hover an emote to see a 3x preview, name, provider label (7TV/BetterTTV/FrankerFaceZ/Twitch), and scope (Native/Channel/Global). Positioned above the emote, flips below if clipped at top, clamped horizontally. The tooltip img is wrapped in `.cvs-tooltip-img-wrap`; while the 3x image loads, `cvs-tooltip-loading` on the tooltip hides the img and shows a CSS spinner via `::after` on the wrapper. Cached images skip the spinner (`img.complete` check).

**Scroll lock:** `tooltipLocked` flag prevents scroll-triggered tooltip switching. When `mouseover` fires on an emote (e.g. a new message scrolling under the cursor), the tooltip shows and `tooltipLocked` is set. While locked, further `mouseover` events are ignored. Any `mousemove` clears the lock and re-evaluates normally. This way the tooltip sticks to the original emote until the user physically moves the mouse.

### Usercard
Click a username to open a card showing avatar, display name, account creation date, and that user's message history from the current session (from `messageBuffer`). Profile fetched via Helix `users?login=` API. Positioned with top-right at click point, opens left and down. Dismissed by close button or click-outside.

### Chat Collapse / Extension Toggle
Controlled via `hideChat` and `useNativeChat` settings in `chrome.storage.local`. `hideChat` collapses the chat column to width 0 with CSS overrides (mode-aware, same as resize). `useNativeChat` removes the `cvs-active` class from the chat-shell, showing Twitch's native chat. Both are togglable from the in-chat settings panel and the extension popup. Starting a resize drag clears `hideChat`. `applyChatVisibility()` reads these settings and applies the appropriate state.

### Auto-scroll / Pause Bar
Chat auto-scrolls to bottom. When user scrolls up (>30px from bottom), `autoScroll` is set false and the "Chat paused" bar appears as an absolute-positioned overlay above the input (does not reserve vertical space or push messages). Clicking the bar or scrolling back to bottom resumes.

### Chat Input
Static input at the bottom of the chat column. Styled as a rounded box with a subtle border, always visible. Sends `PRIVMSG` via background port on Enter, then creates a local echo (synthetic IRC message rendered via `handleIRCMessage`) since Twitch IRC doesn't echo back your own PRIVMSGs. Shows "Chat as {username}" when logged in, "Log in to chat" (disabled) when anonymous.

**Input overlay:** The input uses a transparent-text overlay technique for rich rendering. The actual `<input>` has `color: transparent` with `caret-color: #efeff1` so the caret is visible. A `.cvs-input-overlay` div sits behind it (same font/padding) and renders the text with colored `@mention` spans. `updateInputOverlay()` parses `@username` tokens and colors them if the user is known (in `userColors` or is the channel owner). Scroll position is synced via `syncOverlayScroll()`.

### Autocomplete
A single `div.cvs-autocomplete` dropdown positioned above the input, shared by emote and username completion.

**Emote autocomplete:** Triggered by typing `:` + 1 char. Case-insensitive substring match against `thirdPartyEmotes` (filtered by enabled providers). Prefix matches sort first, then shorter names. Shows emote image + name + provider label. Capped at 15 results.

**Username autocomplete:** Triggered by `@` + 1 char. Prefix match against `messageBuffer` (recent chatters first, deduplicated). Channel owner always included as a candidate with broadcaster badge. Shows user badges + display name colored with their chat color. Capped at 10 results.

**Interaction:** Tab or Enter accepts (selects first if none highlighted). Up/Down navigates items. Escape closes. Click on a row accepts. Blur closes with 150ms delay so click events register. On accept, the token in the input is replaced with the completed value + trailing space.

### Input History
Sent messages are pushed to an in-memory `inputHistory` array (capped at 50). Up arrow cycles backwards through history, Down arrow cycles forwards. Current input is saved/restored when entering/exiting history. Any typing resets the history index.

### Message Moderation
- `CLEARCHAT` with trailing: removes all messages from that user. Without trailing: clears entire chat.
- `CLEARMSG`: removes single message by `target-msg-id` tag.

### Alternating Row Colors
Messages alternate odd/even backgrounds via `cvs-line-even` class. Colors set via CSS custom properties `--cvs-bg-odd` / `--cvs-bg-even`, configurable in popup settings.

### Username Colors
Uses `msg.tags.color` if present, falls back to `userColors` map (populated from previous messages by that user), then generates a deterministic HSL color from a hash of the username. The `userColors` map persists across channel switches since Twitch colors are global. This ensures local echo messages and @mentions use the user's real Twitch color.

### Gift Sub Alerts
`USERNOTICE` messages with `msg-id` of `subgift`, `submysterygift`, or `anonsubgift` render as grayed-out system lines (`.cvs-line-system`). Mystery gifts ("X is gifting N Tier 1 subs!") include a collapsible dropdown (▸/▾ toggle) that accumulates recipient names from the subsequent individual `subgift` messages via `pendingMysteryGifts` map (keyed by gifter username, tracks remaining count and the names DOM element). Standalone gift subs render as "X gifted a Tier 1 sub to Y". Anonymous gifters (`ananonymousgifter`) display as "Anonymous". `pendingMysteryGifts` is cleared on channel switch, VOD change, and VOD seek.

### Channel Points Counter
Displays the user's channel points balance to the right of the chat input, inside a `.cvs-input-row` flex wrapper. Read directly from Twitch's native `.community-points-summary` DOM element (hidden by our CSS but still live in the DOM). Polled every 3s via `pollChannelPoints()`. Shows a channel points icon (SVG) + formatted balance (e.g. "333.9K"). Hidden on VOD pages, when no channel is active, or when the native element isn't present (channel has no points program). No GQL or background involvement — purely content script DOM scraping.

### Channel Point Redeems
Messages with the `custom-reward-id` IRC tag are channel point redeems. The reward ID is a UUID with no name attached. On channel join, `fetchChannelRewards(channelLogin)` calls the `ChannelPointsContext` GQL operation (no auth required) to fetch `communityPointsSettings.customRewards`, building a `rewardId → title` map sent to the content script as part of `channel-data`. In `buildMessageLine`, redeems render a `.cvs-redeem-bar` label above the message body showing the reward title (or "Channel Point Redeem" as fallback). The GQL persisted query hash is volatile — Twitch may rotate it.

### @Mention Highlighting
Words starting with `@` followed by a valid username pattern are rendered as `.cvs-mention` spans — bold, colored (using the mentioned user's color from `userColors` or hash fallback), and clickable (opens usercard). Messages that mention the logged-in user get a `.cvs-line-mention` class: purple-tinted background with a left border accent.

### Reply Threading & Thread Panel
Twitch has no dedicated thread protocol — threads are just PRIVMSGs with `reply-parent-msg-id` and `reply-thread-parent-msg-id` tags. When sending a reply, only `reply-parent-msg-id` is set; Twitch resolves the thread root automatically.

**Reply indicators:** Messages with `reply-parent-msg-id` render a `.cvs-reply-bar` above the message body showing the parent's author and text. Reply bars strip the `@username` prefix from the message body and adjust emote positions accordingly. Each message also has a reply action button (`.cvs-reply-action`) that appears on hover and enters reply mode.

**Reply mode:** `enterReplyMode()` sets `replyTarget` and shows a `.cvs-reply-mode` bar above the input ("Replying to @user"). The outgoing PRIVMSG includes `replyParentMsgId` which background.js sends as `@reply-parent-msg-id=<id>` in the IRC command. Escape key or close button exits reply mode.

**Thread panel:** Clicking a reply bar opens an overlay panel (`.cvs-thread-panel`, `position: absolute`, `z-index: 5`) that covers the top portion of the message list without shifting it. Shows the thread root + all replies (matched by `reply-thread-parent-msg-id` or `reply-parent-msg-id` equal to the root ID) rendered via `buildMessageLine()` with `skipReplyBar: true`. New messages belonging to the open thread are appended live via `appendThreadMessage()`. The panel has its own input (`.cvs-thread-input`) that auto-sends as a reply to the thread root. A drag handle (`.cvs-thread-resize`) at the bottom edge allows resizing (clamped 80px–70%). Height ratio stored in `threadHeightRatio`. Close button (×) in top-left header. Panel closes on channel switch, VOD entry, and VOD seek.

**`buildMessageLine(msg, even, opts)`:** Extracted from `handleIRCMessage` — builds a complete `.cvs-line` DOM element for a PRIVMSG (reply bar, timestamp, badges, username, separator, body, mention highlight, reply action button). Used by main chat rendering, thread panel, and reusable for any context needing message display.

### VOD Chat Replay
On VOD pages (`/videos/{id}`), historical chat comments are fetched from Twitch's GQL API (`VideoCommentsByOffsetOrCursor` via `gql.twitch.tv/gql`) and delivered time-synced to video playback. Uses Twitch's first-party Client-ID (`kimne78kx3ncx6brgo4mv6wki5h1ko`) — the extension's own Client-ID returns 400 for GQL.

**Flow:** Content script polls `video.currentTime` every 500ms, sends `vod-time` to background. Background maintains a cursor-paginated comment buffer, drains comments with `contentOffsetSeconds <= offset`, transforms them to IRC format via `vodCommentToIRC()`, and sends as `vod-comments`. Content script feeds each through `handleIRCMessage()` for normal rendering.

**Seek handling:** If `video.currentTime` jumps >5s, content script clears messages and sends `vod-seek`. Background resets the comment buffer/cursor and re-fetches from the new offset.

**Chat gaps:** The GQL API returns `hasNext: false` when there are no more comment pages at the current cursor position — but this does NOT mean the VOD has no more comments ever. Chat may resume later. When `hasNext` is false, `endOffset` advances to the current playback position (not Infinity) and cursor resets, so fetching resumes as the video progresses past the gap (~1 GQL request/sec during silence).

**Timestamps:** VOD messages display elapsed video time (e.g. `1:23:45`) instead of wall-clock time, using `_vodOffset` from the GQL response.

**Input:** Disabled with "Replay chat" placeholder on VOD pages. Badges and emotes are fetched for the VOD's channel (resolved via Helix `videos?id=`).

### Account Management
OAuth flow via `chrome.identity.launchWebAuthFlow` with scopes `chat:read chat:edit`. Multiple accounts stored in `chrome.storage.local`, one active at a time. Switch/remove from popup. Changing account closes IRC and reconnects.

### Settings
Two access points, both read/write the same `chrome.storage.local` `settings` key, applied live via `chrome.storage.onChanged`:

**Extension popup** (`popup.html`/`popup.js`): Account management + all settings. `saveSettings()` merges with existing storage to preserve keys it doesn't manage (e.g. `chatWidth`).

**In-chat settings panel**: Gear icon (`.cvs-settings-btn`) in top-right of `#cvs-chat`, visible on hover. Click toggles a dropdown panel (`.cvs-settings-panel`) with the full settings menu: hide chat, use Twitch chat, timestamps, badges, font size, spacing, message cap, row colors, emote providers, plus extension actions (open chrome://extensions, reload extension). Click-outside dismisses. Extension action buttons proxy through runtime messages to the background since content scripts lack `chrome.tabs.create()`/`chrome.runtime.reload()` access.

Settings: font size (10-20), message spacing (0-20), timestamps toggle, badges toggle, message cap (100-2000), odd/even row background colors, emote provider toggles (Twitch/7TV/BTTV/FFZ), hide chat, use native Twitch chat.

## Current State of Chat Resize Feature

The resize handle is a sibling of `#cvs-chat` in the chat-shell (not a child, to avoid `overflow: hidden` clipping). It spans the border between player and chat — 28px wide, extending 14px into the player area for easy grabbing. No visual indicator; only the `col-resize` cursor. Dragging left makes chat wider, dragging right makes it narrower. Width is persisted to `chrome.storage.local` under `settings.chatWidth`.

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

### Bugs
- [ ] Sometimes animated emotes appear frozen. One message may have the emote be frozen, the next will have them working. It isn't a chat-wide or emote-wide issue.
- [x] When hovering an emote, sometimes an old emote tooltip will be shown, with the correct emote name but some other emote as the display image/gif (possibly just for first time hovering a new emote, not sure). — Fixed: tooltip now shows a loading spinner until the 3x image loads.

### Small Tweaks

### Features
- [ ] First message highlights — visually highlight a user's first message in the channel
- [x] Channel points counter — display current channel points balance
- [ ] Badge hovering — tooltip on badge hover showing badge info (normal Twitch, 7TV, other providers)
- [x] Channel point redeems — redeem title shown via GQL `ChannelPointsContext` (reward id→title map fetched on channel join)
- [ ] Channel points counter via GQL — revisit DOM scraping approach; `ChannelPointsContext` also returns `self.communityPoints.balance` (requires auth token), which would be more reliable than polling the native DOM element
- [ ] Channel points menu — click points counter to open rewards menu for redeeming
- [ ] Predictions — display and interact with channel predictions
- [ ] Polls — display and interact with channel polls

## Icons
All icons are inline SVGs using Font Awesome 6 Free Solid paths (no FA CSS/fonts bundled). In-chat settings: `fa-gear`. Popup header: `fa-wrench` (opens `chrome://extensions`), `fa-rotate-right` (reload extension). Both sets of action buttons are also in the in-chat settings panel footer.

## Extension Reload Rules
- Content script / CSS changes: just reload the Twitch tab.
- Background script / manifest changes: use the reload button in the popup header or in-chat settings panel, then reload tab.
- Popup changes: close and reopen the popup.
