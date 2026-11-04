import { Locomancer } from "./Locomancer";
import { Worldbuilder } from "./Worldbuilder";
import { CardLayer } from "./CardLayer";
import { ConnectionLayer } from "./connections";
import { UndoStack } from "./undo";
import { palette, locusColor } from "./palette";
import { measureContentBox } from "./imageCrop";
import { buildCardContent, blankNote, normalizeUrl, type CardContent } from "./cards";
import { makeStorage, type WorldFile, type MapState, type LinkMeta, type StrokeStamp } from "./storage";
import { InkLayer, strokeBounds, drawStroke, setBrushGrain, BRUSHES, type BrushId } from "./ink";
import { Machine } from "./machine";
import type { ChatReply, ChatRequest } from "./storage";
import type { Vec2, SpatialEntry, Stroke } from "./types";

const CARD_RADIUS = 100; //  ~200px DOM cards (used for card↔locus circle tests + ring layout)
const CARD_HALF_W = 100; //  card box half-width  (200px wide, matches CardLayer CSS)
const CARD_HALF_H = 70; //   card box half-height (~140px tall) for card↔card box collision
const LOCUS_RADIUS = 300; // ~600px loci, big enough for cards to bloom around

// ---------------------------------------------------------------------------
// Scene: start with no loci — you add them by dragging drawings from the
// toolbar (built below). A few homeless cards float to keep card rendering live.
// ---------------------------------------------------------------------------
const loco = new Locomancer();

// Card content lives here, keyed by the same id the Locomancer uses for space.
// Both the spatial registry (loco) and this map are rebuilt when switching maps.
const cardContent = new Map<string, CardContent>();
let cardCount = 0;

// Document identity: a normalized-URL → docId index, so re-pasting the same link
// reuses its document (and all placements share notes-context but one identity).
// Kept as a Map for O(1) duplicate checks even with many documents. Rebuilt from
// the cards when a map loads.
const urlIndex = new Map<string, string>();
let selectedCardId: string | null = null; // the card whose "Also in…" we show
let connectHoverId: string | null = null; // card under the cursor while drawing a link
const cardSelection = new Set<string>(); // a lasso-selected group of cards (multi-select)
// A lassoed drawing awaiting an action (its ⊙ menu offers Elevate). Holds the
// enclosed stroke ids + any card ids that ride with it (adopted on Elevate).
let drawingSelection: { strokes: string[]; cards: string[] } | null = null;

const world = new Worldbuilder(loco);

// Freehand ink (vector strokes). Loose marks in the world until elevated (Phase 2).
const ink = new InkLayer();

// Load the Pencil brush's grain texture (Grut P Middler) and hand it to the ink
// renderer; until it loads, Pencil falls back to a procedural grain.
const grainImg = new Image();
grainImg.onload = () => setBrushGrain(grainImg);
grainImg.src = `${import.meta.env.BASE_URL}brushes/p-middler-grain.png`;

// ---------------------------------------------------------------------------
// Canvas + camera. The camera (pan/zoom) lives entirely here in the harness —
// Worldbuilder draws in world coordinates and never knows about zoom.
// ---------------------------------------------------------------------------
const canvas = document.createElement("canvas");
Object.assign(document.body.style, { margin: "0", overflow: "hidden", background: palette.paper });
document.body.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

let zoom = 1;
const pan: Vec2 = { x: 0, y: 0 };
const dpr = () => window.devicePixelRatio || 1;

// Canvas tool mode, chosen via the segmented control in the toolbar.
//   move  — pan / drag loci / click to open (today's behavior)
//   draw  — freehand ink
//   lasso — enclose-and-select (the gesture renders now; its actions land in Phase 2)
// `setTool` (defined with the toolbar below) is hoisted, so the pointer handlers
// can call it. A stylus's first touch selects Draw once (penSeen), so the palette
// reflects "you picked up the pen" without locking you out of the other tools.
type Tool = "move" | "draw" | "lasso" | "erase";
let tool: Tool = "move";
let penSeen = false;
const ERASE_R = 16; // eraser radius in SCREEN px (converted to world units per-zoom)

function resize() {
  canvas.width = window.innerWidth * dpr();
  canvas.height = window.innerHeight * dpr();
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}
window.addEventListener("resize", resize);
resize();

// Convert a screen (mouse) point into world space, so clicks hit the right body.
function screenToWorld(sx: number, sy: number): Vec2 {
  const cx = window.innerWidth / 2 + pan.x;
  const cy = window.innerHeight / 2 + pan.y;
  return { x: (sx - cx) / zoom, y: (sy - cy) / zoom };
}

// Inverse of screenToWorld — used to anchor DOM overlays (the ⊙ menu) at a world point.
function worldToScreen(wx: number, wy: number): Vec2 {
  return { x: wx * zoom + (window.innerWidth / 2 + pan.x), y: wy * zoom + (window.innerHeight / 2 + pan.y) };
}

// Undo (structural actions), and highlight-mode for note text (toolbar toggle).
let highlightMode = false;
let focusedLocusId: string | null = null; // the open locus the Delete button targets
const undo = new UndoStack(() => updateToolbar());

// Cards are real DOM elements over the canvas; the layer handles their own
// dragging/editing and reads positions from the Locomancer each frame. The
// connection layer (SVG) is declared first so cards can start connections from it.
let connectionLayer: ConnectionLayer;
const cardLayer = new CardLayer(loco, cardContent, screenToWorld, {
  undo,
  isHighlightMode: () => highlightMode,
  startConnection: (fromId, ev) => connectionLayer.startDrag(fromId, ev),
  onSelect: (id) => {
    selectedCardId = id;
  },
  onIdentityEdit: (id) => syncDocIdentity(id),
  isSelected: (id) => id === selectedCardId,
  isConnectTarget: (id) => id === connectHoverId,
  isLoading: (id) => loadingCards.has(id),
  openLink: (url) => {
    if (window.locusAPI?.openLink) void window.locusAPI.openLink(url);
    else window.open(url, "_blank", "noopener");
  },
  getSelection: () => cardSelection,
  clearSelection: () => cardSelection.clear(),
  isMultiSelected: (id) => cardSelection.has(id),
});
connectionLayer = new ConnectionLayer(
  loco,
  undo,
  screenToWorld,
  (w) => cardLayer.cardAt(w),
  (id) => {
    connectHoverId = id;
  },
);

// ---------------------------------------------------------------------------
// Canvas interaction (loci + panning only — cards manage themselves):
//   - drag a locus to reposition it; its cards ride along
//   - click a locus (press without dragging) to open / close it
//   - two-finger trackpad scroll pans; pinch (ctrl+wheel) zooms about the cursor
//   - drag empty space to pan as well
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD = 4; // screen px a press must move before it counts as a drag

type Drag =
  | { kind: "locus"; id: string; grab: Vec2; moved: boolean; start: Vec2 }
  | { kind: "pan"; last: Vec2 }
  | { kind: "draw" } //              an ink stroke in progress (InkLayer holds the points)
  | { kind: "lasso"; pts: Vec2[]; machine?: boolean } // an enclosure being traced (world points); machine = a Machine tool is armed
  | { kind: "drawing"; ids: string[]; last: Vec2; start: Vec2 } // a selected drawing being moved
  | { kind: "erase"; removed: Stroke[] } // strokes wiped this gesture (for one undo)
  | null;
let drag: Drag = null;

