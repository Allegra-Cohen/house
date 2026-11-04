// ---------------------------------------------------------------------------
// sourceDetector — ported from info_board. Maps a URL to its source (name +
// brand color + an emoji icon), and derives a title from a URL or pasted text.
// Pure functions, so they work in the plain-web build with no Electron.
// ---------------------------------------------------------------------------

export type SourceType =
  | "slack" | "google-docs" | "google-sheets" | "google-slides" | "google-drive"
  | "github" | "notion" | "figma" | "jira" | "confluence" | "trello"
  | "asana" | "linear" | "dropbox" | "generic" | "note";

type Source = { type: SourceType; name: string; color: string };

const SOURCE_PATTERNS: { pattern: RegExp; type: SourceType; name: string; color: string }[] = [
  { pattern: /slack\.com/i, type: "slack", name: "Slack", color: "#4A154B" },
  { pattern: /docs\.google\.com/i, type: "google-docs", name: "Google Docs", color: "#4285F4" },
  { pattern: /sheets\.google\.com/i, type: "google-sheets", name: "Google Sheets", color: "#0F9D58" },
  { pattern: /slides\.google\.com/i, type: "google-slides", name: "Google Slides", color: "#F4B400" },
  { pattern: /drive\.google\.com/i, type: "google-drive", name: "Google Drive", color: "#4285F4" },
  { pattern: /github\.com/i, type: "github", name: "GitHub", color: "#24292E" },
  { pattern: /notion\.so/i, type: "notion", name: "Notion", color: "#000000" },
  { pattern: /figma\.com/i, type: "figma", name: "Figma", color: "#F24E1E" },
  { pattern: /atlassian\.net.*jira/i, type: "jira", name: "Jira", color: "#0052CC" },
  { pattern: /atlassian\.net.*wiki/i, type: "confluence", name: "Confluence", color: "#172B4D" },
  { pattern: /trello\.com/i, type: "trello", name: "Trello", color: "#0079BF" },
  { pattern: /asana\.com/i, type: "asana", name: "Asana", color: "#F06A6A" },
  { pattern: /linear\.app/i, type: "linear", name: "Linear", color: "#5E6AD2" },
  { pattern: /dropbox\.com/i, type: "dropbox", name: "Dropbox", color: "#0061FF" },
];

const SOURCE_ICONS: Record<SourceType, string> = {
  slack: "💬",
  "google-docs": "📄",
  "google-sheets": "📊",
  "google-slides": "📽️",
  "google-drive": "📁",
  github: "🐙",
  notion: "📓",
  figma: "🎨",
  jira: "🗂️",
  confluence: "📘",
  trello: "📋",
  asana: "✅",
  linear: "📐",
  dropbox: "📦",
  generic: "🔗",
  note: "📝",
};

export function detectSource(url?: string): Source {
  if (!url) return { type: "note", name: "Note", color: "#6B7280" };
  for (const s of SOURCE_PATTERNS) {
    if (s.pattern.test(url)) return { type: s.type, name: s.name, color: s.color };
  }
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    return { type: "generic", name: domain, color: "#6B7280" };
  } catch {
    return { type: "generic", name: "Link", color: "#6B7280" };
  }
}

export function sourceIcon(type: SourceType): string {
  return SOURCE_ICONS[type] ?? SOURCE_ICONS.generic;
}

export function extractTitle(url?: string, text?: string): string {
  if (text && text.trim()) {
    const cleaned = text.trim().split("\n")[0];
    return cleaned.length > 100 ? cleaned.slice(0, 100) + "…" : cleaned;
  }
  if (url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length > 0) return decodeURIComponent(parts[parts.length - 1]).replace(/[-_]/g, " ");
      return u.hostname.replace("www.", "");
    } catch {
      return "Untitled";
    }
  }
  return "Untitled";
}
