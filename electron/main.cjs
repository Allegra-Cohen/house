// Electron main process. Creates the window and persists the world document to a
// JSON file in the app's userData dir.
const { app, BrowserWindow, ipcMain, protocol, net, session, shell } = require("electron");

const PARTITION = "persist:locus"; // one shared session for auth, fetch, and opening links
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const dataFile = () => path.join(app.getPath("userData"), "world.json");
const thumbsDir = () => path.join(app.getPath("userData"), "thumbs");

// Screenshots are saved as files and served via locus-thumb://<name>, so they are
// NOT inlined into world.json (which would bloat it). Must be registered before ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "locus-thumb", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#f6f4ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In dev, load the Vite server; in production, the built files.
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Real external links (http/https, not our own dev server) open in the OS
  // browser; everything else is denied so the board window is never replaced or
  // a stray app window spawned.
  const isExternal = (url) => /^https?:\/\//i.test(url) && !url.startsWith("http://localhost");
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url === win.webContents.getURL()) return;
    e.preventDefault();
    if (isExternal(url)) shell.openExternal(url);
  });
}

ipcMain.handle("world:load", async () => {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), "utf8"));
  } catch {
    return null; // no file yet, or unreadable
  }
});

ipcMain.handle("world:save", async (_e, world) => {
  fs.writeFileSync(dataFile(), JSON.stringify(world));
});

