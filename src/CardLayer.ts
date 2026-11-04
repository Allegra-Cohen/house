import { Locomancer } from "./Locomancer";
import type { CardContent } from "./cards";
import { openEmojiPicker } from "./emojiPicker";
import { palette } from "./palette";
import type { UndoStack } from "./undo";
import type { Vec2 } from "./types";

// ---------------------------------------------------------------------------
// CardLayer — renders cards as real DOM elements (so notes are editable in
// place, like info_board), layered over the loci canvas.
//
// Positions still come entirely from the Locomancer; this layer only mirrors
// them into the DOM each frame. A "stage" <div> carries the camera transform
// (pan/zoom), and each card sits at its world coordinates inside that stage.
// ---------------------------------------------------------------------------

const DRAG_THRESHOLD = 4; // screen px before a press on the header counts as a drag
const MIN_W = 140;
const MIN_H = 90;

type CardEl = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  note: HTMLDivElement;
  icon: HTMLSpanElement;
  preview: HTMLImageElement;
  previewWrap: HTMLDivElement;
  loading: HTMLDivElement;
  description: HTMLDivElement;
  last: { transform: string; border: string; shadow: string; loading: boolean; sel: boolean }; // skip no-op writes
};

export interface CardLayerOpts {
  undo: UndoStack;
  isHighlightMode: () => boolean;
  startConnection: (fromId: string, ev: PointerEvent) => void;
  onSelect: (id: string) => void; //        a card was pressed (show its "Also in…")
  onIdentityEdit: (id: string) => void; //   the shared title changed → sync the document
  isSelected: (id: string) => boolean; //    for the selection outline
  isConnectTarget: (id: string) => boolean; // card being hovered as a link target
  isLoading: (id: string) => boolean; //     a link preview is being fetched
  openLink: (url: string) => void; //        open a link card's URL (in-session)
  getSelection: () => Set<string>; //        ids of the lasso-selected card group
  clearSelection: () => void; //             drop that group selection
  isMultiSelected: (id: string) => boolean; // is this card in the lassoed group?
}

export class CardLayer {
  readonly stage: HTMLDivElement;
  private els = new Map<string, CardEl>();

  constructor(
    private loco: Locomancer,
    private content: Map<string, CardContent>,
    private screenToWorld: (sx: number, sy: number) => Vec2,
    private opts: CardLayerOpts,
  ) {
    injectStyles();
    this.stage = document.createElement("div");
    this.stage.className = "card-stage";
    document.body.appendChild(this.stage);
  }

  /** Set the camera transform on the stage (called once per frame by the harness). */
  setCamera(originX: number, originY: number, zoom: number) {
    this.stage.style.transform = `translate(${originX}px, ${originY}px) scale(${zoom})`;
  }

  /** The id of the card whose box contains a world point (for connection drops). */
  cardAt(w: Vec2): string | null {
    for (const e of this.loco.activeEntries()) {
      if (e.kind !== "card") continue;
      const hw = e.halfW ?? e.radius;
      const hh = e.halfH ?? e.radius;
      if (Math.abs(w.x - e.position.x) <= hw && Math.abs(w.y - e.position.y) <= hh) return e.id;
    }
    return null;
  }

  /** Reconcile DOM with the active cards each frame. */
  sync() {
    const active = new Set<string>();
    for (const e of this.loco.activeEntries()) {
      if (e.kind !== "card") continue;
      active.add(e.id);
      const el = this.els.get(e.id) ?? this.create(e.id);
      // Only write a style when it actually changed — a settled card costs nothing.
      const tf = `translate(${e.position.x}px, ${e.position.y}px) translate(-50%, -50%)`;
      if (el.last.transform !== tf) (el.root.style.transform = tf), (el.last.transform = tf);
      if (el.last.border !== e.color) (el.root.style.borderColor = e.color), (el.last.border = e.color);
      const selected = this.opts.isSelected(e.id) || this.opts.isMultiSelected(e.id);
      const shadow = this.opts.isConnectTarget(e.id)
        ? `0 0 0 3px #4a9d5b, 0 2px 8px rgba(0,0,0,0.12)` // green ring: link target
        : selected
          ? `0 0 0 3px ${palette.knob}, 0 2px 8px rgba(0,0,0,0.12)` // purple ring: selected / lassoed
          : "0 2px 8px rgba(0,0,0,0.12)";
      if (el.last.shadow !== shadow) (el.root.style.boxShadow = shadow), (el.last.shadow = shadow);
      if (el.last.sel !== selected) (el.root.classList.toggle("sel", selected), (el.last.sel = selected)); // show/hide resize handles
      const loading = this.opts.isLoading(e.id);
      if (el.last.loading !== loading) (el.loading.style.display = loading ? "" : "none"), (el.last.loading = loading);
    }
    for (const [id, el] of this.els) {
      if (!active.has(id)) {
        el.root.remove();
        this.els.delete(id);
      }
    }
  }