// Topmost locus under a world point, if any.
function locusAt(w: Vec2) {
  for (const e of loco.activeEntries()) {
    if (e.kind !== "locus") continue;
    if (Math.hypot(w.x - e.position.x, w.y - e.position.y) <= e.radius) return e;
  }
  return null;
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  const screen: Vec2 = { x: ev.clientX, y: ev.clientY };
  const w = screenToWorld(screen.x, screen.y);

  // A Machine tool is armed → any canvas press traces a lasso to mark WHERE the
  // tool should act (overrides pan/locus/etc.). On release it fires the tool.
  if (machine.isArmed()) {
    drag = { kind: "lasso", pts: [w], machine: true };
    return;
  }

  // A stylus's first touch selects Draw (one-time nudge), so the palette shows
  // you've picked up the pen. After that the chosen tool sticks — the pen can
  // lasso and move too, until you switch tools yourself.
  if (ev.pointerType === "pen" && !penSeen) {
    penSeen = true;
    setTool("draw");
  }

  // Drag a lassoed drawing: pressing inside its box moves the whole drawing
  // (default behavior, no menu). Keeps the selection; beats pan/lasso/locus.
  // Only in Move/Lasso — Draw paints over it, Erase wipes it.
  if ((tool === "move" || tool === "lasso") && drawingSelection && insideDrawingSelection(w)) {
    drag = { kind: "drawing", ids: [...drawingSelection.strokes], last: w, start: w };
    return;
  }

  // Any other canvas press clears the current selections.
  selectedCardId = null; // card "Also in…" selection
  cardSelection.clear(); // a lassoed card group
  clearDrawingSelection(); // a lassoed drawing (+ its ⊙ menu)

  if (tool === "draw") {
    ink.begin(w, { ...BRUSHES[activeBrush], width: activeNib });
    drag = { kind: "draw" };
    return;
  }
  if (tool === "lasso") {
    drag = { kind: "lasso", pts: [w] };
    return;
  }
  if (tool === "erase") {
    // Whole-stroke eraser, drawings only. Wipe under the press, then under the drag.
    drag = { kind: "erase", removed: ink.eraseAt(w, ERASE_R / zoom) };
    return;
  }

  // Move tool: grab a locus, else pan empty space.
  const locus = locusAt(w);
  if (locus) {
    // Pin so it tracks the cursor 1:1 (no spring, immovable to footprint pushes)
    // while dragged. moveLocus sets both its position and home and carries cards.
    locus.pinned = true;
    drag = {
      kind: "locus",
      id: locus.id,
      grab: { x: locus.position.x - w.x, y: locus.position.y - w.y },
      moved: false,
      start: screen,
    };
    return;
  }

  drag = { kind: "pan", last: screen };
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  // No button held but a drag is still "live" → a pointerup was lost (released
  // off-window, etc.). Finalize it so the gesture stops chasing the bare cursor.
  if (ev.buttons === 0) {
    endDrag(ev);
    return;
  }
  const screen: Vec2 = { x: ev.clientX, y: ev.clientY };
  if (drag.kind === "draw") {
    ink.extend(screenToWorld(screen.x, screen.y));
  } else if (drag.kind === "lasso") {
    drag.pts.push(screenToWorld(screen.x, screen.y));
  } else if (drag.kind === "drawing") {
    const w = screenToWorld(screen.x, screen.y);
    ink.translate(drag.ids, w.x - drag.last.x, w.y - drag.last.y); // shift the whole drawing
    drag.last = w;
  } else if (drag.kind === "erase") {
    drag.removed.push(...ink.eraseAt(screenToWorld(screen.x, screen.y), ERASE_R / zoom));
  } else if (drag.kind === "locus") {
    const w = screenToWorld(screen.x, screen.y);
    loco.moveLocus(drag.id, { x: w.x + drag.grab.x, y: w.y + drag.grab.y });
    if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) > DRAG_THRESHOLD) {
      drag.moved = true;
    }
  } else {
    pan.x += screen.x - drag.last.x;
    pan.y += screen.y - drag.last.y;
    drag.last = screen;
  }
});

function endDrag(ev: PointerEvent) {
  if (drag?.kind === "draw") {
    const id = ink.end();
    if (id) undo.push("draw", () => void ink.remove(id));
  } else if (drag?.kind === "drawing") {
    // Rigid move of a selected drawing → one undo that shifts it back.
    const net = { x: drag.last.x - drag.start.x, y: drag.last.y - drag.start.y };
    if (net.x !== 0 || net.y !== 0) {
      const ids = drag.ids;
      undo.push("move drawing", () => ink.translate(ids, -net.x, -net.y));
    }
  } else if (drag?.kind === "erase") {
    const removed = drag.removed;
    if (removed.length) undo.push("erase", () => removed.forEach((s) => ink.add(s)));
  } else if (drag?.kind === "lasso") {
    const poly = drag.pts;
    if (drag.machine) {
      // A Machine-armed lasso: hand the enclosed houses + cards to the tool.
      if (poly.length >= 3) {
        const sel = lassoSelect(poly);
        const at = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
        machine.handleLasso({ loci: sel.loci, cards: sel.cards }, at);
      }
    } else if (poly.length >= 3) {
      const sel = lassoSelect(poly);
      if (sel.ink.length > 0) {
        // Ink present → SELECT the drawing (for move/edit/elevate). Its ⊙ menu
        // offers Elevate; lassoing no longer elevates on its own. Cards enclosed
        // alongside the drawing ride with it (adopted if/when you Elevate).
        drawingSelection = { strokes: sel.ink.map((s) => s.id), cards: sel.cards.map((c) => c.id) };
      } else if (sel.cards.length > 0) {
        // Only cards → select them as a group; dragging the group onto a locus
        // assigns them all. (Loci-only selections are a future verb.)
        for (const c of sel.cards) cardSelection.add(c.id);
      }
    }
  } else if (drag?.kind === "locus") {
    const locus = loco.get(drag.id)!;
    locus.pinned = false; // back into the expansion field
    // target already tracks the drop point (set 1:1 while dragging). The field
    // (now small, overflow-based) reapplies on its own next frame.
    if (!drag.moved) {
      // a press without a drag is a click → toggle the locus open/closed
      if (locus.open) {
        loco.closeLocus(drag.id);
        if (focusedLocusId === drag.id) focusedLocusId = null;
      } else {
        loco.openLocus(drag.id);
        focusedLocusId = drag.id; // the Delete button targets the locus you just opened
      }
      updateToolbar();
    }
  }
  drag = null;
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------------------------------------------------------------------------
// Lasso selection + elevation. The lasso yields a kind-agnostic SELECTION (the
// ink / cards / loci its loop encloses); separable verbs then act on it, so new
// gestures (e.g. "drag several loci together") are just new verbs, not lasso
// changes. Today's verb: enclosing ink ELEVATES it into a stroke-backed Locus
// that adopts the enclosed cards. pointInPolygon is the reusable enclosure test.
// ---------------------------------------------------------------------------

/** Even-odd ray cast: is world point `p` inside the (implicitly closed) polygon? */
function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Mean of a stroke's points — a cheap, robust "is this stroke inside" proxy. */
function strokeCentroid(s: Stroke): Vec2 {
  let sx = 0;
  let sy = 0;
  for (const p of s.points) {
    sx += p.x;
    sy += p.y;
  }
  const n = s.points.length || 1;
  return { x: sx / n, y: sy / n };
}

/** Everything the lasso loop encloses, split by kind. */
function lassoSelect(poly: Vec2[]): { ink: Stroke[]; cards: SpatialEntry[]; loci: SpatialEntry[] } {
  const inkSel = ink.list().filter((s) => pointInPolygon(strokeCentroid(s), poly));
  const cards: SpatialEntry[] = [];
  const loci: SpatialEntry[] = [];
  for (const e of loco.activeEntries()) {
    if (!pointInPolygon(e.position, poly)) continue;
    if (e.kind === "card") cards.push(e);
    else if (e.kind === "locus") loci.push(e);
  }
  return { ink: [...inkSel], cards, loci };
}

/** Deep-copy strokes (so a locus and its toolbar stamp never share point objects). */
function cloneStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.map((s) => ({ id: s.id, style: { ...s.style }, points: s.points.map((p) => ({ ...p })) }));
}

/**
 * Elevate a drawing into a Locus — the single act: it becomes card-owning AND
 * graduates into the toolbar as a reusable stamp. The loose ink leaves the world
 * and becomes the locus's (center-relative) drawing; enclosed cards are adopted.
 */
