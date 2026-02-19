// Parse a single TMI IRC message into a structured object.
// Format: @tags :prefix COMMAND #channel :message
export function parseIRCMessage(raw) {
  let idx = 0;
  let tags = {};

  // Parse tags
  if (raw[0] === "@") {
    const spaceIdx = raw.indexOf(" ");
    const tagStr = raw.substring(1, spaceIdx);
    for (const pair of tagStr.split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        tags[pair] = true;
      } else {
        tags[pair.substring(0, eq)] = pair
          .substring(eq + 1)
          .replace(/\\s/g, " ")
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\\\/g, "\\");
      }
    }
    idx = spaceIdx + 1;
  }

  // Parse prefix
  let prefix = null;
  if (raw[idx] === ":") {
    const spaceIdx = raw.indexOf(" ", idx);
    prefix = raw.substring(idx + 1, spaceIdx);
    idx = spaceIdx + 1;
  }

  // Parse command
  const rest = raw.substring(idx);
  const parts = rest.split(" ");
  const command = parts[0];

  // Parse channel and trailing
  let channel = null;
  let trailing = null;
  let paramStart = 1;

  if (parts[paramStart]?.startsWith("#")) {
    channel = parts[paramStart].substring(1);
    paramStart++;
  }

  // Find trailing (starts with :), or fall back to remaining params for single-word messages
  // (recent-messages API omits the : prefix on single-word trailing text per IRC spec)
  const trailingIdx = rest.indexOf(" :", command.length);
  if (trailingIdx !== -1) {
    trailing = rest.substring(trailingIdx + 2);
  } else if (parts.length > paramStart) {
    trailing = parts.slice(paramStart).join(" ");
  }

  // Extract username from prefix (nick!user@host)
  let username = null;
  if (prefix) {
    const bangIdx = prefix.indexOf("!");
    username = bangIdx !== -1 ? prefix.substring(0, bangIdx) : prefix;
  }

  return { tags, prefix, command, channel, trailing, username };
}