  private create(id: string): CardEl {
    const c = this.content.get(id);

    const root = document.createElement("div");
    root.className = "card";
    if (c?.w) root.style.width = `${c.w}px`;
    if (c?.h) root.style.height = `${c.h}px`;

    const header = document.createElement("div");
    header.className = "card-header";

    const icon = document.createElement("span");
    icon.className = "card-icon";
    icon.title = "change icon";
    icon.textContent = c?.icon ?? "📝";
    icon.addEventListener("pointerdown", (ev) => ev.stopPropagation()); // don't start a drag
    icon.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEmojiPicker(icon, (emoji) => {
        const cur = this.content.get(id);
        if (!cur) return;
        this.content.set(id, { ...cur, icon: emoji });
        icon.textContent = emoji;
        this.opts.onIdentityEdit(id); // icon is shared identity → sync other placements
      });
    });

    const title = document.createElement("div");
    title.className = "card-title";
    title.contentEditable = "true";
    title.textContent = c?.title ?? "";

    header.append(icon, title);

    // Link cards: a small "open" affordance that launches the URL.
    if (c?.url) {
      const open = document.createElement("a");
      open.className = "card-open";
      open.textContent = "↗";
      open.title = c.url;
      open.href = c.url;
      open.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      open.addEventListener("click", (ev) => {
        ev.preventDefault(); // open in-session (shared auth) instead of a bare new window
        ev.stopPropagation();
        const cur = this.content.get(id);
        if (cur?.url) this.opts.openLink(cur.url);
      });
      header.append(open);
    }

    const del = document.createElement("button");
    del.className = "card-del";
    del.textContent = "×";
    del.title = "delete";
    header.append(del);

    // Link preview thumbnail (page screenshot / og:image), shown when present.
    // Wrapped so a bottom-edge handle can resize (shrink/grow) the image height.
    const previewWrap = document.createElement("div");
    previewWrap.className = "card-preview-wrap";
    const preview = document.createElement("img");
    preview.className = "card-preview";
    preview.draggable = false;
    if (c?.image) {
      preview.src = c.image;
      preview.style.height = `${c.imageH ?? 140}px`;
    } else previewWrap.style.display = "none";
    preview.addEventListener("load", () => this.measure(id)); // image affects height
    const previewHandle = document.createElement("div");
    previewHandle.className = "card-preview-rz";
    previewHandle.title = "drag to resize thumbnail";
    previewWrap.append(preview, previewHandle);
    this.wirePreviewResize(id, preview, previewHandle);

    // "fetching preview…" strip while a link is loading.
    const loading = document.createElement("div");
    loading.className = "card-loading";
    loading.textContent = "fetching preview…";
    loading.style.display = "none";

    // Fetched page description ("thumbnail text"), shown for link cards.
    const description = document.createElement("div");
    description.className = "card-description";
    if (c?.description) description.textContent = c.description;
    else description.style.display = "none";

    const note = document.createElement("div");
    note.className = "card-note";
    note.contentEditable = "true";
    note.innerHTML = c?.note ?? ""; // note is stored as HTML (may contain <mark>)

    // Connection handle (right edge) — drag to another card to link them.
    const conn = document.createElement("div");
    conn.className = "card-conn";
    conn.title = "drag to connect";

    // Resize handles: 4 corners + 4 edges, shown only while the card is selected.
    const handles = (["nw", "ne", "sw", "se", "n", "s", "e", "w"] as const).map((dir) => {
      const h = document.createElement("div");
      h.className = `card-rz ${dir}`;
      this.wireResize(id, root, h, dir);
      return h;
    });

    root.append(header, loading, previewWrap, description, note, conn, ...handles);
    this.stage.appendChild(root);
    requestAnimationFrame(() => this.measure(id));

    // Pressing anywhere on the card selects it (to surface its "Also in…").
    root.addEventListener("pointerdown", () => this.opts.onSelect(id));

    // --- editing -----------------------------------------------------------
    title.addEventListener("blur", () => {
      const cur = this.content.get(id);
      if (cur) this.content.set(id, { ...cur, title: title.textContent ?? "" });
      this.opts.onIdentityEdit(id); // title is shared → sync other placements
      this.measure(id);
    });
    note.addEventListener("blur", () => this.saveNote(id, note));
    // Highlight: when highlight mode is on, finishing a selection marks it.
    note.addEventListener("mouseup", () => {
      if (!this.opts.isHighlightMode()) return;
      applyHighlight(note);
      this.saveNote(id, note);
    });

    del.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const entry = this.loco.get(id);
      const cont = this.content.get(id);
      this.loco.remove(id);
      this.content.delete(id);
      this.opts.undo.push("delete card", () => {
        if (entry) this.loco.restore(entry);
        if (cont) this.content.set(id, cont);
      });
    });

    conn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.opts.startConnection(id, ev);
    });

    this.wireDrag(id, header);

    const el: CardEl = { root, title, note, icon, preview, previewWrap, loading, description, last: { transform: "", border: "", shadow: "", loading: false, sel: false } };
    this.els.set(id, el);
    return el;
  }

  /** Re-sync a card's shown shared fields (title/icon) from content — used when a
   *  sibling placement edits the shared title. Leaves the (per-instance) note alone. */
  refresh(id: string) {
    const el = this.els.get(id);
    const c = this.content.get(id);
    if (!el || !c) return;
    el.icon.textContent = c.icon;
    if (document.activeElement !== el.title && el.title.textContent !== c.title) el.title.textContent = c.title;
    const img = c.image ?? "";
    if (el.preview.getAttribute("src") !== img) {
      if (img) {
        el.preview.src = img;
        el.preview.style.height = `${c.imageH ?? 140}px`;
        el.previewWrap.style.display = "";
      } else {
        el.preview.removeAttribute("src");
        el.previewWrap.style.display = "none";
      }
    }
    const desc = c.description ?? "";
    if (el.description.textContent !== desc) el.description.textContent = desc;
    el.description.style.display = desc ? "" : "none";
    this.measure(id); // title wrap / description can change the card's height
  }

  private saveNote(id: string, note: HTMLDivElement) {
    const cur = this.content.get(id);
    if (cur) this.content.set(id, { ...cur, note: note.innerHTML });
    this.measure(id);
  }

  /** Feed the card's real rendered size into the physics (cards grow with content). */
  private measure(id: string) {
    const el = this.els.get(id);
    const entry = this.loco.get(id);
    if (!el || !entry) return;
    entry.halfW = el.root.offsetWidth / 2;
    entry.halfH = el.root.offsetHeight / 2;
  }

  private wireDrag(id: string, handle: HTMLElement) {
    // Grabbing a card that's part of the lassoed group drags the WHOLE group;
    // otherwise just this card. Each mover keeps its own offset from the cursor,
    // so the group's relative layout is preserved, and the drop target is the
    // locus under the PRIMARY (grabbed) card — "drag them all into the boat".
    let group: string[] = [];
    const grabs = new Map<string, Vec2>();
    const snaps = new Map<string, ReturnType<Locomancer["snapshot"]>>();
    let start: Vec2 | null = null; // screen point of the press (null = no live press)
    let dragging = false; //         crossed the threshold → actually moving the card

    // Promote an armed press into a real drag: NOW we suppress text selection, grab
    // the pointer, and pin the group. Deferred to here (not pointerdown) so a press
    // that never moves stays a plain click — letting the title's contentEditable
    // take focus and be edited.
    const beginDrag = (ev: PointerEvent) => {
      dragging = true;
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      document.body.style.userSelect = "none";
      (document.activeElement as HTMLElement | null)?.blur?.(); // commit any in-place edit
      const w = this.screenToWorld(ev.clientX, ev.clientY);
      const sel = this.opts.getSelection();
      if (sel.has(id)) group = [...sel].filter((cid) => this.loco.get(cid)?.kind === "card");
      else {
        group = [id];
        this.opts.clearSelection(); // dragging a non-member starts fresh
      }
      grabs.clear();
      snaps.clear();
      for (const cid of group) {
        const c = this.loco.get(cid);
        if (!c) continue;
        grabs.set(cid, { x: c.position.x - w.x, y: c.position.y - w.y });
        snaps.set(cid, this.loco.snapshot(cid)); // for undo
        c.pinned = true;
      }
    };

    handle.addEventListener("pointerdown", (ev) => {
      // Only ARM a press here — don't preventDefault/capture/pin yet (that would
      // steal focus from the editable title). The drag begins in pointermove once
      // the pointer travels past DRAG_THRESHOLD.
      if (!this.loco.get(id)) return;
      ev.stopPropagation();
      start = { x: ev.clientX, y: ev.clientY };
      dragging = false;
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!start) return;
      // No button held but still pressed → a pointerup was lost. Finalize so the
      // card doesn't keep tracking the bare cursor.
      if (ev.buttons === 0) {
        end(ev);
        return;
      }
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) <= DRAG_THRESHOLD) return; // still a click
        beginDrag(ev);
      }
      const w = this.screenToWorld(ev.clientX, ev.clientY);
      for (const cid of group) {
        const c = this.loco.get(cid);
        const g = grabs.get(cid);
        if (!c || !g) continue;
        c.position.x = w.x + g.x;
        c.position.y = w.y + g.y;
      }
      // ⌘/Ctrl held = detaching → don't tease a catch-target.
      const detach = ev.metaKey || ev.ctrlKey;
      const primary = this.loco.get(id);
      const over = !detach && primary ? this.loco.locusAtPoint(primary.position) : null;
      this.loco.setHighlightedLocus(over && primary && over.id !== primary.locusId ? over.id : null);
    });

    const end = (ev: PointerEvent) => {
      if (!start) return;
      const didMove = dragging;
      const movers = group;
      start = null;
      dragging = false;
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      document.body.style.userSelect = "";
      this.loco.setHighlightedLocus(null);
      for (const cid of movers) {
        const c = this.loco.get(cid);
        if (c) c.pinned = false;
      }
      if (didMove) {
        // ⌘/Ctrl-drag DETACHES: the card(s) leave their locus and become homeless
        // wherever dropped (ignoring any locus underneath). A plain drag re-homes
        // onto the locus under the primary card, else moves within/in the world.
        const detach = ev.metaKey || ev.ctrlKey;
        const primary = this.loco.get(id);
        const target = !detach && primary ? this.loco.locusAtPoint(primary.position) : null;
        for (const cid of movers) {
          const c = this.loco.get(cid);
          if (!c) continue;
          if (detach) this.loco.detachCard(cid, c.position);
          else if (target && target.id !== c.locusId) this.loco.assignCard(cid, target.id, c.position);
          else this.loco.placeCard(cid, c.position);
        }
        const before = new Map(snaps); // capture for the undo closure
        const label = detach ? (movers.length > 1 ? "detach cards" : "detach card") : movers.length > 1 ? "move cards" : "move card";
        this.opts.undo.push(label, () => {
          for (const cid of movers) {
            const s = before.get(cid);
            if (s) this.loco.applySnapshot(cid, s);
          }
        });
        if (movers.length > 1) this.opts.clearSelection(); // a group move consumes the selection
      }
      group = [];
      grabs.clear();
      snaps.clear();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // Resize just the thumbnail height by dragging its bottom edge — lets you shrink
  // a large screenshot down to a thin band (or grow it). Persisted per-card.
  private wirePreviewResize(id: string, preview: HTMLImageElement, handle: HTMLElement) {
    let startH = 0;
    let sy = 0;
    let zoom = 1;

    handle.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      document.body.style.userSelect = "none";
      startH = preview.offsetHeight;
      sy = ev.clientY;
      const m = new DOMMatrixReadOnly(getComputedStyle(this.stage).transform);
      zoom = m.a || 1;
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!handle.hasPointerCapture(ev.pointerId)) return;
      if (ev.buttons === 0) {
        end(ev);
        return;
      } // lost pointerup → finalize
      const h = Math.max(20, startH + (ev.clientY - sy) / zoom);
      preview.style.height = `${h}px`;
      this.measure(id);
    });
    const end = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      document.body.style.userSelect = "";
      const cur = this.content.get(id);
      if (cur) this.content.set(id, { ...cur, imageH: preview.offsetHeight });
      this.measure(id);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // Resize from any of 8 handles (dir = combination of n/s/e/w). The card is
  // center-anchored, so to keep the OPPOSITE edge fixed (info_board behavior) we
  // shift the card's center by half the size change. The card is pinned while
  // dragging so the physics doesn't fight the moving center; on release placeCard
  // commits the new center as its home.
  private wireResize(id: string, root: HTMLDivElement, handle: HTMLElement, dir: string) {
    let startW = 0;
    let startH = 0;
    let sx = 0;
    let sy = 0;
    let cx = 0; // card center at grab
    let cy = 0;
    let zoom = 1;

    handle.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault(); // don't start a text selection while resizing
      const c = this.loco.get(id);
      if (!c) return;
      handle.setPointerCapture(ev.pointerId);
      document.body.style.userSelect = "none";
      startW = root.offsetWidth;
      startH = root.offsetHeight;
      sx = ev.clientX;
      sy = ev.clientY;
      cx = c.position.x;
      cy = c.position.y;
      // World units per screen pixel = 1/zoom; infer zoom from the stage scale.
      const m = new DOMMatrixReadOnly(getComputedStyle(this.stage).transform);
      zoom = m.a || 1;
      c.pinned = true;
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!handle.hasPointerCapture(ev.pointerId)) return;
      const c = this.loco.get(id);
      if (!c) return;
      if (ev.buttons === 0) {
        end(ev);
        return;
      } // lost pointerup → finalize
      const dx = (ev.clientX - sx) / zoom;
      const dy = (ev.clientY - sy) / zoom;
      let w = startW;
      let h = startH;
      let ncx = cx;
      let ncy = cy;
      if (dir.includes("e")) (w = Math.max(MIN_W, startW + dx)), (ncx = cx + (w - startW) / 2);
      if (dir.includes("w")) (w = Math.max(MIN_W, startW - dx)), (ncx = cx - (w - startW) / 2);
      if (dir.includes("s")) (h = Math.max(MIN_H, startH + dy)), (ncy = cy + (h - startH) / 2);
      if (dir.includes("n")) (h = Math.max(MIN_H, startH - dy)), (ncy = cy - (h - startH) / 2);
      root.style.width = `${w}px`;
      root.style.height = `${h}px`;
      c.position.x = ncx;
      c.position.y = ncy;
      this.measure(id);
    });
    const end = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      document.body.style.userSelect = "";
      const cur = this.content.get(id);
      if (cur) this.content.set(id, { ...cur, w: root.offsetWidth, h: root.offsetHeight });
      const c = this.loco.get(id);
      if (c) {
        this.loco.placeCard(id, c.position); // commit the shifted center as the home
        c.pinned = false;
      }
      this.measure(id);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
}

