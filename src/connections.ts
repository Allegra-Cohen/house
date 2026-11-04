import { Locomancer } from "./Locomancer";
import { palette } from "./palette";
import type { UndoStack } from "./undo";
import type { Vec2 } from "./types";

// ---------------------------------------------------------------------------
// ConnectionLayer — curved lines between cards. An SVG overlay carries the same
// camera transform as the card layer, so lines track their cards as the world
// pans/zooms. Drag from a card's connection handle to another card to link them;
// click a line to delete it.
// ---------------------------------------------------------------------------
export type Connection = { id: string; from: string; to: string };

export class ConnectionLayer {
  private svg: SVGSVGElement;
  private stage: SVGGElement;
  private connections: Connection[] = [];
  private nextId = 0;
  private dragFrom: string | null = null;
  private dragTo: Vec2 | null = null;
  private hoverId: string | null = null; // card under the cursor while dragging
  private paths = new Map<string, SVGPathElement>(); // reused per connection (no per-frame churn)
  private dragPath: SVGPathElement | null = null; //   the one reused rubber-band path

  constructor(
    private loco: Locomancer,
    private undo: UndoStack,
    private screenToWorld: (sx: number, sy: number) => Vec2,
    private cardAt: (w: Vec2) => string | null,
    private onHover: (id: string | null) => void, // report the prospective target
  ) {
    const NS = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(NS, "svg");
    Object.assign(this.svg.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      overflow: "visible",
      pointerEvents: "none", // only the lines themselves are clickable
      zIndex: "4", // under the cards (5), over the canvas
    });
    this.stage = document.createElementNS(NS, "g");
    this.svg.appendChild(this.stage);
    document.body.appendChild(this.svg);
  }

  setCamera(originX: number, originY: number, zoom: number) {
    this.stage.setAttribute("transform", `translate(${originX} ${originY}) scale(${zoom})`);
  }

  /** Serialize / restore (for saving and switching maps). */
  export(): Connection[] {
    return this.connections.map((c) => ({ ...c }));
  }
  load(conns: Connection[]) {
    this.connections = conns.map((c) => ({ ...c }));
    this.nextId = conns.reduce((m, c) => Math.max(m, Number(c.id.split("-")[1]) + 1 || 0), 0);
  }

  /** Begin dragging a new connection out of a card's handle. */
  startDrag(fromId: string, ev: PointerEvent) {
    ev.stopPropagation();
    ev.preventDefault();
    this.dragFrom = fromId;
    this.dragTo = this.screenToWorld(ev.clientX, ev.clientY);
    document.body.style.userSelect = "none"; // don't text-select cards while dragging

    const move = (e: PointerEvent) => {
      // No button held → a pointerup was lost; end the connection drag cleanly.
      if (e.buttons === 0) {
        up();
        return;
      }
      this.dragTo = this.screenToWorld(e.clientX, e.clientY);
      const t = this.cardAt(this.dragTo);
      this.hoverId = t && t !== this.dragFrom ? t : null;
      this.onHover(this.hoverId);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      if (this.dragFrom && this.hoverId) this.add(this.dragFrom, this.hoverId);
      this.dragFrom = null;
      this.dragTo = null;
      this.hoverId = null;
      this.onHover(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private add(from: string, to: string) {
    // Avoid duplicates (either direction).
    if (this.connections.some((c) => (c.from === from && c.to === to) || (c.from === to && c.to === from))) return;
    const conn: Connection = { id: `conn-${this.nextId++}`, from, to };
    this.connections.push(conn);
    this.undo.push("connect", () => {
      this.connections = this.connections.filter((c) => c.id !== conn.id);
    });
  }

  private remove(id: string) {
    const conn = this.connections.find((c) => c.id === id);
    if (!conn) return;
    this.connections = this.connections.filter((c) => c.id !== id);
    this.undo.push("disconnect", () => this.connections.push(conn));
  }

  /** Drop connections whose endpoints no longer exist (e.g. deleted cards). */
  private prune() {
    this.connections = this.connections.filter((c) => this.loco.get(c.from) && this.loco.get(c.to));
  }

  /**
   * Where a connection endpoint should attach. An active card → the card center
   * (r = 0). A card tucked inside a CLOSED locus (inactive) → the locus center
   * with r = the locus radius, so the line is later clamped to the locus's edge
   * rather than its middle.
   */
  private endpoint(id: string): { x: number; y: number; r: number; retracted: boolean } | null {
    const e = this.loco.get(id);
    if (!e) return null;
    if (e.active) return { x: e.position.x, y: e.position.y, r: 0, retracted: false };
    if (e.locusId) {
      const locus = this.loco.get(e.locusId);
      if (locus) return { x: locus.position.x, y: locus.position.y, r: locus.radius, retracted: true };
    }
    return null;
  }

  /**
   * Redraw lines from the current card positions. Path elements are REUSED per
   * connection id (not recreated each frame), and attributes are only written
   * when they change — so a settled board does ~no DOM work.
   */
  render() {
    this.prune();
    const live = new Set<string>();

    for (const c of this.connections) {
      const ep = this.endpoint(c.from);
      const eq = this.endpoint(c.to);
      if (!ep || !eq) continue;
      const len = Math.hypot(eq.x - ep.x, eq.y - ep.y);
      if (len <= ep.r + eq.r + 1) continue; // endpoints overlap (e.g. same closed locus)
      const ux = (eq.x - ep.x) / len;
      const uy = (eq.y - ep.y) / len;
      const a = { x: ep.x + ux * ep.r, y: ep.y + uy * ep.r };
      const b = { x: eq.x - ux * eq.r, y: eq.y - uy * eq.r };
      const path = this.pathFor(c.id);
      setAttr(path, "d", curve(a, b));
      setAttr(path, "stroke", ep.retracted || eq.retracted ? palette.pathClosed : palette.ink);
      live.add(c.id);
    }

    // Drop path elements for connections that aren't currently drawn.
    for (const [id, path] of this.paths) {
      if (!live.has(id)) {
        path.remove();
        this.paths.delete(id);
      }
    }

    this.renderDrag();
  }

  /** Get (or lazily create) the reusable path element for a connection. */
  private pathFor(id: string): SVGPathElement {
    let path = this.paths.get(id);
    if (!path) {
      const NS = "http://www.w3.org/2000/svg";
      path = document.createElementNS(NS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.style.pointerEvents = "stroke";
      path.style.cursor = "pointer";
      path.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.remove(id);
      });
      this.stage.appendChild(path);
      this.paths.set(id, path);
    }
    return path;
  }

  /** The single reused rubber-band path while dragging a new connection. */
  private renderDrag() {
    const ep = this.dragFrom && this.dragTo ? this.endpoint(this.dragFrom) : null;
    if (!ep || !this.dragTo) {
      if (this.dragPath) this.dragPath.style.display = "none";
      return;
    }
    const tgt = this.hoverId ? this.endpoint(this.hoverId) : null;
    const ex = tgt ? tgt.x : this.dragTo.x;
    const ey = tgt ? tgt.y : this.dragTo.y;
    const len = Math.hypot(ex - ep.x, ey - ep.y) || 1;
    const ux = (ex - ep.x) / len;
    const uy = (ey - ep.y) / len;
    const a = { x: ep.x + ux * ep.r, y: ep.y + uy * ep.r };
    const b = tgt ? { x: ex - ux * tgt.r, y: ey - uy * tgt.r } : { x: ex, y: ey };
    if (!this.dragPath) {
      const NS = "http://www.w3.org/2000/svg";
      this.dragPath = document.createElementNS(NS, "path");
      this.dragPath.setAttribute("fill", "none");
      this.dragPath.setAttribute("stroke", palette.inkSoft);
      this.dragPath.setAttribute("stroke-width", "2");
      this.dragPath.setAttribute("stroke-dasharray", "6 6");
      this.stage.appendChild(this.dragPath);
    }
    this.dragPath.style.display = "";
    setAttr(this.dragPath, "d", curve(a, b));
  }
}

/** Write an attribute only when it actually changes (avoids needless SVG work). */
function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** A gentle cubic curve between two points (horizontal-ish control handles). */
function curve(a: Vec2, b: Vec2): string {
  const dx = Math.abs(b.x - a.x) * 0.4 + 20;
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