function elevate(strokes: Stroke[], cards: SpatialEntry[]) {
  if (strokes.length === 0) return;
  // The drawing's world bounds → the locus center + a bounding-circle radius.
  const b = strokeBounds(strokes);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const radius = Math.max(40, Math.max((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2) + 16);
  // Re-express strokes RELATIVE to the center so the drawing rides along with the
  // locus and can be reused as a stamp.
  const local: Stroke[] = strokes.map((s) => ({
    id: s.id,
    style: { ...s.style },
    points: s.points.map((p) => ({ x: p.x - cx, y: p.y - cy, p: p.p })),
  }));

  const idx = locusCount;
  const id = `locus-${idx}`;
  locusCount++;

  // Snapshot adopted cards first, so undo restores them exactly as they were.
  const cardSnaps = cards.map((c) => ({ id: c.id, snap: loco.snapshot(c.id) }));
  const removed = ink.removeMany(strokes.map((s) => s.id)); // pulled from loose ink

  loco.addLocus({ id, position: { x: cx, y: cy }, radius, color: locusColor(idx), strokes: local });
  loco.openLocus(id); // open so the adopted cards keep their on-screen spots
  for (const c of cards) loco.assignCard(c.id, id, c.position);

  // Graduate: the drawing also becomes a reusable toolbar stamp (its own copy).
  const stamp: StrokeStamp = { id: `stamp-${stampCount++}`, strokes: cloneStrokes(local) };
  addStamp(stamp);

  focusedLocusId = id;
  updateToolbar();

  undo.push("elevate", () => {
    for (const { id: cid, snap } of cardSnaps) loco.applySnapshot(cid, snap);
    loco.remove(id);
    for (const s of removed) ink.add(s); // strokes return to loose ink
    removeStamp(stamp.id); //               and the graduated stamp goes away
    if (focusedLocusId === id) focusedLocusId = null;
    updateToolbar();
  });
}

// ---------------------------------------------------------------------------
// Drawing-selection menu. Lassoing a drawing selects it and floats a small ⊙
// handle at the selection's upper-right; clicking the handle opens a menu whose
// Elevate turns the drawing into a Locus (+ toolbar stamp). Future edit/erase
// tools will live in this same menu.
// ---------------------------------------------------------------------------
const selHandle = document.createElement("button");
selHandle.textContent = "⋯";
selHandle.title = "drawing options";
Object.assign(selHandle.style, {
  position: "fixed",
  width: "26px",
  height: "26px",
  borderRadius: "50%",
  border: `1px solid ${palette.ink}`,
  background: palette.knob,
  color: "#fff",
  font: "15px system-ui, sans-serif",
  lineHeight: "1",
  padding: "0",
  cursor: "pointer",
  display: "none",
  zIndex: "11",
});
document.body.appendChild(selHandle);

const selMenu = document.createElement("div");
Object.assign(selMenu.style, {
  position: "fixed",
  display: "none",
  background: "#fff",
  border: `1px solid ${palette.inkSoft}`,
  borderRadius: "8px",
  boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
  padding: "4px",
  zIndex: "12",
});
const elevateItem = document.createElement("button");
elevateItem.textContent = "⤴ Elevate";
Object.assign(elevateItem.style, {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: palette.ink,
  font: "13px system-ui, sans-serif",
  padding: "7px 14px",
  borderRadius: "6px",
  cursor: "pointer",
  whiteSpace: "nowrap",
});
elevateItem.addEventListener("mouseenter", () => (elevateItem.style.background = palette.accent));
elevateItem.addEventListener("mouseleave", () => (elevateItem.style.background = "transparent"));
elevateItem.addEventListener("click", () => elevateSelection());
selMenu.appendChild(elevateItem);
document.body.appendChild(selMenu);

let selMenuOpen = false;
selHandle.addEventListener("click", (ev) => {
  ev.stopPropagation();
  selMenuOpen = !selMenuOpen;
});
// A press anywhere that isn't the handle/menu closes the menu (the canvas press
// also clears the whole selection via clearDrawingSelection).
document.addEventListener("pointerdown", (ev) => {
  if (!selMenuOpen) return;
  const t = ev.target as Node;
  if (selHandle.contains(t) || selMenu.contains(t)) return;
  selMenuOpen = false;
});

function clearDrawingSelection() {
  drawingSelection = null;
  selMenuOpen = false;
}

/** Live strokes that make up the current drawing selection. */
function selectionStrokes(): Stroke[] {
  if (!drawingSelection) return [];
  const ids = new Set(drawingSelection.strokes);
  return ink.list().filter((s) => ids.has(s.id));
}

/** Is a world point within the selected drawing's (padded) bounding box? */
function insideDrawingSelection(p: Vec2): boolean {
  const strokes = selectionStrokes();
  if (strokes.length === 0) return false;
  const b = strokeBounds(strokes);
  const pad = 8;
  return p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;
}

/** Elevate the current selection: drawing → Locus (+ toolbar stamp), adopt cards. */
function elevateSelection() {
  if (!drawingSelection) return;
  const strokes = selectionStrokes();
  const cards = drawingSelection.cards
    .map((cid) => loco.get(cid))
    .filter((e): e is SpatialEntry => !!e && e.kind === "card");
  clearDrawingSelection();
  if (strokes.length) elevate(strokes, cards);
}

/** Each frame: float the ⊙ handle at the selection's upper-right; show/hide both. */
function updateSelectionUI() {
  const strokes = selectionStrokes();
  if (!drawingSelection || strokes.length === 0) {
    selHandle.style.display = "none";
    selMenu.style.display = "none";
    return;
  }
  const b = strokeBounds(strokes);
  const tr = worldToScreen(b.maxX, b.minY); // upper-right corner, in screen space
  selHandle.style.left = `${tr.x + 6}px`;
  selHandle.style.top = `${tr.y - 32}px`;
  selHandle.style.display = "";
  if (selMenuOpen) {
    selMenu.style.left = `${tr.x + 6}px`;
    selMenu.style.top = `${tr.y + 4}px`;
    selMenu.style.display = "";
  } else {
    selMenu.style.display = "none";
  }
}

// Wheel handling is on WINDOW (not the canvas) so a pinch over a card/toolbar
// never triggers the browser's own page-zoom (which would scale the fixed UI).
window.addEventListener(
  "wheel",
  (ev) => {
    if (ev.ctrlKey) {
      // Pinch → zoom the WORLD, anchored at the cursor (the point under the
      // cursor stays put). Always prevent the browser's page-zoom.
      ev.preventDefault();
      const before = screenToWorld(ev.clientX, ev.clientY);
      zoom *= ev.deltaY < 0 ? 1.08 : 0.92;
      zoom = Math.max(0.2, Math.min(3, zoom));
      pan.x = ev.clientX - window.innerWidth / 2 - before.x * zoom;
      pan.y = ev.clientY - window.innerHeight / 2 - before.y * zoom;
    } else if (ev.target === canvas) {
      // Two-finger scroll over empty canvas → pan. Over the sidebar or a card,
      // we leave it alone so those scroll natively.
      ev.preventDefault();
      pan.x -= ev.deltaX;
      pan.y -= ev.deltaY;
    }
  },
  { passive: false },
);


// ---------------------------------------------------------------------------
// Locus toolbar: a miniature of every preset drawing in public/loci/, plus any
// hand-drawn drawings you've graduated via Elevate. Drag one onto the canvas to
// drop a locus there. Drawings are REUSABLE — drag the same one as many times as
// you like (the old one-use-per-drawing rule is gone).
// ---------------------------------------------------------------------------
const LOCUS_IMAGES = [
  "Untitled_Artwork.png",
  ...Array.from({ length: 11 }, (_, i) => `Untitled_Artwork(${i + 1}).png`),
];

// Keyed by FILENAME (env-independent). The actual URL is built via BASE_URL so it
// resolves under both the dev server ("/…") and Electron's file:// ("./…").
const locusUrl = (name: string) => `${import.meta.env.BASE_URL}loci/${encodeURI(name)}`;
const locusImages = new Map<string, HTMLImageElement>(); // name -> preloaded image
let locusCount = 0;
// Graduated hand-drawn drawings, reusable from the toolbar (global across maps).
const stamps = new Map<string, StrokeStamp>(); //   id -> stamp
const stampTiles = new Map<string, HTMLElement>(); // id -> toolbar tile (canvas + delete ×)
let stampCount = 0;
const presetTiles = new Map<string, HTMLElement>(); // preset filename -> toolbar tile
let openDeleteTile: HTMLElement | null = null; // the toolbar tile currently showing its ×

const toolbar = document.createElement("div");
Object.assign(toolbar.style, {
  position: "fixed",
  top: "0",
  left: "0",
  right: "0",
  height: "56px",
  display: "flex",
  gap: "6px",
  alignItems: "center",
  padding: "6px 10px",
  background: palette.toolbar,
  borderBottom: `1px solid ${palette.inkSoft}`,
  overflowX: "auto",
  zIndex: "10",
});
document.body.appendChild(toolbar);

// --- action buttons: Highlight (toggle) + Undo (pushed to the right) --------
function makeButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b.style, {
    flex: "0 0 auto",
    font: "13px system-ui, sans-serif",
    padding: "6px 10px",
    borderRadius: "6px",
    border: `1px solid ${palette.inkSoft}`,
    background: palette.accent,
    color: palette.ink,
    cursor: "pointer",
  });
  return b;
}