/** Wrap (or unwrap) the current text selection in <mark>, within `container`. */
function applyHighlight(container: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return;

  let parent: Node | null = range.commonAncestorContainer;
  if (parent.nodeType === Node.TEXT_NODE) parent = parent.parentElement;
  if (parent && (parent as HTMLElement).tagName === "MARK") {
    const mark = parent as HTMLElement; // unwrap an existing highlight
    const p = mark.parentNode!;
    while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
    p.removeChild(mark);
    p.normalize();
  } else {
    const frag = range.extractContents();
    const tmp = document.createElement("div");
    tmp.appendChild(frag);
    tmp.querySelectorAll("mark").forEach((m) => {
      const pp = m.parentNode!;
      while (m.firstChild) pp.insertBefore(m.firstChild, m);
      pp.removeChild(m);
    });
    tmp.normalize();
    const mark = document.createElement("mark");
    while (tmp.firstChild) mark.appendChild(tmp.firstChild);
    range.insertNode(mark);
    container.normalize();
  }
  sel.removeAllRanges();
}

// ---------------------------------------------------------------------------
// Styles (injected once). Sizes are in WORLD px; the stage's scale handles zoom.
// ---------------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById("card-layer-styles")) return;
  const s = document.createElement("style");
  s.id = "card-layer-styles";
  s.textContent = `
  .card-stage {
    position: fixed; left: 0; top: 0; width: 0; height: 0;
    transform-origin: 0 0; pointer-events: none; z-index: 5;
  }
  .card {
    position: absolute; left: 0; top: 0;
    width: 200px; min-height: 120px; box-sizing: border-box;
    background: #fff; border: 2px solid ${palette.inkSoft};
    border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    display: flex; flex-direction: column; overflow: hidden;
    pointer-events: auto; font-family: system-ui, sans-serif;
  }
  .card-header {
    display: flex; align-items: flex-start; gap: 6px;
    box-sizing: border-box; flex: 0 0 auto;
    padding: 6px 8px; cursor: grab; background: rgba(0,0,0,0.03);
    border-bottom: 1px solid ${palette.inkSoft};
  }
  .card-header:active { cursor: grabbing; }
  .card-icon { font-size: 16px; line-height: 1.3; flex: 0 0 auto; cursor: pointer; }
  .card-icon:hover { transform: scale(1.15); }
  /* Title WRAPS (like info_board) instead of truncating, so it's never cut off;
     the header grows to fit it. */
  .card-title {
    flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; color: ${palette.ink};
    outline: none; line-height: 1.3; white-space: pre-wrap; word-break: break-word;
  }
  .card-open {
    flex: 0 0 auto; text-decoration: none; color: ${palette.hud};
    font-size: 14px; line-height: 1; padding: 0 2px;
  }
  .card-open:hover { color: ${palette.ink}; }
  .card-del {
    flex: 0 0 auto; border: none; background: none; cursor: pointer;
    font-size: 16px; line-height: 1; color: ${palette.hud}; padding: 0 2px;
  }
  .card-del:hover { color: #c0392b; }
  .card-preview-wrap { position: relative; flex: 0 0 auto; }
  .card-preview {
    width: 100%; height: 140px; object-fit: cover; display: block;
    border-bottom: 1px solid ${palette.inkSoft};
  }
  /* Drag the bottom edge of the thumbnail to shrink / grow it. */
  .card-preview-rz {
    position: absolute; left: 0; right: 0; bottom: 0; height: 10px; cursor: ns-resize;
  }
  .card:hover .card-preview-rz { background: linear-gradient(to top, rgba(0,0,0,0.18), transparent); }
  .card-loading {
    flex: 0 0 auto; padding: 6px 8px; font-size: 11px; color: ${palette.hud};
    background: rgba(0,0,0,0.03); border-bottom: 1px solid ${palette.inkSoft};
  }
  /* Note styled like info_board: an inset, bordered beige box (not flush text). */
  /* Fetched page description ("thumbnail text"), clamped to a few lines. */
  .card-description {
    flex: 0 0 auto; margin: 8px 8px 0; font-size: 12px; color: ${palette.hud};
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .card-note {
    flex: 1 1 auto; margin: 8px; padding: 8px 10px;
    background: #f0eeeb; border: 1px solid #e5e2dd; border-radius: 6px;
    font-size: 12px; line-height: 1.5; color: ${palette.ink};
    outline: none; white-space: pre-wrap; word-break: break-word; overflow: auto;
    cursor: text;
  }
  .card-note:empty::before {
    content: "Add a note..."; color: #a0a0a0; pointer-events: none;
  }
  .card-note:focus { border-color: ${palette.knob}; }
  .card-note mark { background: #fef9c3; color: inherit; border-radius: 2px; }
  /* Resize handles (info_board style): 4 corners + 4 edges, shown only when the
     card is selected. Each anchors the opposite edge while dragging. */
  .card-rz {
    position: absolute; display: none; background: #fff; box-sizing: border-box;
    border: 2px solid ${palette.knob}; border-radius: 2px; z-index: 6;
  }
  .card.sel .card-rz { display: block; }
  .card-rz.nw, .card-rz.ne, .card-rz.sw, .card-rz.se { width: 10px; height: 10px; }
  .card-rz.n, .card-rz.s { width: 20px; height: 8px; left: 50%; transform: translateX(-50%); }
  .card-rz.e, .card-rz.w { width: 8px; height: 20px; top: 50%; transform: translateY(-50%); }
  .card-rz.nw { top: -5px; left: -5px; cursor: nwse-resize; }
  .card-rz.ne { top: -5px; right: -5px; cursor: nesw-resize; }
  .card-rz.sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
  .card-rz.se { bottom: -5px; right: -5px; cursor: nwse-resize; }
  .card-rz.n { top: -4px; cursor: ns-resize; }
  .card-rz.s { bottom: -4px; cursor: ns-resize; }
  .card-rz.e { right: -4px; cursor: ew-resize; }
  .card-rz.w { left: -4px; cursor: ew-resize; }
  .card-conn {
    /* centered on the card's right edge */
    position: absolute; right: -8px; top: 50%; transform: translateY(-50%);
    width: 16px; height: 16px; border-radius: 50%; box-sizing: border-box;
    background: ${palette.knob}; border: 1px solid ${palette.ink}; cursor: crosshair;
    opacity: 0; transition: opacity 0.1s; /* only on card hover */
  }
  .card:hover .card-conn { opacity: 1; }
  .card-conn:hover { transform: translateY(-50%) scale(1.15); }
  `;
  document.head.appendChild(s);
}
