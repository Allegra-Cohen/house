import type { Locomancer } from "./Locomancer";
import type { CardContent } from "./cards";
import { palette } from "./palette";
import type { ChatMessage, ChatReply, ChatRequest, MachineContext, ReadingItem } from "./storage";
import type { SpatialEntry, Vec2 } from "./types";

// ---------------------------------------------------------------------------
// Machine — a bottom-right companion to the Maps sidebar. Instead of an
// all-knowing oracle, the user picks a TOOL (what help), then a LASSO (where),
// and a DIALOGUE opens. One tool is wired: "Propose reading".
//
// The dialogue is an iterative back-and-forth: a lasso grounds the conversation
// in some houses/cards, the assistant proposes readings, and the user steers it
// ("narrower", "empirical only", "more like the 2nd") for more. Every assistant
// turn's readings have an Add button that drops a real card near the lasso. You
// can re-lasso any time to add context. Back (or Esc) ends the session.
// ---------------------------------------------------------------------------

export interface MachineDeps {
  loco: Locomancer;
  content: Map<string, CardContent>;
  /** One turn of the (stubbed) dialogue: context + history in, reply + readings out. */
  chat: (req: ChatRequest) => Promise<ChatReply>;
  /** Turn a suggested reading's URL into a real card placed at `at` (fetches its own metadata). */
  addReadingCard: (url: string, at: Vec2) => void;
  /** Subscribe to live turn status ("Thinking" / "Searching the web" / "Writing"). Returns an unsubscribe fn. */
  onStatus?: (cb: (status: string) => void) => () => void;
  /** Notify the host so it can show a lasso cursor while a tool is armed. */
  onArmChange?: (armed: boolean) => void;
}

type Tool = { id: string; label: string; desc: string };
const TOOLS: Tool[] = [
  { id: "propose-reading", label: "Propose reading", desc: "Lasso houses or cards → a dialogue of readings that bridge them" },
];

// The chosen model rides along on every chat request (resolved/validated in main.cjs).
const MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8 (best)" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 (cheaper)" },
];