const highlightBtn = makeButton("✎ Highlight");
highlightBtn.addEventListener("click", () => {
  highlightMode = !highlightMode;
  updateToolbar();
});

const undoBtn = makeButton("↩ Undo");
undoBtn.addEventListener("click", () => undo.undo());

// Google sign-in (Electron only) so Drive links can be fetched/opened while authed.
let googleBtn: HTMLButtonElement | null = null;
if (window.locusAPI?.loginGoogle) {
  googleBtn = makeButton("Sign in to Google");
  googleBtn.addEventListener("click", async () => {
    await window.locusAPI!.loginGoogle!();
    void refreshGoogleBtn();
  });
}
async function refreshGoogleBtn() {
  if (!googleBtn || !window.locusAPI?.authStatus) return;
  const signedIn = await window.locusAPI.authStatus();
  googleBtn.textContent = signedIn ? "✓ Google" : "Sign in to Google";
  googleBtn.style.background = signedIn ? "#cfe8d0" : palette.accent;
}

const deleteBtn = makeButton("🗑 Delete");
deleteBtn.style.background = palette.danger;
deleteBtn.addEventListener("click", () => {
  const id = currentOpenLocus();
  if (!id) return;
  if (!window.confirm("Delete locus, are you sure?")) return;
  deleteLocus(id);
});

// --- tool palette: ONE segmented control (Move | Draw | Lasso) --------------
// Sits left of Highlight. It looks like a single pill button with interior tabs;
// the active tab is filled. Picking up the stylus selects Draw (see penSeen),
// so this control always shows the live tool.
const TOOLS: { id: Tool; label: string }[] = [
  { id: "move", label: "✋ Move" },
  { id: "draw", label: "✏ Draw" },
  { id: "lasso", label: "◯ Lasso" },
  { id: "erase", label: "⌫ Erase" },
];
const toolPalette = document.createElement("div");
Object.assign(toolPalette.style, {
  flex: "0 0 auto",
  display: "flex",
  borderRadius: "6px",
  border: `1px solid ${palette.inkSoft}`,
  overflow: "hidden", // so the children's corners are clipped to the pill
});
const toolTabs = new Map<Tool, HTMLButtonElement>();
TOOLS.forEach((t, i) => {
  const tab = document.createElement("button");
  tab.textContent = t.label;
  Object.assign(tab.style, {
    flex: "0 0 auto",
    border: "none",
    borderLeft: i === 0 ? "none" : `1px solid ${palette.inkSoft}`, // interior dividers only
    background: "transparent",
    color: palette.ink,
    font: "13px system-ui, sans-serif",
    padding: "6px 10px",
    cursor: "pointer",
  });
  tab.addEventListener("click", () => setTool(t.id));
  toolTabs.set(t.id, tab);
  toolPalette.appendChild(tab);
});

// --- brush picker: a second segmented control, shown only while Draw is active.
const BRUSH_TABS: { id: BrushId; label: string }[] = [
  { id: "pen", label: "Pen" }, //       Studio Pen
  { id: "pencil", label: "Pencil" }, // Little Pine
];
let activeBrush: BrushId = "pencil";
const brushBar = document.createElement("div");
Object.assign(brushBar.style, {
  flex: "0 0 auto",
  display: "none", // setTool shows this only in Draw mode
  borderRadius: "6px",
  border: `1px solid ${palette.inkSoft}`,
  overflow: "hidden",
});
const brushTabs = new Map<BrushId, HTMLButtonElement>();
BRUSH_TABS.forEach((b, i) => {
  const tab = document.createElement("button");
  tab.textContent = b.label;
  Object.assign(tab.style, {
    flex: "0 0 auto",
    border: "none",
    borderLeft: i === 0 ? "none" : `1px solid ${palette.inkSoft}`,
    background: "transparent",
    color: palette.ink,
    font: "13px system-ui, sans-serif",
    padding: "6px 10px",
    cursor: "pointer",
  });
  tab.addEventListener("click", () => setBrush(b.id));
  brushTabs.set(b.id, tab);
  brushBar.appendChild(tab);
});
function setBrush(b: BrushId) {
  activeBrush = b;
  for (const [id, tab] of brushTabs) {
    const on = id === b;
    tab.style.background = on ? palette.knob : "transparent";
    tab.style.color = on ? "#ffffff" : palette.ink;
    tab.style.fontWeight = on ? "600" : "400";
  }
}
setBrush(activeBrush);