// ---------------------------------------------------------------------------
// Link metadata via a direct HTTP GET + HTML parse — the info_board approach.
// This is the RELIABLE base for title/description/image: a plain request with a
// desktop User-Agent gets the server-rendered <head> (og:/twitter:/citation_/
// <title>) for the vast majority of links, and — unlike loading the page in a
// hidden window — it can't be stalled or blocked into returning nothing. The
// hidden-window screenshot below is layered on top purely for the thumbnail.
// ---------------------------------------------------------------------------
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractMeta(html, property, attr = "property") {
  const patterns = [
    new RegExp(`<meta[^>]*${attr}=["']${property}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${property}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1].trim());
  }
  return "";
}

// A bot-protection / interstitial page (Cloudflare "Just a moment…", etc.) carries
// no real metadata — its <title> IS the interstitial's. Detected by title-level
// phrases plus high-confidence structural markers (the CF challenge script), kept
// tight so a real article that merely mentions "captcha" in its body isn't flagged.
const CHALLENGE_TITLE_SIGNS = [
  "just a moment", "checking your browser", "attention required", "access denied",
  "pardon our interruption", "one more step", "security check", "are you a robot",
  "verify you are human", "verifying you are human", "please verify you are a human",
  "you have been blocked", "client challenge",
];
const CHALLENGE_HTML_MARKERS = [
  "cdn-cgi/challenge-platform", "_cf_chl_opt", "cf-challenge", "cf_chl_",
  "enable javascript and cookies to continue", "ddos protection by cloudflare",
];
function looksLikeChallenge(title, html) {
  const t = (title || "").toLowerCase();
  if (CHALLENGE_TITLE_SIGNS.some((s) => t.includes(s))) return true;
  const h = (html || "").slice(0, 40000).toLowerCase();
  return CHALLENGE_HTML_MARKERS.some((s) => h.includes(s));
}

function parseHtmlMeta(html, baseUrl) {
  const result = { title: "", description: "", image: "" };
  try {
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const docTitle = titleTag ? decodeEntities(titleTag[1].trim()) : "";
    // A challenge page has no usable metadata — return nothing so the card keeps
    // its URL-derived name rather than showing "Just a moment…".
    if (looksLikeChallenge(docTitle, html)) return result;
    // Prefer Open Graph, then Twitter cards, then <title>, then academic meta.
    result.title =
      extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title") ||
      docTitle ||
      extractMeta(html, "citation_title", "name") ||
      extractMeta(html, "dc.title", "name") ||
      "";
    result.description =
      extractMeta(html, "og:description") ||
      extractMeta(html, "twitter:description") ||
      extractMeta(html, "description", "name") ||
      "";
    result.image = extractMeta(html, "og:image") || extractMeta(html, "twitter:image") || "";
    if (result.image && !/^https?:\/\//i.test(result.image)) {
      try {
        result.image = new URL(result.image, baseUrl).href;
      } catch {
        result.image = "";
      }
    }
    if (result.description.length > 300) result.description = result.description.slice(0, 297) + "...";
  } catch {}
  return result;
}

// Resolves to { title, description, image } — empty fields on any failure, never throws.
function fetchHtmlMeta(url) {
  return new Promise((resolve) => {
    const empty = { title: "", description: "", image: "" };
    let settled = false;
    let request;
    const finish = (m) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (request) request.abort();
      } catch {}
      resolve(m || empty);
    };
    const timer = setTimeout(() => finish(null), 8000);
    try {
      // Share the persistent session so a signed-in account's cookies carry through.
      request = net.request({ url, method: "GET", partition: PARTITION, useSessionCookies: true });
      request.setHeader(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );
      request.setHeader("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      request.on("response", (response) => {
        if (response.statusCode >= 400) return finish(null); // 403 challenge, 404, etc.
        let ct = response.headers["content-type"];
        if (Array.isArray(ct)) ct = ct[0] || "";
        ct = (ct || "").toLowerCase();
        if (!ct.includes("text/html") && !ct.includes("xml")) return finish(null);
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString();
          if (body.length > 50000) finish(parseHtmlMeta(body, url)); // the <head> is in the first chunks
        });
        response.on("end", () => finish(parseHtmlMeta(body, url)));
        response.on("error", () => finish(null));
      });
      request.on("error", () => finish(null));
      request.end();
    } catch {
      finish(null);
    }
  });
}

// ---------------------------------------------------------------------------
// DOI → Crossref. Academic publishers (Springer, SSRN, Nature, …) bot-wall the
// page itself (Imperva "Client Challenge", Cloudflare "Just a moment"), so the
// GET and the hidden window both come back empty. Crossref's REST API is the
// canonical, un-walled metadata source — keyed by the DOI, which is sitting right
// in the URL. This is what makes academic links resolve reliably regardless of
// session cookies or Electron/TLS version (the fragile thing info_board leaned on).
// ---------------------------------------------------------------------------
function extractDoi(url) {
  try {
    const u = new URL(url);
    // SSRN has no DOI in the path, but every abstract maps to a SSRN DOI.
    if (/(^|\.)ssrn\.com$/i.test(u.hostname)) {
      const id = u.searchParams.get("abstract_id") || (u.pathname.match(/(\d{4,})/) || [])[1];
      if (id) return "10.2139/ssrn." + id;
    }
    // Generic DOI sitting anywhere in the path/query (e.g. /article/10.1007/…).
    const m = decodeURIComponent(u.pathname + "?" + u.search).match(/10\.\d{4,9}\/[^\s?#&"']+/i);
    if (m) return m[0].replace(/[).,;]+$/, ""); // trim trailing punctuation
    return null;
  } catch {
    return null;
  }
}

// Resolves to { title, description } from Crossref, or null. Never throws.
function fetchCrossref(doi) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (m) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (request) request.abort();
      } catch {}
      resolve(m);
    };
    const timer = setTimeout(() => finish(null), 8000);
    try {
      request = net.request({ url: "https://api.crossref.org/works/" + encodeURIComponent(doi), method: "GET" });
      request.setHeader("User-Agent", "house-memory-palace/1.0 (link metadata)");
      request.setHeader("Accept", "application/json");
      request.on("response", (response) => {
        if (response.statusCode !== 200) return finish(null);
        let body = "";
        response.on("data", (c) => (body += c.toString()));
        response.on("end", () => {
          try {
            const m = JSON.parse(body).message || {};
            const strip = (s) => decodeEntities(String(s || "").replace(/<[^>]+>/g, "").trim());
            const title = strip((m.title || [])[0]);
            if (!title) return finish(null);
            const journal = strip((m["container-title"] || [])[0]);
            const authors = (m.author || [])
              .map((a) => [a.given, a.family].filter(Boolean).join(" "))
              .filter(Boolean);
            const year = ((((m.issued || {})["date-parts"] || [])[0] || [])[0]) || "";
            // Prefer the abstract (what info_board shows as the card's "thumbnail
            // text"); fall back to an authors · journal · year citation line.
            const abstract = strip(m.abstract).replace(/^abstract\s*/i, "").replace(/\s+/g, " ").trim();
            const bits = [];
            if (authors.length) bits.push(authors.slice(0, 5).join(", ") + (authors.length > 5 ? " et al." : ""));
            if (journal) bits.push(journal);
            if (year) bits.push(String(year));
            finish({ title, description: abstract || bits.join(" · ") });
          } catch {
            finish(null);
          }
        });
        response.on("error", () => finish(null));
      });
      request.on("error", () => finish(null));
      request.end();
    } catch {
      finish(null);
    }
  });
}

// Fetch a link's preview. Metadata (title/description/image) comes from the
// reliable info_board-style GET below; for DOI-bearing academic links that the
// GET can't reach (bot walls), Crossref supplies the title/description. A hidden
// window then adds a real page screenshot for the thumbnail (sharing the
// persistent session, so a signed-in Google account carries through to Drive
// links) and fills any metadata the GET missed (e.g. JS-rendered pages). A
// bot-challenge page is never screenshotted.
ipcMain.handle("link:fetch", async (_e, url) => {
  const meta = await fetchHtmlMeta(url); // reliable base — independent of the window below

  // DOI links the page-fetch couldn't title (walled/JS) → Crossref, the canonical source.
  const doi = extractDoi(url);
  const cross = doi && !meta.title ? await fetchCrossref(doi) : null;

  let shot = ""; // a real screenshot, or "" if it failed / the page was a challenge
  let win = { ogTitle: "", docTitle: "", description: "", ogImage: "", challenge: false };
  let w = null;
  try {
    w = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { partition: PARTITION, sandbox: true },
    });
    await Promise.race([
      w.loadURL(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
    ]);

    // Read the page's metadata + whether it's still showing a bot-challenge.
    const READ = `(() => {
      const g = (s, a) => { const el = document.querySelector(s); return el ? el.getAttribute(a) : null; };
      const docTitle = document.title || '';
      const body = (document.body && document.body.innerText || '').slice(0, 2000);
      const hay = (docTitle + ' ' + body).toLowerCase();
      const SIGNS = [
        'just a moment', 'checking your browser', 'verify you are human',
        'verifying you are human', 'are you a robot', 'attention required',
        'access denied', 'pardon our interruption', 'one more step',
        'security check', 'client challenge', 'ddos protection by cloudflare',
        'enable javascript and cookies to continue', 'please verify you are a human',
        'complete the security check', 'cf-challenge', 'captcha',
      ];
      return {
        ogTitle: g('meta[property="og:title"]','content') || '',
        docTitle,
        description: g('meta[property="og:description"]','content') || g('meta[name="description"]','content') || '',
        ogImage: g('meta[property="og:image"]','content') || '',
        challenge: SIGNS.some((s) => hay.includes(s)),
      };
    })()`;

    // Poll while a challenge is up: a Cloudflare "Just a moment" interstitial
    // auto-solves in a real Chromium in ~2s (and deposits its clearance cookie
    // into our persistent session for next time), after which og:description —
    // the abstract / first text, like info_board shows — becomes readable. Break
    // as soon as real content arrives, so un-walled pages stay fast. Imperva
    // "Client Challenge" never auto-solves, so we give up after the budget and
    // let Crossref backstop the title/description.
    const waits = [1200, 800, 800, 800, 900, 900]; // ~5.4s worst case
    for (let i = 0; i < waits.length; i++) {
      await new Promise((r) => setTimeout(r, waits[i]));
      try {
        win = await w.webContents.executeJavaScript(READ);
      } catch {}
      if (!win.challenge && (win.ogTitle || win.description || win.docTitle)) break;
    }

    if (!win.challenge) {
      try {
        const cap = await w.webContents.capturePage();
        const buf = cap.resize({ width: 480 }).toJPEG(70);
        const name = crypto.createHash("sha1").update(url).digest("hex") + ".jpg";
        fs.mkdirSync(thumbsDir(), { recursive: true });
        fs.writeFileSync(path.join(thumbsDir(), name), buf);
        shot = "locus-thumb://" + name; // a tiny reference, not the inline image
      } catch {}
    }
  } catch {
    // A failed/blocked window load must NOT lose the GET metadata above.
  } finally {
    if (w && !w.isDestroyed()) w.destroy();
  }

  // Merge. Title: GET → Crossref (cleanest for DOIs) → window. Description: the
  // page's own og:description (the abstract / first text, like info_board) wins,
  // then the window's, then Crossref (whose abstract backstops walled DOI links
  // like Springer; its authors·journal·year line is only a last resort). On a
  // challenge page docTitle is the interstitial's, so only use it when not flagged.
  const title = meta.title || (cross && cross.title) || win.ogTitle || (win.challenge ? "" : win.docTitle) || "";
  const description = meta.description || win.description || (cross && cross.description) || "";
  const image = shot || meta.image || win.ogImage || ""; // prefer a real screenshot
  return { title, description, image };
});

// ---------------------------------------------------------------------------
// Machine · "Propose reading" — a multi-turn Claude conversation grounded in the
// lassoed houses/cards, with live web search.
//
// req: { context: { houses:[{cards:[{title,note,url,description}]}], cards:[...] },
//        messages: [{role:"user"|"assistant", text}],  model? }   // last msg = new user turn
// returns: { reply, suggestions: [{title,url,why}], noKey? }
//
// No key → a short "add your API key" message (no stub). With a key, Claude
// searches the web and answers with prose + a JSON block of readings; the Add
// button only uses each `url` (it fetches title/abstract/thumbnail itself).
const MACHINE_MODELS = new Set(["claude-opus-4-8", "claude-sonnet-4-6"]);

let _anthropic = null;
function anthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (_anthropic) return _anthropic;
  const mod = require("@anthropic-ai/sdk"); // installed via package.json dependency
  const Anthropic = mod.default || mod;
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

// Render the lassoed selection as compact text for the system prompt.
function renderContext(ctx) {
  const lines = [];
  (ctx.houses || []).forEach((h, i) => {
    lines.push(`House ${i + 1} (${(h.cards || []).length} cards):`);
    for (const c of h.cards || []) lines.push(cardLine(c));
  });
  if ((ctx.cards || []).length) {
    lines.push(`Loose cards:`);
    for (const c of ctx.cards) lines.push(cardLine(c));
  }
  return lines.join("\n") || "(empty selection)";
}
function cardLine(c) {
  const bits = [`  • ${c.title || "(untitled)"}`];
  if (c.url) bits.push(`<${c.url}>`);
  const blurb = (c.description || c.note || "").replace(/\s+/g, " ").trim();
  if (blurb) bits.push(`— ${blurb.slice(0, 300)}`);
  return bits.join(" ");
}

// Pull the readings out of Claude's reply: a fenced ```json block holding
// { suggestions: [{title,url,why}] }. Returns { reply, suggestions }.
function parseReadings(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return { reply: text.trim(), suggestions: [] };
  let suggestions = [];
  try {
    const obj = JSON.parse(m[1]);
    const arr = Array.isArray(obj) ? obj : obj.suggestions || [];
    suggestions = arr
      .filter((s) => s && s.url && s.title)
      .map((s) => ({ title: String(s.title), url: String(s.url), why: String(s.why || "") }));
  } catch {}
  const reply = text.replace(m[0], "").trim() || "Here are some readings:";
  return { reply, suggestions };
}

const MACHINE_SYSTEM =
  "You are the Machine, a curation assistant inside a memory-palace app. The user has lassoed some 'houses' " +
  "(clusters of cards) and/or loose cards; their contents follow. Infer the shared focus of the selection, then " +
  "propose readings (papers, essays, articles) that genuinely bridge or extend those focuses. Use web search to find " +
  "real, current sources — never invent URLs. It's an iterative dialogue: the user will steer you (narrower, broader, " +
  "a specific angle, 'more like the 2nd one'); respond to their latest message.\n\n" +
  "Reply with 1–3 sentences of prose, THEN a fenced ```json block: " +
  '{"suggestions": [{"title": "...", "url": "...", "why": "one line on why it fits"}]}. ' +
  "Include 2–5 suggestions when proposing readings (omit the block only if the user is just chatting). " +
  "Every url must be a real link you found via search.";

ipcMain.handle("machine:chat", async (event, req) => {
  const sendStatus = (s) => {
    try {
      event.sender.send("machine:status", s);
    } catch {}
  };
  const client = anthropicClient();
  if (!client) {
    return {
      reply: "The Machine needs an Anthropic API key. Set ANTHROPIC_API_KEY in the environment and restart (see the README).",
      suggestions: [],
      noKey: true,
    };
  }

  const ctx = req?.context || { houses: [], cards: [] };
  const model = MACHINE_MODELS.has(req?.model) ? req.model : "claude-opus-4-8";
  const history = (req?.messages || []).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: m.text || "" }));

  // System: stable instruction + the (per-conversation) selection, cached so it
  // isn't re-billed at full price on every turn.
  const system = [
    { type: "text", text: MACHINE_SYSTEM },
    { type: "text", text: "SELECTION:\n" + renderContext(ctx), cache_control: { type: "ephemeral" } },
  ];
  // Cache the conversation prefix too: a breakpoint on the latest turn means the
  // next turn re-reads the prior history at ~0.1x instead of full price.
  const messages = history.map((m, i) => ({
    role: m.role,
    content: i === history.length - 1 ? [{ type: "text", text: m.text, cache_control: { type: "ephemeral" } }] : m.text,
  }));
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }];

  try {
    // STREAM (not create): web search + thinking can run a while with no bytes
    // flowing; streaming keeps the connection alive (avoids the non-streaming
    // stall that looks like a hang) and lets us report live status to the UI.
    sendStatus("Thinking");
    let convo = messages;
    let resp = null;
    for (let i = 0; i < 6; i++) {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system,
        tools,
        messages: convo,
      });
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          const t = ev.content_block && ev.content_block.type;
          if (t === "thinking") sendStatus("Thinking");
          else if (t === "server_tool_use" || t === "web_search_tool_result") sendStatus("Searching the web");
          else if (t === "text") sendStatus("Writing");
        }
      }
      resp = await stream.finalMessage();
      if (resp.stop_reason !== "pause_turn") break;
      convo = [...convo, { role: "assistant", content: resp.content }];
    }
    const text = (resp.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const { reply, suggestions } = parseReadings(text);
    console.log(`[machine] ${model} stop=${resp && resp.stop_reason} suggestions=${suggestions.length}`);
    return { reply: reply || "(no response)", suggestions };
  } catch (err) {
    console.error("[machine] error:", err && err.stack ? err.stack : err);
    return { reply: `Sorry — the request failed: ${err && err.message ? err.message : err}`, suggestions: [] };
  }
});