const stripHtml = (html?: string) => (html ? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");

export class Machine {
  private armedTool: Tool | null = null;
  private context: MachineContext = { houses: [], cards: [] };
  private messages: ChatMessage[] = [];
  private model = MODELS[0].id; // default Opus 4.8; user can switch in the tools view
  private busy = false;
  private addCount = 0; // staggers Added cards so they don't stack exactly
  private lastAt: Vec2 = { x: 0, y: 0 };

  private panel: HTMLDivElement;
  private content_: HTMLDivElement; // collapsible body
  private toolsView: HTMLDivElement;
  private chatView: HTMLDivElement;
  private transcript: HTMLDivElement;
  private input: HTMLInputElement;
  private collapsed = false;

  constructor(private deps: MachineDeps) {
    this.panel = el("div", {
      position: "fixed", right: "16px", bottom: "16px", width: "300px",
      background: palette.toolbar, border: `1px solid ${palette.inkSoft}`, borderRadius: "10px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.18)", zIndex: "9",
      display: "flex", flexDirection: "column", font: "13px system-ui, sans-serif", color: palette.ink, overflow: "hidden",
    });

    // Collapsible body sits ABOVE the header (the panel grows upward from the corner).
    this.content_ = el("div", { overflow: "hidden", transition: "max-height 0.18s ease", maxHeight: "65vh", display: "flex", flexDirection: "column" });
    this.toolsView = el("div", { padding: "10px 12px" });
    this.chatView = el("div", { display: "none", flexDirection: "column", minHeight: "0" });
    this.transcript = el("div", { padding: "10px 12px", overflowY: "auto", maxHeight: "44vh", minHeight: "120px" });
    this.input = el("input", { flex: "1 1 auto", minWidth: "0", border: `1px solid ${palette.inkSoft}`, borderRadius: "6px", padding: "6px 8px", font: "12px system-ui", color: palette.ink, background: palette.paper, outline: "none" });

    this.buildTools();
    this.buildChat();
    this.content_.append(this.toolsView, this.chatView);

    // Header (bottom, the corner anchor): "Machine" + collapse circle.
    const header = el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderTop: `1px solid ${palette.inkSoft}` });
    const title = el("span", { fontWeight: "600", fontSize: "14px", color: palette.ink });
    title.textContent = "Machine";
    const collapseBtn = el("button", { width: "22px", height: "22px", borderRadius: "50%", border: `1px solid ${palette.ink}`, background: palette.knob, cursor: "pointer", padding: "0", flex: "0 0 auto" });
    collapseBtn.title = "collapse / expand";
    collapseBtn.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.content_.style.maxHeight = this.collapsed ? "0px" : "65vh";
    });
    header.append(title, collapseBtn);

    this.panel.append(this.content_, header);
    document.body.appendChild(this.panel);
  }

  // --- public surface used by the host (main.ts) ---------------------------

  isArmed(): boolean {
    return this.armedTool !== null;
  }

  /** Disarm (e.g. on Esc) and return to the tools list. */
  cancel(): void {
    if (this.armedTool) this.disarm();
  }

  /** Called by the host when a lasso completes while a tool is armed. A lasso
   *  grounds (or extends) the conversation's context, then asks for readings. */
  handleLasso(sel: { loci: SpatialEntry[]; cards: SpatialEntry[] }, at: Vec2): void {
    if (!this.armedTool) return;
    this.lastAt = at;
    this.addCount = 0;

    const added = this.buildContext(sel);
    const total = added.houses.reduce((n, h) => n + h.cards.length, 0) + added.cards.length;
    if (total === 0) {
      this.appendNote("Nothing with cards in that lasso — enclose a house or a card and try again.");
      return;
    }
    // Merge into the running context so follow-ups still see earlier selections.
    this.context.houses.push(...added.houses);
    this.context.cards.push(...added.cards);

    const label = describe(added);
    const first = this.messages.length === 0;
    this.send(first ? `Propose readings that bridge my selection (${label}).` : `I've added more to look at (${label}). Consider it too.`);
  }

  // --- views ---------------------------------------------------------------

  private buildTools() {
    const intro = el("div", { fontSize: "12px", color: palette.hud, marginBottom: "8px" });
    intro.textContent = "Pick a tool, then lasso where you want help.";
    this.toolsView.append(intro);
    for (const t of TOOLS) {
      const row = el("button", { display: "block", width: "100%", textAlign: "left", cursor: "pointer", padding: "8px 10px", marginBottom: "6px", borderRadius: "6px", border: `1px solid ${palette.inkSoft}`, background: palette.accent, font: "13px system-ui", color: palette.ink });
      row.innerHTML = `<div style="font-weight:600">${t.label}</div><div style="font-size:11px;color:${palette.hud};margin-top:2px">${t.desc}</div>`;
      row.addEventListener("click", () => this.arm(t));
      this.toolsView.append(row);
    }

    // Model picker (applies to every tool's dialogue).
    const modelRow = el("label", { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", fontSize: "12px", color: palette.hud });
    modelRow.append(document.createTextNode("Model:"));
    const select = document.createElement("select");
    Object.assign(select.style, { flex: "1 1 auto", font: "12px system-ui", padding: "3px 4px", borderRadius: "6px", border: `1px solid ${palette.inkSoft}`, background: palette.paper, color: palette.ink });
    for (const m of MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      select.append(opt);
    }
    select.value = this.model;
    select.addEventListener("change", () => (this.model = select.value));
    modelRow.append(select);
    this.toolsView.append(modelRow);
  }

  private buildChat() {
    const bar = el("div", { display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", borderBottom: `1px solid ${palette.inkSoft}`, flex: "0 0 auto" });
    const back = el("button", { cursor: "pointer", border: `1px solid ${palette.inkSoft}`, background: palette.accent, borderRadius: "6px", padding: "3px 8px", font: "12px system-ui", color: palette.ink });
    back.textContent = "← Back";
    back.addEventListener("click", () => this.disarm());
    const heading = el("span", { fontWeight: "600", fontSize: "13px" });
    heading.textContent = "Propose reading";
    bar.append(back, heading);

    const inputRow = el("form", { display: "flex", gap: "6px", padding: "8px 12px", borderTop: `1px solid ${palette.inkSoft}`, flex: "0 0 auto" });
    this.input.placeholder = "Ask: narrower, empirical only, more like #2…";
    const send = el("button", { flex: "0 0 auto", cursor: "pointer", border: `1px solid ${palette.inkSoft}`, background: palette.knob, color: "#fff", borderRadius: "6px", padding: "6px 10px", font: "12px system-ui" });
    send.type = "submit";
    send.textContent = "Send";
    inputRow.append(this.input, send);
    inputRow.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      this.send(text);
    });
    // Keystrokes stay out of the canvas's global shortcuts.
    this.input.addEventListener("keydown", (ev) => ev.stopPropagation());

    this.chatView.append(bar, this.transcript, inputRow);
  }

  private arm(t: Tool) {
    this.armedTool = t;
    this.context = { houses: [], cards: [] };
    this.messages = [];
    this.transcript.replaceChildren();
    this.appendNote("Draw a lasso around the houses or cards you want readings for — or just ask below.");
    this.toolsView.style.display = "none";
    this.chatView.style.display = "flex";
    this.collapsed = false;
    this.content_.style.maxHeight = "65vh";
    this.deps.onArmChange?.(true);
  }

  private disarm() {
    this.armedTool = null;
    this.chatView.style.display = "none";
    this.toolsView.style.display = "block";
    this.deps.onArmChange?.(false);
  }

  // --- dialogue ------------------------------------------------------------

  private send(text: string) {
    if (this.busy) return;
    this.busy = true;
    this.appendUser(text);
    this.messages.push({ role: "user", text });

    // Animated, status-driven indicator so a long thinking/searching turn never
    // looks frozen. Live phases stream in via onStatus; dots animate between them.
    const pending = this.appendAssistant("Thinking");
    let label = "Thinking";
    let dots = 1;
    const tick = () => {
      pending.textContent = label + ".".repeat(dots);
      dots = (dots % 3) + 1;
    };
    tick();
    const timer = window.setInterval(tick, 400);
    const unsub = this.deps.onStatus?.((s) => {
      label = s;
      dots = 1;
      tick();
    });
    const stop = () => {
      window.clearInterval(timer);
      unsub?.();
    };

    this.deps
      .chat({ context: this.context, messages: this.messages, model: this.model })
      .then((res) => {
        stop();
        this.messages.push({ role: "assistant", text: res.reply });
        this.renderReply(pending, res);
      })
      .catch(() => {
        stop();
        pending.textContent = "Sorry — that turn failed. Try again.";
      })
      .finally(() => (this.busy = false));
  }

  // --- transcript helpers --------------------------------------------------

  private appendUser(text: string) {
    const row = el("div", { margin: "0 0 8px", padding: "6px 8px", borderRadius: "6px", background: palette.accent, fontSize: "12px", alignSelf: "flex-end" });
    row.textContent = text;
    this.transcript.append(row);
    this.scroll();
  }

  private appendAssistant(text: string): HTMLDivElement {
    const row = el("div", { margin: "0 0 6px", fontSize: "12px", color: palette.ink, lineHeight: "1.45" });
    row.textContent = text;
    this.transcript.append(row);
    this.scroll();
    return row;
  }

  private appendNote(text: string) {
    const row = el("div", { margin: "0 0 8px", fontSize: "12px", color: palette.hud, fontStyle: "italic" });
    row.textContent = text;
    this.transcript.append(row);
    this.scroll();
  }

  private renderReply(pending: HTMLDivElement, res: ChatReply) {
    pending.textContent = res.reply || "Here are some readings:";
    for (const s of res.suggestions || []) {
      const card = el("div", { margin: "6px 0 10px", padding: "8px 10px", borderRadius: "8px", border: `1px solid ${palette.inkSoft}`, background: palette.paper });
      const top = el("div", { display: "flex", alignItems: "flex-start", gap: "6px" });
      const link = document.createElement("a");
      link.textContent = s.title;
      link.href = s.url;
      Object.assign(link.style, { flex: "1 1 auto", fontWeight: "600", fontSize: "12px", color: palette.ink, textDecoration: "none", wordBreak: "break-word" });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (window.locusAPI?.openLink) void window.locusAPI.openLink(s.url);
      });
      const add = el("button", { flex: "0 0 auto", cursor: "pointer", border: `1px solid ${palette.inkSoft}`, background: palette.knob, color: "#fff", borderRadius: "6px", padding: "2px 8px", font: "12px system-ui" });
      add.textContent = "Add";
      add.addEventListener("click", () => {
        const at = { x: this.lastAt.x + this.addCount * 22, y: this.lastAt.y + this.addCount * 22 };
        this.addCount++;
        this.deps.addReadingCard(s.url, at);
        add.textContent = "Added ✓";
        add.disabled = true;
        add.style.opacity = "0.6";
        add.style.cursor = "default";
      });
      top.append(link, add);
      const why = el("div", { fontSize: "11px", color: palette.hud, marginTop: "4px", lineHeight: "1.4" });
      why.textContent = s.why;
      card.append(top, why);
      this.transcript.append(card);
    }
    this.scroll();
  }

  private scroll() {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  // --- context gathering ---------------------------------------------------

  private itemOf(c?: CardContent): ReadingItem | null {
    if (!c) return null;
    const item: ReadingItem = { title: c.title || "(untitled)" };
    const note = stripHtml(c.note);
    if (note) item.note = note;
    if (c.url) item.url = c.url;
    if (c.description) item.description = c.description;
    return item;
  }

  /** Build a context fragment from one lasso: enclosed houses (with cards) + loose cards. */
  private buildContext(sel: { loci: SpatialEntry[]; cards: SpatialEntry[] }): MachineContext {
    const houseCardIds = new Set<string>();
    const houses = sel.loci.map((l) => {
      const cards: ReadingItem[] = [];
      for (const e of this.deps.loco.cardsOf(l.id)) {
        houseCardIds.add(e.id);
        const it = this.itemOf(this.deps.content.get(e.id));
        if (it) cards.push(it);
      }
      return { cards };
    });
    const cards: ReadingItem[] = [];
    for (const e of sel.cards) {
      if (houseCardIds.has(e.id)) continue; // already counted under its house
      const it = this.itemOf(this.deps.content.get(e.id));
      if (it) cards.push(it);
    }
    return { houses, cards };
  }
}

/** Small DOM helper: a styled element. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
}

/** Human label for a lassoed fragment, e.g. "2 houses · 1 card". */
function describe(p: MachineContext): string {
  const houseCards = p.houses.reduce((n, h) => n + h.cards.length, 0);
  const parts: string[] = [];
  if (p.houses.length) parts.push(`${p.houses.length} house${p.houses.length === 1 ? "" : "s"}, ${houseCards} card${houseCards === 1 ? "" : "s"}`);
  if (p.cards.length) parts.push(`${p.cards.length} loose card${p.cards.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "nothing";
}