// --- nib size: a continuous slider (+ a live size dot), shown only in Draw mode.
const NIB_MIN = 1;
const NIB_MAX = 30;
let activeNib = 4;
const nibBar = document.createElement("div");
Object.assign(nibBar.style, {
  flex: "0 0 auto",
  display: "none", // setTool shows this only in Draw mode
  alignItems: "center",
  gap: "8px",
  height: "30px",
  padding: "0 10px",
  borderRadius: "6px",
  border: `1px solid ${palette.inkSoft}`,
});
const nibSlider = document.createElement("input");
nibSlider.type = "range";
nibSlider.min = String(NIB_MIN);
nibSlider.max = String(NIB_MAX);
nibSlider.step = "1";
nibSlider.title = "nib size";
Object.assign(nibSlider.style, { width: "120px", cursor: "pointer", accentColor: palette.knob });
const nibDotBox = document.createElement("span"); // fixed box so the layout doesn't jump
Object.assign(nibDotBox.style, { width: "20px", height: "20px", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" });
const nibDot = document.createElement("span"); // grows/shrinks to preview the nib
Object.assign(nibDot.style, { borderRadius: "50%", background: palette.ink });
nibDotBox.appendChild(nibDot);
function setNib(n: number) {
  activeNib = Math.max(NIB_MIN, Math.min(NIB_MAX, n));
  nibSlider.value = String(activeNib);
  const d = Math.max(3, Math.min(activeNib, 18)); // capped visual dot
  nibDot.style.width = `${d}px`;
  nibDot.style.height = `${d}px`;
}
nibSlider.addEventListener("input", () => setNib(Number(nibSlider.value)));
nibBar.append(nibSlider, nibDotBox);
setNib(activeNib);

// Hoisted so the pointer handlers (defined earlier) can call it. Sets the mode,
// the canvas cursor, the active-tab styling, and reveals the brush picker in Draw.
function setTool(t: Tool) {
  tool = t;
  canvas.style.cursor = t === "move" ? "" : "crosshair";
  brushBar.style.display = t === "draw" ? "flex" : "none";
  nibBar.style.display = t === "draw" ? "flex" : "none";
  for (const [id, tab] of toolTabs) {
    const on = id === t;
    tab.style.background = on ? palette.knob : "transparent";
    tab.style.color = on ? "#ffffff" : palette.ink;
    tab.style.fontWeight = on ? "600" : "400";
  }
}
setTool("move");

// Right-aligned cluster (margin-left:auto pushes it to the far right).
const actions = document.createElement("div");
Object.assign(actions.style, { marginLeft: "auto", display: "flex", gap: "6px", flex: "0 0 auto", alignItems: "center" });
actions.append(toolPalette, brushBar, nibBar, highlightBtn, undoBtn, deleteBtn);
if (googleBtn) actions.append(googleBtn);

function updateToolbar() {
  highlightBtn.style.background = highlightMode ? "#ffe066" : palette.accent;
  undoBtn.disabled = !undo.canUndo;
  undoBtn.style.opacity = undo.canUndo ? "1" : "0.4";
  undoBtn.style.cursor = undo.canUndo ? "pointer" : "default";
  deleteBtn.style.display = currentOpenLocus() ? "" : "none"; // only when a locus is open
}
updateToolbar();

const THUMB = 44; // css px

for (const name of LOCUS_IMAGES) {
  const img = new Image();
  locusImages.set(name, img); // preloaded once, reused for every locus drawn from it

  const thumb = document.createElement("canvas");
  thumb.width = THUMB * dpr();
  thumb.height = THUMB * dpr();
  thumb.draggable = true;
  Object.assign(thumb.style, {
    width: `${THUMB}px`,
    height: `${THUMB}px`,
    flex: "0 0 auto",
    cursor: "grab",
    borderRadius: "6px",
    border: `1px solid ${palette.inkSoft}`,
    background: palette.locusBody,
  });
  thumb.addEventListener("dragstart", (ev) => {
    ev.dataTransfer?.setData("text/locus", name);
  });
  const tile = makeTile(thumb, () => hidePreset(name));
  presetTiles.set(name, tile);
  toolbar.appendChild(tile);

  // Draw the cropped, centered drawing into the thumbnail once it loads.
  img.onload = () => drawThumb(thumb, img);
  img.src = locusUrl(name);
}

// Action buttons sit to the RIGHT of the locus drawings.
toolbar.appendChild(actions);

// Render an image's content (margins trimmed) centered + fitted into a thumbnail.
function drawThumb(canvas: HTMLCanvasElement, img: HTMLImageElement) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  const crop = measureContentBox(img);
  const sx = crop ? crop.sx : 0;
  const sy = crop ? crop.sy : 0;
  const sw = crop ? crop.sw : img.naturalWidth;
  const sh = crop ? crop.sh : img.naturalHeight;
  const pad = 4 * dpr();
  const scale = Math.min((W - 2 * pad) / sw, (H - 2 * pad) / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  g.drawImage(img, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// Wrap a toolbar thumbnail in a tile with a click-to-reveal × that removes it
// (behind an "are you sure" gate). Click the tile → its × appears; click another
// tile's × hides this one. Dragging the thumbnail still places a locus.
function makeTile(thumb: HTMLCanvasElement, onDelete: () => void): HTMLDivElement {
  const tile = document.createElement("div");
  Object.assign(tile.style, { position: "relative", flex: "0 0 auto", display: "inline-flex" });
  tile.appendChild(thumb);

  const x = document.createElement("button");
  x.textContent = "×";
  x.title = "remove from toolbar";
  Object.assign(x.style, {
    position: "absolute",
    top: "-6px",
    right: "-6px",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    border: `1px solid ${palette.ink}`,
    background: palette.danger,
    color: palette.ink,
    font: "12px system-ui, sans-serif",
    lineHeight: "1",
    padding: "0",
    cursor: "pointer",
    display: "none",
    zIndex: "1",
  });
  tile.appendChild(x);

  thumb.addEventListener("click", () => {
    if (openDeleteTile && openDeleteTile !== tile) {
      const prev = openDeleteTile.querySelector("button");
      if (prev) (prev as HTMLElement).style.display = "none";
    }
    const showing = x.style.display !== "none";
    x.style.display = showing ? "none" : "";
    openDeleteTile = showing ? null : tile;
  });
  x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!window.confirm("Remove this drawing from the toolbar?")) return;
    onDelete();
    tile.remove();
    if (openDeleteTile === tile) openDeleteTile = null;
  });
  return tile;
}

// Hide a preset drawing from the toolbar, persistently (the asset stays on disk).
function hidePreset(name: string) {
  worldFile.hiddenPresets ??= [];
  if (!worldFile.hiddenPresets.includes(name)) worldFile.hiddenPresets.push(name);
}

// Render a set of (center-relative) strokes fitted + centered into a thumbnail.
function drawStampThumb(canvas: HTMLCanvasElement, strokes: Stroke[]) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  if (strokes.length === 0) return;
  const b = strokeBounds(strokes);
  const sw = b.maxX - b.minX || 1;
  const sh = b.maxY - b.minY || 1;
  const pad = 6 * dpr();
  const scale = Math.min((W - 2 * pad) / sw, (H - 2 * pad) / sh);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  g.save();
  g.translate(W / 2, H / 2);
  g.scale(scale, scale);
  for (const s of strokes) {
    // Keep lines legible at thumbnail scale (they'd otherwise shrink to a hair).
    const legible: Stroke = { ...s, style: { ...s.style, width: Math.max(s.style.width, 1.5 / scale) } };
    drawStroke(g, legible, -cx, -cy);
  }
  g.restore();
}

// Build a draggable toolbar thumbnail for a graduated drawing, left of the actions.
function addStampThumb(stamp: StrokeStamp) {
  const thumb = document.createElement("canvas");
  thumb.width = THUMB * dpr();
  thumb.height = THUMB * dpr();
  thumb.draggable = true;
  thumb.title = "hand-drawn — drag to place";
  Object.assign(thumb.style, {
    width: `${THUMB}px`,
    height: `${THUMB}px`,
    flex: "0 0 auto",
    cursor: "grab",
    borderRadius: "6px",
    border: `1px solid ${palette.inkSoft}`,
    background: palette.locusBody,
  });
  thumb.addEventListener("dragstart", (ev) => ev.dataTransfer?.setData("text/locus-stamp", stamp.id));
  drawStampThumb(thumb, stamp.strokes);
  const tile = makeTile(thumb, () => removeStamp(stamp.id));
  stampTiles.set(stamp.id, tile);
  toolbar.insertBefore(tile, actions); // after the preset drawings, before the actions
}

// Add / remove a graduated drawing (keeps the live map, worldFile, and toolbar in sync).
function addStamp(stamp: StrokeStamp) {
  stamps.set(stamp.id, stamp);
  worldFile.stamps ??= [];
  if (!worldFile.stamps.some((s) => s.id === stamp.id)) worldFile.stamps.push(stamp);
  addStampThumb(stamp);
}
function removeStamp(id: string) {
  stamps.delete(id);
  if (worldFile.stamps) worldFile.stamps = worldFile.stamps.filter((s) => s.id !== id);
  const tile = stampTiles.get(id);
  if (tile) {
    tile.remove();
    stampTiles.delete(id);
  }
}

// Rebuild all graduated-drawing thumbnails from worldFile.stamps (called on boot).
function renderStamps() {
  for (const tile of stampTiles.values()) tile.remove();
  stampTiles.clear();
  stamps.clear();
  stampCount = 0;
  for (const stamp of worldFile.stamps ?? []) {
    stamps.set(stamp.id, stamp);
    addStampThumb(stamp);
    const n = Number(stamp.id.split("-")[1]);
    if (Number.isFinite(n) && n >= stampCount) stampCount = n + 1;
  }
}

