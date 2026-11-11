/**
 * Link labels that say where the link goes rather than what it shows: an action on a social network or on a profile
 * ("Open LinkedIn", "Follow us on X", "View profile"). raisesummit.com puts `aria-label="Open LinkedIn"` on each speaker
 * card, a link around the speaker's headshot and the logo of their company, and a link's label comes right after the
 * picture's own `aria-label`, so 35 company logos and their headshots were all named "Open LinkedIn". One copy for the
 * collector, which reads the labels, and the unit tests. Pure string work, no DOM.
 */

/** The networks, by the words a label or a file name calls them. */
const NETWORK_WORDS = new Map<string, string>([
  ["linkedin", "linkedin"], ["li", "linkedin"],
  ["x", "x"], ["twitter", "x"],
  ["facebook", "facebook"], ["fb", "facebook"],
  ["instagram", "instagram"], ["insta", "instagram"], ["ig", "instagram"],
  ["youtube", "youtube"], ["yt", "youtube"],
  ["tiktok", "tiktok"], ["github", "github"], ["gitlab", "gitlab"], ["discord", "discord"], ["telegram", "telegram"],
  ["medium", "medium"], ["reddit", "reddit"], ["threads", "threads"], ["bluesky", "bluesky"], ["bsky", "bluesky"],
  ["mastodon", "mastodon"], ["whatsapp", "whatsapp"], ["pinterest", "pinterest"], ["dribbble", "dribbble"],
  ["behance", "behance"], ["twitch", "twitch"], ["snapchat", "snapchat"], ["substack", "substack"],
  ["farcaster", "farcaster"], ["warpcast", "farcaster"], ["wechat", "wechat"], ["weibo", "weibo"], ["xing", "xing"],
  ["crunchbase", "crunchbase"],
]);
const ACTION_WORDS = new Set([
  "open", "view", "visit", "see", "follow", "connect", "find", "join", "go", "check", "subscribe", "message", "contact",
  "chat", "add", "read", "watch",
]);
const PROFILE_WORDS = new Set(["profile", "profiles", "bio"]);
/** The small words around the action: "Follow us on X", "Check out my LinkedIn", "Go to the profile page". */
const FILLER_WORDS = new Set([
  "us", "me", "him", "her", "them", "on", "at", "in", "to", "with", "via", "our", "my", "your", "his", "their", "its",
  "the", "a", "an", "out", "now", "here", "and", "or", "of", "page", "account", "channel", "handle", "link",
]);
/** Longer than this, a label says more than where the link goes. */
const MAX_WORDS = 8;

/** Lowercase words: "Follow us on X" reads `follow us on x`. */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * What a label names when it is an action on a social network or a profile: the networks, and `profile`. Undefined
 * for any other label. Every word has to be an action, a network, a profile word or a small word around them, so a
 * label that names a person ("Scott Wu on LinkedIn") or a show (apple.com's "Stream now, Stick - Comedy") is not one.
 */
function profileTargets(label: string): Set<string> | undefined {
  const words = wordsOf(label);
  if (words.length === 0 || words.length > MAX_WORDS) return undefined;
  const targets = new Set<string>();
  let action = false;
  for (const word of words) {
    const network = NETWORK_WORDS.get(word);
    if (network) targets.add(network);
    else if (PROFILE_WORDS.has(word)) {
      targets.add("profile");
      action = true;
    } else if (ACTION_WORDS.has(word)) action = true;
    else if (!FILLER_WORDS.has(word)) return undefined;
  }
  return action && targets.size > 0 ? targets : undefined;
}

/**
 * Whether a picture's own name mentions one of the targets. A short alias (`x`, `li`, `fb`) has to be a word of its
 * own; a network's full name may run into the next word, as in `LinkedInIcon.svg` or `icon-twitter-white.png`.
 */
function mentions(name: string, targets: Set<string>): boolean {
  const lower = name.toLowerCase();
  const words = wordsOf(lower);
  if (targets.has("profile") && lower.includes("profile")) return true;
  for (const [word, network] of NETWORK_WORDS) {
    if (targets.has(network) && (word.length >= 4 ? lower.includes(word) : words.includes(word))) return true;
  }
  return false;
}

/**
 * True when a link's label names an action on a social network or a profile, and the picture in the link carries
 * names of its own (its file name, alt or title) none of which mentions that network or profile. The label then names
 * the link, not the picture: raisesummit.com's company logos are `cognition-logo-new.svg` and `Broadcom-logo.svg`. A
 * LinkedIn icon in a "Follow us on LinkedIn" link keeps the label, by its file name (`linkedin.svg`, `icon-li.png`) or,
 * as an inline vector with no name at all, because nothing says it is anything else.
 */
export function labelNamesOnlyTheLink(label: string, ownNames: readonly (string | null | undefined)[]): boolean {
  const targets = profileTargets(label);
  if (!targets) return false;
  const names = ownNames.filter((name): name is string => !!name && /[\p{L}\p{N}]/u.test(name));
  return names.length > 0 && !names.some((name) => mentions(name, targets));
}
