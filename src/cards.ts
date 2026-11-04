import { detectSource, extractTitle, sourceIcon } from "./sourceDetector";

// ---------------------------------------------------------------------------
// Card content — the *meaning* of a card (info_board's model, minus dates,
// checklists, and portals). Kept separate from the spatial registry: the
// Locomancer tracks WHERE a card is, this tracks WHAT it holds, joined by id.
// ---------------------------------------------------------------------------
export type CardContent = {
  // --- document identity (SHARED across all placements with the same docId) ---
  docId: string; //  internal identity — NOT the url/title (those are unreliable)
  title: string; //  the document's name (shared)
  url?: string;
  icon: string; //   source emoji shown on the tile
  source: string; // human-readable source name
  // --- per-placement context (this card only) ---
  note: string; //   stored as HTML (may contain <mark> from highlighting)
  w?: number; //     user-resized width (px), if set
  h?: number; //     user-resized height (px), if set
  imageH?: number; // user-resized thumbnail height (px), if set
  // --- document-level, fetched (shared across placements) ---
  image?: string; //       a page-screenshot (or og:image) thumbnail, as a data URL
  description?: string; // fetched page description
};

/**
 * Normalize a URL for duplicate detection: drop protocol/www differences, the
 * trailing slash, the hash, and common tracking params. Exact normalized matches
 * are treated as the same document (re-pasting the same link). (Different URLs for
 * the same content — papers on different hosts — are NOT caught here; that's the
 * future manual-link / Locomancer-suggestion job.)
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^ref$/i.test(k)) u.searchParams.delete(k);
    }
    const q = u.searchParams.toString();
    return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/$/, "") + (q ? "?" + q : "")).toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Build card content from pasted/dropped text — a URL becomes a link card,
 *  anything else a note. A fresh docId is assigned; main may replace it with an
 *  existing document's id if the (normalized) URL is already present. */
export function buildCardContent(raw: string): CardContent {
  const text = raw.trim();
  const url = /^https?:\/\/\S+$/i.test(text) ? text : undefined;
  const src = detectSource(url);
  return {
    docId: crypto.randomUUID(),
    title: url ? extractTitle(url) : extractTitle(undefined, text),
    url,
    note: url ? "" : text,
    icon: sourceIcon(src.type),
    source: src.name,
  };
}

/** A fresh, empty note card (always its own unique document). */
export function blankNote(text = ""): CardContent {
  return { docId: crypto.randomUUID(), title: extractTitle(undefined, text) || "New note", note: text, icon: "📝", source: "Note" };
}