// Drop a dragged drawing → locus; drop a URL/text from elsewhere → card.
canvas.addEventListener("dragover", (ev) => ev.preventDefault());
canvas.addEventListener("drop", (ev) => {
  ev.preventDefault();
  const w = screenToWorld(ev.clientX, ev.clientY);

  // A graduated hand-drawn drawing → a fresh stroke-backed locus (its own copy).
  const stampId = ev.dataTransfer?.getData("text/locus-stamp");
  if (stampId) {
    const stamp = stamps.get(stampId);
    if (!stamp) return;
    const local = cloneStrokes(stamp.strokes);
    const b = strokeBounds(local);
    const radius = Math.max(40, Math.max((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2) + 16);
    const id = `locus-${locusCount}`;
    loco.addLocus({ id, position: w, radius, color: locusColor(locusCount), strokes: local });
    locusCount++;
    undo.push("add locus", () => loco.remove(id));
    return;
  }

  // A preset drawing → an image-backed locus. Reusable: no one-use gating.
  const locusSrc = ev.dataTransfer?.getData("text/locus");
  if (locusSrc) {
    const id = `locus-${locusCount}`;
    loco.addLocus({
      id,
      position: w,
      radius: LOCUS_RADIUS,
      color: locusColor(locusCount),
      imageSrc: locusSrc,
      image: locusImages.get(locusSrc),
    });
    locusCount++;
    undo.push("add locus", () => loco.remove(id));
    return;
  }

  const text = ev.dataTransfer?.getData("text/uri-list") || ev.dataTransfer?.getData("text/plain");
  if (text && text.trim()) addNoteCard(buildCardContent(text.trim()), w);
});

// ---------------------------------------------------------------------------
// Card creation. New cards are homeless (no locus) until a locus catches them
// later. Content is set first, then the body — the CardLayer builds the DOM
// element on the next sync and reads the content then. Editing is inline in the
// DOM card itself (see CardLayer).
// ---------------------------------------------------------------------------
function addNoteCard(content: CardContent, at: Vec2) {
  const id = `card-${cardCount++}`;
  let isNewDoc = true;
  // Exact-URL dedup: if this link's normalized URL already exists, this card is a
  // new PLACEMENT of that same document — adopt its docId + shared identity.
  if (content.url) {
    const norm = normalizeUrl(content.url);
    const existing = urlIndex.get(norm);
    if (existing) {
      isNewDoc = false;
      const sib = [...cardContent.values()].find((c) => c.docId === existing);
      if (sib) {
        content = { ...content, docId: existing, title: sib.title, url: sib.url, icon: sib.icon, source: sib.source, image: sib.image, description: sib.description };
      }
    } else {
      urlIndex.set(norm, content.docId);
    }
  }
  cardContent.set(id, content);
  loco.addCard({ id, position: at, radius: CARD_RADIUS, halfW: CARD_HALF_W, halfH: CARD_HALF_H });
  undo.push("add card", () => {
    loco.remove(id);
    cardContent.delete(id);
  });
  // Fetch a link's preview for a brand-new document, OR re-try one we adopted that
  // never got a successful preview before (no image and no description — e.g. an
  // earlier transient failure or bot-challenge). Without this re-try, re-pasting a
  // link that failed once would dedupe to the stale doc and keep its URL-tail title.
  if (content.url) {
    const neverPreviewed = !content.image && !content.description;
    if (isNewDoc || neverPreviewed) void fetchPreview(id, content.url);
  }
}

// Fetch a link's title/description/screenshot (Electron main process) and fold it
// into the card and its document siblings.
const loadingCards = new Set<string>();
async function fetchPreview(id: string, url: string) {
  if (!window.locusAPI?.fetchLink) return;
  loadingCards.add(id);
  let meta: LinkMeta | null = null;
  try {
    meta = await window.locusAPI.fetchLink(url);
  } catch {
    meta = null;
  }
  loadingCards.delete(id);
  const cur = cardContent.get(id);
  if (!cur || !meta) return;
  cardContent.set(id, {
    ...cur,
    title: meta.title?.trim() ? meta.title.trim() : cur.title,
    description: meta.description || cur.description,
    image: meta.image || cur.image,
  });
  cardLayer.refresh(id);
  syncDocIdentity(id);
}

/** Propagate a card's shared identity (title + icon) to every placement of its document. */
function syncDocIdentity(id: string) {
  const src = cardContent.get(id);
  if (!src) return;
  for (const [cid, c] of cardContent) {
    if (cid === id || c.docId !== src.docId) continue;
    if (c.title !== src.title || c.icon !== src.icon || c.image !== src.image || c.description !== src.description) {
      cardContent.set(cid, { ...c, title: src.title, icon: src.icon, image: src.image, description: src.description });
      cardLayer.refresh(cid);
    }
  }
}

/** Entry ids to highlight on the minimap (loci / loose cards that hold another
 *  placement of the selected card's document), plus the placement count. */
function alsoInPlacements(): { ids: Set<string>; count: number } {
  const ids = new Set<string>();
  let count = 0;
  const sel = selectedCardId ? cardContent.get(selectedCardId) : undefined;
  if (sel) {
    for (const [cid, c] of cardContent) {
      if (cid === selectedCardId || c.docId !== sel.docId) continue;
      const e = loco.get(cid);
      ids.add(e?.locusId ?? cid);
      count++;
    }
  }
  return { ids, count };
}

// The locus the Delete button targets — ONLY when exactly one locus is open.
// With several open we can't know which the user means, so the button hides.
function currentOpenLocus(): string | null {
  let found: string | null = null;
  for (const e of loco.activeEntries()) {
    if (e.kind === "locus" && e.open) {
      if (found) return null; // more than one open → ambiguous
      found = e.id;
    }
  }
  return found;
}

// Delete a locus + its cards (confirmed by the caller). Fully undoable: we keep
// the live entries, their content, and a snapshot of connections to restore.
function deleteLocus(id: string) {
  const locusEntry = loco.get(id);
  if (!locusEntry) return;
  const cardEntries = loco.cardsOf(id);
  const contentSnap = new Map(cardEntries.map((c) => [c.id, cardContent.get(c.id)]));
  const connSnap = connectionLayer.export(); // connections to these cards prune on delete

  loco.remove(id);
  for (const c of cardEntries) {
    loco.remove(c.id);
    cardContent.delete(c.id);
  }
  focusedLocusId = null;
  updateToolbar();

  undo.push("delete locus", () => {
    loco.restore(locusEntry);
    for (const c of cardEntries) {
      loco.restore(c);
      const ct = contentSnap.get(c.id);
      if (ct) cardContent.set(c.id, ct);
    }
    connectionLayer.load(connSnap);
    focusedLocusId = locusEntry.open ? id : focusedLocusId;
    updateToolbar();
  });
}

// Paste a URL or text anywhere → a new card at the viewport center. Ignored
// while typing into a card (so paste-into-note still works normally).
document.addEventListener("paste", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target && target.isContentEditable) return;
  const text = ev.clipboardData?.getData("text");
  if (!text || !text.trim()) return;
  const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  addNoteCard(buildCardContent(text), center);
});

// Double-click empty space → a new blank note to type into.
canvas.addEventListener("dblclick", (ev) => {
  if (tool !== "move") return; // draw/lasso own their gestures; no stray notes
  const w = screenToWorld(ev.clientX, ev.clientY);
  if (locusAt(w)) return; // loci use single-click to open/close
  addNoteCard(blankNote(""), w);
});

// Cmd/Ctrl+Z → undo (ignored while typing in a card, where it undoes text).
document.addEventListener("keydown", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target && target.isContentEditable) return;
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    undo.undo();
  }
});

// ---------------------------------------------------------------------------
// Maps + persistence. The live state (loco + cardContent + connections) IS the
// active map; the other maps live serialized in `world`. Switching serializes
// the current map and loads the target. Everything autosaves to storage.
// ---------------------------------------------------------------------------
const storage = makeStorage();
let worldFile: WorldFile = { version: 1, maps: [], activeId: "" };

const emptyMap = (): MapState => ({ entries: [], content: {}, connections: [], strokes: [] });
// Accept either a filename (new) or an old "/loci/<name>" path (saved earlier).
const resolveImage = (src?: string) => {
  if (!src) return undefined;
  return locusImages.get(src) ?? locusImages.get(decodeURIComponent(src.split("/").pop() ?? ""));
};
const activeMap = () => worldFile.maps.find((m) => m.id === worldFile.activeId)!;