// Garbage-collect orphan thumbnails: delete any file in the thumbs dir whose name
// isn't in the still-referenced set the renderer sends.
ipcMain.handle("thumbs:gc", async (_e, names) => {
  try {
    const keep = new Set(names);
    for (const f of fs.readdirSync(thumbsDir())) {
      if (!keep.has(f)) fs.rmSync(path.join(thumbsDir(), f), { force: true });
    }
  } catch {}
});

// Open a Google sign-in window on the shared session so Drive links can be
// fetched/screenshotted while authenticated. Resolves when the window closes.
ipcMain.handle("auth:google", async () => {
  const win = new BrowserWindow({ width: 480, height: 660, title: "Sign in to Google", webPreferences: { partition: PARTITION } });
  try {
    await win.loadURL("https://accounts.google.com/");
  } catch {}
  return new Promise((resolve) => win.on("closed", () => resolve(true)));
});

// Are we signed into Google on the shared session? (presence of its auth cookies)
ipcMain.handle("auth:status", async () => {
  try {
    const cookies = await session.fromPartition(PARTITION).cookies.get({ domain: ".google.com" });
    return cookies.some((c) => /^SID$|^SAPISID$|^SSID$/.test(c.name));
  } catch {
    return false;
  }
});

// Open a link in the OS default browser (Safari), where the user's own browser
// session/auth applies. This is what clicking a card's ↗ uses.
ipcMain.handle("link:open", async (_e, url) => {
  try {
    await shell.openExternal(url);
  } catch {}
});

app.whenReady().then(() => {
  // Serve saved screenshots: locus-thumb://<name> → userData/thumbs/<name>
  protocol.handle("locus-thumb", (request) => {
    const name = path.basename(new URL(request.url).hostname || "");
    return net.fetch(pathToFileURL(path.join(thumbsDir(), name)).toString());
  });
  createWindow();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
