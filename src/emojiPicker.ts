import { palette } from "./palette";

// ---------------------------------------------------------------------------
// A tiny searchable emoji popover — no external dependency. A curated set is
// plenty for now; this also seeds the larger "visual metaphor" work later.
// ---------------------------------------------------------------------------
const EMOJI: { e: string; k: string }[] = [
  { e: "📝", k: "note write memo" }, { e: "📄", k: "doc page file" }, { e: "📃", k: "page document" },
  { e: "📑", k: "tabs bookmark" }, { e: "📊", k: "chart bar data sheet" }, { e: "📈", k: "graph up trend" },
  { e: "📉", k: "graph down" }, { e: "📋", k: "clipboard list" }, { e: "🗂️", k: "folder files index" },
  { e: "📁", k: "folder" }, { e: "📦", k: "box package archive" }, { e: "🔗", k: "link url chain" },
  { e: "🌐", k: "web globe site internet" }, { e: "💬", k: "chat message talk slack" }, { e: "✉️", k: "mail email" },
  { e: "📌", k: "pin location important" }, { e: "📍", k: "pin place" }, { e: "⭐", k: "star favorite" },
  { e: "🔥", k: "fire hot important" }, { e: "💡", k: "idea bulb light" }, { e: "❓", k: "question" },
  { e: "❗", k: "important exclaim" }, { e: "✅", k: "check done task" }, { e: "☑️", k: "checkbox" },
  { e: "🎯", k: "target goal" }, { e: "🧩", k: "puzzle piece" }, { e: "🔬", k: "research science microscope" },
  { e: "🧪", k: "experiment lab" }, { e: "📚", k: "books library reading" }, { e: "📖", k: "book read" },
  { e: "✏️", k: "pencil edit" }, { e: "🖊️", k: "pen" }, { e: "🎨", k: "art design figma paint" },
  { e: "🖼️", k: "image picture frame" }, { e: "📷", k: "camera photo" }, { e: "🎬", k: "film video movie" },
  { e: "🎵", k: "music audio" }, { e: "🏠", k: "locus home" }, { e: "🏛️", k: "building institution" },
  { e: "🗺️", k: "map" }, { e: "🧭", k: "compass direction" }, { e: "🌱", k: "seed plant grow idea" },
  { e: "🌳", k: "tree" }, { e: "🪴", k: "plant pot" }, { e: "⚙️", k: "settings gear config" },
  { e: "🔧", k: "tool fix wrench" }, { e: "🧠", k: "brain mind think" }, { e: "👤", k: "person user" },
  { e: "👥", k: "people group team" }, { e: "💼", k: "work business briefcase" }, { e: "💰", k: "money finance" },
  { e: "📅", k: "calendar date" }, { e: "⏰", k: "clock time alarm" }, { e: "🚀", k: "rocket launch ship" },
  { e: "🐙", k: "github octopus" }, { e: "📓", k: "notebook notion" }, { e: "🏷️", k: "tag label" },
];

let popover: HTMLDivElement | null = null;

/** Open the emoji popover anchored under `anchor`; calls `onPick` with the choice. */
export function openEmojiPicker(anchor: HTMLElement, onPick: (emoji: string) => void) {
  close();
  const rect = anchor.getBoundingClientRect();

  const pop = document.createElement("div");
  Object.assign(pop.style, {
    position: "fixed",
    left: `${Math.round(rect.left)}px`,
    top: `${Math.round(rect.bottom + 4)}px`,
    width: "232px",
    background: "#fff",
    border: `1px solid ${palette.inkSoft}`,
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    padding: "8px",
    zIndex: "1000",
    font: "13px system-ui, sans-serif",
  });
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());

  const search = document.createElement("input");
  search.placeholder = "Search…";
  Object.assign(search.style, {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    marginBottom: "6px",
    border: `1px solid ${palette.inkSoft}`,
    borderRadius: "6px",
    outline: "none",
  });

  const grid = document.createElement("div");
  Object.assign(grid.style, { display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "2px", maxHeight: "180px", overflowY: "auto" });

  const draw = (q: string) => {
    grid.replaceChildren();
    const ql = q.trim().toLowerCase();
    for (const { e, k } of EMOJI) {
      if (ql && !k.includes(ql) && !e.includes(ql)) continue;
      const b = document.createElement("button");
      b.textContent = e;
      Object.assign(b.style, { fontSize: "18px", lineHeight: "1", border: "none", background: "none", cursor: "pointer", padding: "4px", borderRadius: "5px" });
      b.addEventListener("mouseenter", () => (b.style.background = palette.accent));
      b.addEventListener("mouseleave", () => (b.style.background = "none"));
      b.addEventListener("click", () => {
        onPick(e);
        close();
      });
      grid.appendChild(b);
    }
  };
  search.addEventListener("input", () => draw(search.value));
  draw("");

  pop.append(search, grid);
  document.body.appendChild(pop);
  popover = pop;
  search.focus();

  // Close on any outside press / Escape.
  setTimeout(() => {
    window.addEventListener("pointerdown", close, { once: true });
  });
  window.addEventListener("keydown", onKey);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

function close() {
  if (popover) {
    popover.remove();
    popover = null;
    window.removeEventListener("keydown", onKey);
  }
}