function serializeCurrent(): MapState {
  return { entries: loco.export(), content: Object.fromEntries(cardContent), connections: connectionLayer.export(), strokes: ink.export() };
}

function loadMapState(s: MapState) {
  loco.load(s.entries, resolveImage);
  cardContent.clear();
  urlIndex.clear();
  selectedCardId = null;
  for (const [k, v] of Object.entries(s.content)) {
    cardContent.set(k, v);
    // Rebuild the dedup index: first card seen for a normalized URL owns its docId.
    if (v.url) {
      const norm = normalizeUrl(v.url);
      if (!urlIndex.has(norm)) urlIndex.set(norm, v.docId);
    }
  }
  connectionLayer.load(s.connections);
  ink.load(s.strokes ?? []); // older saves predate ink → empty
  clearDrawingSelection();
  // Rebuild the id counters from the loaded entries.
  let maxCard = -1;
  let maxLocus = -1;
  for (const e of loco.export()) {
    const n = Number(e.id.split("-")[1]);
    if (e.kind === "locus") {
      if (Number.isFinite(n)) maxLocus = Math.max(maxLocus, n);
    } else if (e.id.startsWith("card-") && Number.isFinite(n)) {
      maxCard = Math.max(maxCard, n);
    }
  }
  cardCount = maxCard + 1;
  locusCount = maxLocus + 1;
  renderSidebar();
}

function switchMap(id: string) {
  if (id === worldFile.activeId) return;
  activeMap().state = serializeCurrent();
  worldFile.activeId = id;
  loadMapState(activeMap().state);
}

function newMap() {
  activeMap().state = serializeCurrent();
  const id = crypto.randomUUID();
  worldFile.maps.push({ id, name: `Map ${worldFile.maps.length + 1}`, state: emptyMap() });
  worldFile.activeId = id;
  loadMapState(emptyMap());
}

function deleteMap(id: string) {
  if (worldFile.maps.length <= 1) return; // always keep at least one
  const wasActive = id === worldFile.activeId;
  worldFile.maps = worldFile.maps.filter((m) => m.id !== id);
  if (wasActive) {
    worldFile.activeId = worldFile.maps[0].id;
    loadMapState(activeMap().state);
  } else {
    renderSidebar();
  }
}

// Inline rename: swap the name <span> for an <input> in place. Commit on Enter or
// blur, cancel on Escape; keystrokes are kept off the global canvas shortcuts.
function beginRename(m: { name: string }, nameEl: HTMLElement) {
  const input = document.createElement("input");
  input.value = m.name;
  Object.assign(input.style, {
    flex: "1 1 auto",
    minWidth: "0",
    font: "inherit",
    color: palette.ink,
    background: palette.paper,
    border: `1px solid ${palette.inkSoft}`,
    borderRadius: "4px",
    padding: "1px 4px",
  });
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim()) m.name = input.value.trim();
    renderSidebar();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (ev) => ev.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

async function save() {
  activeMap().state = serializeCurrent();
  await storage.save(worldFile);
  // GC orphan screenshot files: keep only thumbs still referenced by some card.
  if (window.locusAPI?.gcThumbs) {
    const used = new Set<string>();
    for (const m of worldFile.maps) {
      for (const c of Object.values(m.state.content)) {
        if (typeof c.image === "string" && c.image.startsWith("locus-thumb://")) {
          used.add(c.image.slice("locus-thumb://".length));
        }
      }
    }
    void window.locusAPI.gcThumbs([...used]);
  }
}

// ---------------------------------------------------------------------------
// Sidebar (collapsible): map list + minimap.
// ---------------------------------------------------------------------------
const SIDEBAR_W = 220;
const sidebar = document.createElement("div");
Object.assign(sidebar.style, {
  position: "fixed",
  top: "68px", //          sits clear below the 56px toolbar so nothing is clipped
  left: "0", //            anchored to the left edge (left side falls off the page)
  width: `${SIDEBAR_W}px`,
  background: palette.toolbar,
  borderTop: `1px solid ${palette.inkSoft}`,
  borderRight: `1px solid ${palette.inkSoft}`,
  borderBottom: `1px solid ${palette.inkSoft}`,
  borderTopRightRadius: "10px",
  borderBottomRightRadius: "10px",
  zIndex: "9",
  display: "flex",
  flexDirection: "column",
  font: "13px system-ui, sans-serif",
  color: palette.ink,
});
document.body.appendChild(sidebar);

// Header: "Maps" title + a circle to retract the panel upward.
const header = document.createElement("div");
Object.assign(header.style, { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px" });
const title = document.createElement("span");
title.textContent = "Maps";
Object.assign(title.style, { fontWeight: "600", fontSize: "14px", color: palette.ink });
const collapseBtn = document.createElement("button");
collapseBtn.title = "collapse / expand";
Object.assign(collapseBtn.style, {
  width: "22px",
  height: "22px",
  borderRadius: "50%",
  border: `1px solid ${palette.ink}`,
  background: palette.knob,
  cursor: "pointer",
  padding: "0",
  flex: "0 0 auto",
});
header.append(title, collapseBtn);
sidebar.appendChild(header);

// Collapsible content (slides up into the header when retracted).
const content = document.createElement("div");
Object.assign(content.style, { overflow: "hidden", transition: "max-height 0.18s ease", maxHeight: "80vh" });
sidebar.appendChild(content);

let collapsed = false;
collapseBtn.addEventListener("click", () => {
  collapsed = !collapsed;
  content.style.maxHeight = collapsed ? "0px" : "80vh";
});

const mapList = document.createElement("div");
Object.assign(mapList.style, { maxHeight: "40vh", overflowY: "auto", padding: "0 12px 10px" });
content.appendChild(mapList);

const newMapBtn = document.createElement("button");
newMapBtn.textContent = "+ New map";
Object.assign(newMapBtn.style, {
  margin: "0 12px 12px",
  width: "calc(100% - 24px)",
  padding: "8px",
  borderRadius: "6px",
  border: `1px solid ${palette.inkSoft}`,
  background: palette.accent,
  cursor: "pointer",
  font: "13px system-ui",
});
newMapBtn.addEventListener("click", () => newMap());
content.appendChild(newMapBtn);

const alsoInLabel = document.createElement("div");
Object.assign(alsoInLabel.style, { padding: "0 12px 6px", fontSize: "12px", color: palette.ink, minHeight: "16px" });
content.appendChild(alsoInLabel);

const minimap = document.createElement("canvas");
const MINI_W = SIDEBAR_W - 24;
const MINI_H = 140;
minimap.width = MINI_W * dpr();
minimap.height = MINI_H * dpr();
Object.assign(minimap.style, {
  width: `${MINI_W}px`,
  height: `${MINI_H}px`,
  margin: "0 12px 12px",
  border: `1px solid ${palette.inkSoft}`,
  borderRadius: "6px",
  background: palette.paper,
  cursor: "pointer",
  display: "block",
});
content.appendChild(minimap);
const miniCtx = minimap.getContext("2d")!;

function renderSidebar() {
  mapList.replaceChildren();
  for (const m of worldFile.maps) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "7px 8px",
      marginBottom: "4px",
      borderRadius: "6px",
      cursor: "pointer",
      background: m.id === worldFile.activeId ? palette.accent : "transparent",
      border: `1px solid ${m.id === worldFile.activeId ? palette.inkSoft : "transparent"}`,
    });
    const name = document.createElement("span");
    name.textContent = m.name;
    Object.assign(name.style, { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: m.id === worldFile.activeId ? "text" : "pointer" });
    if (m.id === worldFile.activeId) name.title = "click to rename";
    // Clicking the active map's name renames it inline; clicking another map's
    // name switches to it. Double-click always renames (even on a non-active map).
    name.addEventListener("click", (ev) => {
      if (m.id === worldFile.activeId) {
        ev.stopPropagation();
        beginRename(m, name);
      } else {
        switchMap(m.id);
      }
    });
    name.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      beginRename(m, name);
    });
    const del = document.createElement("button");
    del.textContent = "×";
    Object.assign(del.style, { border: "none", background: "none", cursor: "pointer", color: palette.hud, font: "15px system-ui" });
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteMap(m.id);
    });
    row.append(name, del);
    mapList.appendChild(row);
  }
}

// Minimap: fit all entities into the canvas; click to recenter the camera.
let miniTransform = { scale: 1, ox: 0, oy: 0 };
function drawMinimap() {
  const W = minimap.width;
  const H = minimap.height;
  miniCtx.setTransform(1, 0, 0, 1, 0, 0);
  miniCtx.clearRect(0, 0, W, H);

  const entries = loco.activeEntries(); // live refs (loci + active cards), no deep copy
  if (entries.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entries) {
    const r = e.kind === "locus" ? e.radius : 0;
    minX = Math.min(minX, e.position.x - r);
    minY = Math.min(minY, e.position.y - r);
    maxX = Math.max(maxX, e.position.x + r);
    maxY = Math.max(maxY, e.position.y + r);
  }
  const pad = 40;
  const scale = Math.min(W / (maxX - minX + pad * 2), H / (maxY - minY + pad * 2), 0.2 * dpr());
  const ox = (W - (maxX + minX) * scale) / 2;
  const oy = (H - (maxY + minY) * scale) / 2;
  miniTransform = { scale, ox, oy };
  const tx = (x: number) => x * scale + ox;
  const ty = (y: number) => y * scale + oy;

  const { ids: highlight, count } = alsoInPlacements();
  alsoInLabel.textContent = count > 0 ? `Also in ${count} other place${count > 1 ? "s" : ""}` : "";

  for (const e of entries) {
    const lit = highlight.has(e.id);
    miniCtx.fillStyle = e.color;
    if (e.kind === "locus") {
      const r = Math.max(2, e.radius * scale);
      miniCtx.beginPath();
      miniCtx.arc(tx(e.position.x), ty(e.position.y), r, 0, Math.PI * 2);
      miniCtx.fill();
      if (lit) {
        miniCtx.beginPath();
        miniCtx.arc(tx(e.position.x), ty(e.position.y), r + 3, 0, Math.PI * 2);
        miniCtx.strokeStyle = palette.knob;
        miniCtx.lineWidth = 2;
        miniCtx.stroke();
      }
    } else {
      miniCtx.fillRect(tx(e.position.x) - 2, ty(e.position.y) - 2, 4, 4);
      if (lit) {
        miniCtx.strokeStyle = palette.knob;
        miniCtx.lineWidth = 2;
        miniCtx.strokeRect(tx(e.position.x) - 4, ty(e.position.y) - 4, 8, 8);
      }
    }
  }

  // current viewport rectangle
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(window.innerWidth, window.innerHeight);
  miniCtx.strokeStyle = palette.hud;
  miniCtx.lineWidth = 1;
  miniCtx.strokeRect(tx(tl.x), ty(tl.y), (br.x - tl.x) * scale, (br.y - tl.y) * scale);
}

minimap.addEventListener("click", (ev) => {
  const rect = minimap.getBoundingClientRect();
  const mx = (ev.clientX - rect.left) * dpr();
  const my = (ev.clientY - rect.top) * dpr();
  // invert minimap transform → world point, then center the camera on it.
  const wx = (mx - miniTransform.ox) / miniTransform.scale;
  const wy = (my - miniTransform.oy) / miniTransform.scale;
  pan.x = -wx * zoom;
  pan.y = -wy * zoom;
});

// ---------------------------------------------------------------------------
// Boot: load saved world, or create a starter map.
// ---------------------------------------------------------------------------
async function init() {
  const saved = await storage.load();
  if (saved && saved.maps.length) {
    worldFile = saved;
    if (!worldFile.maps.find((m) => m.id === worldFile.activeId)) worldFile.activeId = worldFile.maps[0].id;
    loadMapState(activeMap().state);
  } else {
    const id = crypto.randomUUID();
    worldFile = { version: 1, maps: [{ id, name: "Map 1", state: emptyMap() }], activeId: id };
    loadMapState(emptyMap());
  }
  worldFile.stamps ??= [];
  renderStamps(); // graduated drawings are global → built once from the world file
  worldFile.hiddenPresets ??= [];
  for (const name of worldFile.hiddenPresets) presetTiles.get(name)?.remove(); // re-apply prior deletions
  renderSidebar();
  void refreshGoogleBtn(); // reflect existing Google session on startup
  setInterval(() => void save(), 2000); // autosave
  window.addEventListener("beforeunload", () => void save());
}
void init();

// ---------------------------------------------------------------------------
// Machine — the bottom-right tool/chat companion (see machine.ts). The user
// picks a tool, lassos WHERE it should act, and only then is a dialogue opened.
// The LLM call is stubbed for now (electron/main.cjs → machine:proposeReading).
// ---------------------------------------------------------------------------
function noMachine(_req: ChatRequest): ChatReply {
  // Reached only outside Electron (no main process). The real dialogue — and the
  // API-key check — live in electron/main.cjs → machine:chat.
  return { reply: "The Machine runs in the desktop app with an Anthropic API key configured.", suggestions: [], noKey: true };
}

const machine = new Machine({
  loco,
  content: cardContent,
  chat: (req) => (window.locusAPI?.machineChat ? window.locusAPI.machineChat(req) : Promise.resolve(noMachine(req))),
  onStatus: (cb) => window.locusAPI?.onMachineStatus?.(cb) ?? (() => {}),
  addReadingCard: (url, at) => addNoteCard(buildCardContent(url), at), // loose card near the lasso; fetches its own metadata
  onArmChange: (armed) => {
    canvas.style.cursor = armed ? "crosshair" : tool === "move" ? "" : "crosshair";
  },
});

// Esc disarms an armed Machine tool (the chat's ← Back button does too).
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && machine.isArmed()) machine.cancel();
});

// ---------------------------------------------------------------------------
// Render loop: step the physics, then draw.
// ---------------------------------------------------------------------------
function frame() {
  world.step();

  // clear in raw device pixels
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // camera transform: world origin at screen center, plus pan, scaled by zoom
  const originX = window.innerWidth / 2 + pan.x;
  const originY = window.innerHeight / 2 + pan.y;
  const s = dpr() * zoom;
  ctx.setTransform(s, 0, 0, s, dpr() * originX, dpr() * originY);
  world.render(ctx);
  ink.render(ctx); // freehand strokes, over the loci, in the same world space

  // The in-progress lasso outline (Phase 1: visual feedback only). Widths are
  // divided by zoom so the dashed line stays a constant thickness on screen.
  if (drag?.kind === "lasso" && drag.pts.length > 1) {
    ctx.save();
    ctx.strokeStyle = palette.knob;
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.moveTo(drag.pts[0].x, drag.pts[0].y);
    for (let i = 1; i < drag.pts.length; i++) ctx.lineTo(drag.pts[i].x, drag.pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  // A selected drawing: a dashed bounding box (its ⊙ menu is a DOM overlay).
  if (drawingSelection) {
    const sel = selectionStrokes();
    if (sel.length > 0) {
      const b = strokeBounds(sel);
      const pad = 8;
      ctx.save();
      ctx.strokeStyle = palette.knob;
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
      ctx.restore();
    }
  }

  // Mirror the same camera onto the DOM card layer + connection layer.
  cardLayer.setCamera(originX, originY, zoom);
  cardLayer.sync();
  connectionLayer.setCamera(originX, originY, zoom);
  connectionLayer.render();

  updateSelectionUI(); // float the ⊙ handle/menu at the lassoed drawing's corner
  drawMinimap();
  updateToolbar(); // keep Delete button in sync with the live open-locus state

  requestAnimationFrame(frame);
}
frame();
