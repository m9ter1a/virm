// virm inbox. No framework, no build step.
// Text from Reddit is untrusted: it only ever reaches the page through h(),
// which sets textContent and attributes, never HTML. A test fails the build if
// any HTML sink shows up in this file.

const GROUPS = ["urgent", "worth", "fyi", "noise"];
const TABS = [...GROUPS, "pending"];
const LABEL = { urgent: "Urgent", worth: "Worth a look", fyi: "FYI", noise: "Noise", pending: "Waiting" };
const SHORT = { urgent: "Urgent", worth: "Worth", fyi: "FYI", noise: "Noise" };
const TEMPLATE = { help: "Help people", news: "Follow news", mentions: "Mentions", competitors: "Competitors", custom: "Custom" };
const PAGE = 60;
const POLL_MS = 15000;

const $ = (id) => document.getElementById(id);

const S = {
  tab: "urgent",
  view: "open",
  tracker: "",
  q: "",
  items: [],
  more: false,
  sel: null,
  state: null,
  known: null,
  undo: [],
  busy: false,
  pin: null,
  pendingMove: null,
  page: "inbox",
  loadToken: 0,
  offline: false,
};

// ---------------------------------------------------------------- helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children. Unlike replaceChildren, skips null instead of printing "null". */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

const saved = {
  get(k) {
    try {
      return localStorage.getItem(`virm:${k}`);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`virm:${k}`, v);
    } catch {}
  },
};

async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}
function until(t) {
  const m = Math.max(1, Math.round((t - Date.now()) / 60000));
  return m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
}
const absTime = (t) => new Date(t).toLocaleString();
const fmt = (p) => (typeof p === "number" ? p.toFixed(2) : "–");
const isOpen = (item) => item.status === "new" || item.status === "backfill";
const current = () => S.items.find((i) => i.id === S.sel) ?? null;
const indexOfSel = () => S.items.findIndex((i) => i.id === S.sel);

/** The verdict that put the item in its group: the one whose group is the item's code group. */
function topVerdict(item) {
  return item.verdicts.find((v) => v.group === item.codeGroup) ?? item.verdicts[0] ?? null;
}

function belongs(item) {
  if (S.view === "open" && !isOpen(item)) return false;
  if (S.view === "done" && isOpen(item)) return false;
  if (S.tab === "pending") return item.group === null;
  return item.group === S.tab;
}

let toastTimer = 0;
function toast(text, undoable = false, ms = 3200) {
  const el = $("toast");
  fill(
    el,
    h("span", {}, text),
    undoable
      ? h(
          "button",
          {
            class: "toast-undo",
            type: "button",
            onclick: () => {
              el.hidden = true;
              if (typeof undoable === "function") undoable();
              else undo();
            },
          },
          "Undo",
          // U undoes the last post action; other undos are the button only.
          undoable === true ? h("kbd", {}, "U") : null,
        )
      : null,
  );
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------- state & header

async function refreshState() {
  try {
    S.state = await api("/api/state");
    setOffline(false);
  } catch {
    setOffline(true);
    return false;
  }
  renderTabs();
  renderTrackers();
  renderStatus();
  renderBanner();
  return true;
}

function setOffline(off) {
  if (S.offline === off) return;
  S.offline = off;
  renderBanner();
}

function renderTabs() {
  const c = S.state.counts;
  for (const btn of document.querySelectorAll(".tab")) {
    const g = btn.dataset.group;
    btn.classList.add(`g-${g}`);
    btn.setAttribute("aria-selected", String(g === S.tab));
    const count = btn.querySelector(".count");
    count.textContent = c[g] ? String(c[g]) : "";
    count.classList.toggle("hot", g === "urgent" && c.urgent > 0);
    if (g === "pending") btn.hidden = !c.pending && S.tab !== "pending";
  }
  document.title = c.urgent ? `(${c.urgent}) virm` : "virm";
}

function renderTrackers() {
  const sel = $("tracker");
  const names = S.state.trackers.map((t) => t.name);
  const have = [...sel.options].slice(1).map((o) => o.value);
  if (names.join("\n") !== have.join("\n")) {
    fill(sel, 
      h("option", { value: "" }, "All trackers"),
      ...S.state.trackers.map((t) => h("option", { value: t.name }, t.paused ? `${t.name} (paused)` : t.name)),
    );
  }
  if (S.tracker && !names.includes(S.tracker)) S.tracker = "";
  sel.value = S.tracker;
}

function renderStatus() {
  const st = S.state;
  const poll = $("status-poll");
  if (st.polling) {
    const last = st.feeds.lastFetch ? `last fetch ${ago(st.feeds.lastFetch)}` : "first fetch within a minute";
    fill(poll, 
      h("span", { class: "live" }),
      `Collecting · ${st.feeds.total} feeds · ${last}`,
      st.feeds.failing ? h("span", { class: "warn" }, ` · ${st.feeds.failing} failing`) : null,
    );
    poll.title = "virm polls one Reddit feed per minute";
  } else {
    fill(poll, h("span", { class: "off" }), "Not collecting: inbox only. Run “virm start” to collect.");
  }
  const model = $("status-model");
  const d = st.decider;
  if (d.state === "ok") model.textContent = `d1 · ${st.model.calls} classified · ${st.model.errors} errors`;
  else if (d.state === "missing") fill(model, h("span", { class: "warn" }, "d1 off: no API key"));
  else fill(model, h("span", { class: "warn" }, "d1 unavailable"));
}

function renderBanner() {
  const b = $("banner");
  b.classList.remove("error");
  if (S.offline) {
    b.classList.add("error");
    fill(b, h("strong", {}, "Lost connection to virm."), " Is it still running? This page reconnects on its own.");
    b.hidden = false;
    return;
  }
  const d = S.state?.decider;
  if (d && d.state !== "ok") {
    fill(b, 
      h("strong", {}, d.state === "missing" ? "Classification is off." : "The decision model is unavailable."),
      " ",
      d.message ?? "",
      " Posts are still collected and wait in “Waiting”.",
    );
    b.hidden = false;
    return;
  }
  b.hidden = true;
}

// ---------------------------------------------------------------- list

async function loadList({ keep = false } = {}) {
  const params = new URLSearchParams({ group: S.tab, view: S.view, limit: String(PAGE) });
  if (S.tracker) params.set("tracker", S.tracker);
  if (S.q) params.set("q", S.q);
  const token = ++S.loadToken;
  let res;
  try {
    res = await api(`/api/items?${params}`);
  } catch (err) {
    toast(`Could not load posts: ${err.message}`);
    return;
  }
  if (token !== S.loadToken) return;
  S.items = res.items;
  S.more = res.more;
  if (S.pin) {
    if (belongs(S.pin) && !S.items.some((i) => i.id === S.pin.id)) S.items.unshift(S.pin);
    keep = true;
    S.sel = S.pin.id;
    S.pin = null;
  }
  S.known = S.state ? { ...S.state.counts } : null;
  $("fresh").hidden = true;
  renderList();
  const keepId = keep && S.items.some((i) => i.id === S.sel) ? S.sel : null;
  select(keepId ?? S.items[0]?.id ?? null, { scroll: true });
}

async function loadMore() {
  const last = S.items.at(-1);
  if (!last || !S.more) return;
  const params = new URLSearchParams({ group: S.tab, view: S.view, limit: String(PAGE), before: `${last.createdUtc}:${last.id}` });
  if (S.tracker) params.set("tracker", S.tracker);
  if (S.q) params.set("q", S.q);
  const res = await api(`/api/items?${params}`);
  const fresh = res.items.filter((i) => !S.items.some((x) => x.id === i.id));
  S.items.push(...fresh);
  S.more = res.more;
  $("list").append(...fresh.map(rowEl));
  $("more").hidden = !S.more;
}

function renderList() {
  fill($("list"), ...S.items.map(rowEl));
  $("more").hidden = !S.more;
  renderEmpty();
}

function renderEmpty() {
  const empty = $("empty");
  empty.hidden = S.items.length > 0;
  if (!empty.hidden) {
    const [title, sub] = emptyText();
    empty.querySelector(".empty-title").textContent = title;
    empty.querySelector(".empty-sub").textContent = sub;
  }
}

function emptyText() {
  if (S.q) return [`No posts match “${S.q}”.`, "Search looks in titles, text and subreddit names."];
  if (S.view === "done") return ["Nothing done here yet.", "Posts you mark Replied or Skip move here."];
  switch (S.tab) {
    case "urgent":
      return ["Nothing urgent.", "Posts that need an answer within hours land here first."];
    case "worth":
      return ["Nothing worth a look.", "Posts worth reading or answering, without the rush."];
    case "fyi":
      return ["No FYI posts.", "On topic, but nothing to act on."];
    case "noise":
      return ["No noise.", "What the model threw out lands here, so you can check nothing important got lost."];
    default:
      return ["Nothing is waiting.", "Posts appear here while the decision model has not classified them yet."];
  }
}

function rowEl(item) {
  const v = topVerdict(item);
  const g = item.group ?? "pending";
  const cls = ["row", `g-${g}`];
  if (!item.seen) cls.push("unseen");
  if (!isOpen(item)) cls.push("done");
  const trackers = [...new Set(item.verdicts.map((x) => x.tracker))];
  return h(
    "li",
    {
      class: cls.join(" "),
      id: `row-${item.id}`,
      role: "option",
      "aria-selected": String(item.id === S.sel),
      dataset: { id: item.id, created: String(item.createdUtc) },
      onclick: () => select(item.id, { reveal: true }),
      ondblclick: () => openThread(item),
    },
    h(
      "div",
      { class: "row-meta" },
      h("span", { class: "sub" }, `r/${item.subreddit}`),
      h("span", { class: "sep" }, "·"),
      h("span", { class: "age", title: absTime(item.createdUtc) }, ago(item.createdUtc)),
      item.kind === "comment" ? h("span", { class: "kind" }, "· comment") : null,
      item.link ? h("span", { class: "kind", title: item.link.url }, `· ${item.link.kind === "article" ? item.link.host : item.link.kind}`) : null,
      h("span", { class: "chips" }, trackers.map((t) => h("span", { class: "chip", title: t }, t))),
    ),
    h("div", { class: "row-title" }, item.title || "(no title)"),
    rowFoot(item, v),
  );
}

function rowFoot(item, v) {
  const parts = [];
  if (!item.group) {
    parts.push(h("span", { class: "badge" }, v?.state === "error" ? "model error" : "waiting for d1"));
  } else if (v?.reason) {
    parts.push(h("span", { class: "badge", title: `Set by the code, not the model: ${v.reason}` }, v.reason));
  } else if (v?.answers && item.codeGroup) {
    const p = v.answers.group.probabilities[item.codeGroup];
    parts.push(h("span", { class: `badge prob g-${item.codeGroup}`, title: "How sure d1 is" }, `${LABEL[item.codeGroup]} `, h("b", {}, fmt(p))));
  }
  if (item.userGroup) {
    const same = item.userGroup === item.codeGroup;
    parts.push(h("span", { class: `badge user g-${item.userGroup}` }, same ? "✓ you confirmed" : `you: ${LABEL[item.userGroup]}`));
  }
  if (item.copies.length)
    parts.push(h("span", { class: "badge", title: `Also posted in ${item.copies.map((c) => `r/${c.subreddit}`).join(", ")}` }, `+${item.copies.length} ${item.copies.length === 1 ? "copy" : "copies"}`));
  if (item.status === "backfill") parts.push(h("span", { class: "badge", title: "From the first poll of a feed: history, never notified" }, "backfill"));
  if (item.status === "replied") parts.push(h("span", { class: "badge" }, "replied"));
  if (item.status === "skipped") parts.push(h("span", { class: "badge" }, "skipped"));
  return parts.length ? h("div", { class: "row-foot" }, parts) : null;
}

let seenTimer = 0;
function select(id, { scroll = false, reveal = false } = {}) {
  if (S.pendingMove && S.pendingMove.id !== id) S.pendingMove = null;
  const prev = S.sel;
  S.sel = id;
  if (prev && prev !== id) $(`row-${prev}`)?.setAttribute("aria-selected", "false");
  const row = id ? $(`row-${id}`) : null;
  row?.setAttribute("aria-selected", "true");
  if (scroll) row?.scrollIntoView({ block: "nearest" });
  if (reveal) document.body.classList.add("reading");
  renderDetail();
  clearTimeout(seenTimer);
  const item = current();
  if (item && !item.seen) {
    seenTimer = setTimeout(() => {
      if (S.sel !== item.id) return;
      item.seen = true;
      $(`row-${item.id}`)?.classList.remove("unseen");
      api(`/api/items/${item.id}/seen`, {}).catch(() => {});
    }, 700);
  }
}

async function move(d) {
  if (!S.items.length) return;
  let i = indexOfSel();
  if (i === -1) i = d > 0 ? -1 : S.items.length;
  const next = i + d;
  if (next >= S.items.length && S.more) {
    await loadMore();
  }
  const target = S.items[Math.max(0, Math.min(S.items.length - 1, next))];
  if (target) select(target.id, { scroll: true });
}

// ---------------------------------------------------------------- detail

function renderDetail() {
  const pane = $("detail");
  const item = current();
  if (!item) {
    fill(pane, 
      h("div", { class: "detail-empty" }, S.items.length ? "Select a post on the left." : "Nothing to show in this group."),
    );
    return;
  }
  fill(pane, 
    h(
      "article",
      { class: "detail" },
      actionBar(item),
      h("div", { id: "confirm-slot", class: "confirm-slot", hidden: true }),
      h(
        "header",
        { class: "d-head" },
        h(
          "div",
          { class: "d-tags" },
          item.group ? h("span", { class: `pill g-${item.group}` }, LABEL[item.group]) : h("span", { class: "pill g-pending" }, "Waiting for d1"),
          whoSet(item),
          item.status !== "new" ? h("span", { class: "badge" }, item.status) : null,
        ),
        item.kind === "comment" ? h("div", { class: "d-context" }, "Comment in the thread") : null,
        h("h1", { class: "d-title" }, item.title || "(no title)"),
        h(
          "div",
          { class: "d-meta" },
          h("span", {}, `r/${item.subreddit}`),
          h("span", { class: "sep" }, "·"),
          h("span", {}, `u/${item.author}`),
          h("span", { class: "sep" }, "·"),
          h("span", { title: absTime(item.createdUtc) }, ago(item.createdUtc)),
        ),
        item.copies.length
          ? h(
              "div",
              { class: "d-copies" },
              "Also posted in ",
              item.copies.map((c, i) => [
                i ? ", " : "",
                c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer" }, `r/${c.subreddit}`) : `r/${c.subreddit}`,
              ]),
              ". Shown and notified once.",
            )
          : null,
      ),
      item.link ? linkCard(item.link) : null,
      item.text
        ? h("div", { class: "d-body" }, item.text)
        : item.link
          ? null
          : h("p", { class: "d-body none" }, "No text. Open it on Reddit to see it."),
      whySection(item),
    ),
  );
  pane.scrollTop = 0;
  renderConfirm();
}

const LINK_KIND = { article: "Article", image: "Image", video: "Video", gallery: "Gallery", crosspost: "Crosspost" };

/** What a link or media post points to. The server only sends http(s) URLs; checked again here. */
function linkCard(link) {
  if (!/^https?:\/\//i.test(link.url)) return null;
  return h(
    "a",
    { class: "link-card", href: link.url, target: "_blank", rel: "noopener noreferrer", title: link.url },
    h("span", { class: "link-kind" }, LINK_KIND[link.kind] ?? "Link"),
    h("span", { class: "link-where" }, h("span", { class: "link-host" }, link.host), h("span", { class: "link-path" }, link.label.slice(link.host.length) || "/")),
    h("span", { class: "link-go", "aria-hidden": "true" }, "↗"),
  );
}

function whoSet(item) {
  if (!item.group) return null;
  if (item.userGroup && item.userGroup !== item.codeGroup)
    return h("span", {}, `You moved it here. d1 said ${LABEL[item.codeGroup] ?? "nothing yet"}.`);
  if (item.userGroup) return h("span", {}, "You confirmed this group.");
  return h("span", {}, "Sorted by d1.");
}

function actionBar(item) {
  const open = isOpen(item);
  return h(
    "div",
    { class: "d-bar" },
    h("button", { class: "btn back", type: "button", onclick: () => document.body.classList.remove("reading") }, "← Back"),
    h("button", { class: "btn primary", type: "button", disabled: !item.url, onclick: () => openThread(item) }, "Open on Reddit ", h("kbd", {}, "O")),
    open
      ? [
          h("button", { class: "btn", type: "button", onclick: () => act({ type: "replied" }) }, "Replied ", h("kbd", {}, "R")),
          h("button", { class: "btn", type: "button", onclick: () => act({ type: "skipped" }) }, "Skip ", h("kbd", {}, "S")),
        ]
      : h("button", { class: "btn", type: "button", onclick: () => act({ type: "reopen" }) }, "Back to inbox"),
    h(
      "div",
      { class: "move", role: "group", "aria-label": "Put in group" },
      GROUPS.map((g, i) =>
        h(
          "button",
          {
            class: `seg g-${g}`,
            type: "button",
            "aria-pressed": String(item.group === g),
            title: item.group === g ? `Confirm ${LABEL[g]} (${i + 1})` : `Move to ${LABEL[g]} (${i + 1})`,
            onclick: () => label(g),
          },
          h("span", { class: "dot" }),
          h("span", { class: "label" }, LABEL[g]),
          h("span", { class: "short" }, SHORT[g]),
          h("span", { class: "n" }, String(i + 1)),
        ),
      ),
    ),
    h("span", { class: "spacer" }),
    h("button", { class: "btn", type: "button", disabled: !S.undo.length, onclick: undo, title: "Undo (U)" }, "Undo ", h("kbd", {}, "U")),
  );
}

function whySection(item) {
  if (!item.verdicts.length) return null;
  return h(
    "section",
    { class: "why" },
    h("h2", {}, "Why it is here"),
    item.verdicts.map(verdictEl),
    h(
      "p",
      { class: "legend" },
      h("span", { class: "tick-sample" }),
      "marks a threshold the router uses. Drag it, or focus it and use the arrow keys, to change it for this tracker. The model gives probabilities; the code picks the group.",
    ),
  );
}

/** This tracker's thresholds: its own, learned, or the defaults. */
function trackerThresholds(name) {
  return S.state?.trackers.find((t) => t.name === name)?.thresholds ?? S.state?.thresholds;
}

/** The thresholds set by hand for this tracker (in trackers.json or by dragging). */
function manualOf(name) {
  return S.state?.trackers.find((t) => t.name === name)?.manual ?? {};
}

const THRESHOLD_NAME = {
  urgent: "the Urgent threshold",
  offTopic: "the off-topic cut-off",
  urgentOnTopic: "the on-topic minimum for Urgent",
  spam: "the spam cut-off",
};

function thresholdNote(name) {
  const t = trackerThresholds(name);
  if (!t) return null;
  if (t.urgentSource === "manual") {
    return h(
      "div",
      { class: "v-threshold" },
      `Urgent for ${name} needs ${fmt(t.urgent)}: set by you. `,
      h(
        "button",
        { class: "link-btn inline", type: "button", onclick: () => setThreshold(name, "urgent", null, t.urgent) },
        S.state.learning ? "Let it follow my labels again" : "Back to the default",
      ),
    );
  }
  const source =
    t.urgentSource === "learned"
      ? `learned from your ${t.learnedFrom} labels`
      : S.state.learning
        ? "the default, until you have labelled enough posts of this tracker"
        : "the default";
  return h("div", { class: "v-threshold" }, `Urgent for ${name} needs ${fmt(t.urgent)}: ${source}.`);
}

function verdictEl(v) {
  const t = trackerThresholds(v.tracker);
  const a = v.answers;
  const knows = !!S.state?.trackers.some((x) => x.name === v.tracker);
  const tick = (key) => (t ? { value: t[key], key: knows ? key : null, tracker: v.tracker } : null);
  return h(
    "div",
    { class: "verdict" },
    h(
      "div",
      { class: "v-head" },
      h("strong", {}, v.tracker),
      v.template ? h("span", { class: "tpl" }, TEMPLATE[v.template] ?? v.template) : null,
    ),
    h(
      "div",
      { class: "v-match" },
      v.phrase ? ["Matched ", h("code", {}, v.phrase)] : "Found by Reddit's search; none of the tracker's phrases is in the text.",
    ),
    h("div", { class: "v-decision" }, decisionText(v)),
    v.error ? h("div", { class: "v-error" }, `Model error: ${v.error}`) : null,
    a
      ? h(
          "div",
          { class: "bars" },
          GROUPS.map((g) =>
            bar(LABEL[g], a.group.probabilities[g], { group: g, ticks: g === "urgent" ? [tick("urgent")] : [], chosen: a.group.choice === g }),
          ),
        )
      : null,
    a
      ? h(
          "div",
          { class: "bars minor" },
          bar("on topic", a.onTopic, { color: "var(--accent)", ticks: [tick("offTopic"), tick("urgentOnTopic")] }),
          bar("spam", a.spam, { color: "var(--danger)", ticks: [tick("spam")] }),
          Object.entries(a.signals).map(([k, p]) => bar(k.replace(/_/g, " "), p, { color: "var(--faint)" })),
        )
      : null,
    a ? thresholdNote(v.tracker) : null,
  );
}

function decisionText(v) {
  if (v.state === "pending") return "Waiting for the decision model.";
  if (v.state === "error") return "The decision model failed on this post.";
  if (v.state === "prefiltered") return [h("span", { class: `pill g-noise` }, "Noise"), h("span", { class: "why-text" }, `  without the model: ${v.reason}`)];
  if (!v.answers) return "";
  const chose = v.answers.group.choice;
  if (v.group && v.group !== chose) {
    return [
      "d1 chose ",
      h("strong", {}, LABEL[chose]),
      h("span", { class: "arrow" }, "→"),
      h("span", { class: `pill g-${v.group}` }, LABEL[v.group]),
      h("span", { class: "why-text" }, `  ${v.reason ?? ""}`),
    ];
  }
  return ["d1 chose ", h("span", { class: `pill g-${chose}` }, LABEL[chose])];
}

function bar(name, p, { group, color, ticks, chosen } = {}) {
  const fill = h("div", { class: "fill" });
  fill.style.width = `${Math.round((p ?? 0) * 1000) / 10}%`;
  if (color) fill.style.background = color;
  const track = h("div", { class: `bar${group ? ` g-${group}` : ""}` }, fill);
  for (const t of ticks ?? []) if (t && typeof t.value === "number") track.append(tickEl(track, t));
  return [h("span", { class: `bar-label${chosen ? " chosen" : ""}`, title: name }, name), track, h("span", { class: "bar-val" }, fmt(p))];
}

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** A threshold mark. With a key it is a slider: drag it, or focus it and use the arrows. */
function tickEl(track, t) {
  const at = (v) => `${v * 100}%`;
  if (!t.key) {
    const mark = h("div", { class: "tick", title: `threshold ${fmt(t.value)}` });
    mark.style.left = at(t.value);
    return mark;
  }
  let value = t.value;
  const label = h("span", { class: "tick-value" }, fmt(value));
  const mark = h(
    "div",
    {
      class: "tick handle",
      role: "slider",
      tabindex: "0",
      "aria-label": `${THRESHOLD_NAME[t.key]} for ${t.tracker}`,
      "aria-valuemin": "0",
      "aria-valuemax": "1",
      "aria-valuenow": fmt(value),
      title: `${THRESHOLD_NAME[t.key]}: ${fmt(value)}. Drag to change it for ${t.tracker}.`,
    },
    label,
  );
  mark.style.left = at(value);
  const show = (v) => {
    value = v;
    mark.style.left = at(v);
    label.textContent = fmt(v);
    mark.setAttribute("aria-valuenow", fmt(v));
  };
  const commit = () => {
    if (value !== t.value) setThreshold(t.tracker, t.key, value, manualOf(t.tracker)[t.key] ?? null);
  };
  // Dragging is tracked with a flag: pointer capture keeps the moves coming
  // when the pointer leaves the thin mark, but it is not available everywhere.
  let dragging = false;
  mark.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    mark.classList.add("dragging");
    try {
      mark.setPointerCapture(e.pointerId);
    } catch {}
  });
  mark.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = track.getBoundingClientRect();
    show(clamp(round2((e.clientX - r.left) / r.width), 0.01, 0.99));
  });
  const end = (save) => {
    if (!dragging) return;
    dragging = false;
    mark.classList.remove("dragging");
    if (save) commit();
    else show(t.value);
  };
  mark.addEventListener("pointerup", () => end(true));
  mark.addEventListener("pointercancel", () => end(false));
  let keyTimer = 0;
  mark.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    show(clamp(round2(value + d), 0.01, 0.99));
    clearTimeout(keyTimer);
    keyTimer = setTimeout(commit, 700);
  });
  return mark;
}

/** Save one threshold of a tracker (null clears it), re-sort, and offer to undo. */
async function setThreshold(tracker, key, value, previous) {
  let res;
  try {
    res = await api(`/api/trackers/${encodeURIComponent(tracker)}/thresholds`, { [key]: value });
  } catch (err) {
    toast(`Could not change the threshold: ${err.message}`);
    renderDetail();
    return;
  }
  await refreshState();
  applyCounts(res.counts);
  await loadList({ keep: true });
  const what = THRESHOLD_NAME[key];
  const moved = res.moved === 1 ? "1 post changed group" : `${res.moved} posts changed group`;
  const text =
    value === null
      ? `${tracker}: ${what} is automatic again (${fmt(res.thresholds[key])}). ${moved}.`
      : `${tracker}: ${what} is now ${fmt(value)}. ${moved}.`;
  toast(text, () => setThreshold(tracker, key, previous, value), 7000);
}

// ---------------------------------------------------------------- actions

function openThread(item) {
  if (!item) return;
  if (!item.url) return toast("This post has no link.");
  window.open(item.url, "_blank", "noopener,noreferrer");
}

function doneMessage(action, before, after) {
  switch (action.type) {
    case "replied":
      return "Marked as replied";
    case "skipped":
      return "Skipped";
    case "reopen":
      return "Back in the inbox";
    case "label":
      return after.userGroup === after.codeGroup ? `Confirmed: ${LABEL[action.group]}` : `Moved to ${LABEL[action.group]}`;
    default:
      return "Saved";
  }
}

async function act(action) {
  const item = current();
  if (!item || S.busy) return;
  S.busy = true;
  const idx = indexOfSel();
  const before = { status: item.status, userGroup: item.userGroup };
  try {
    const res = await api(`/api/items/${item.id}/action`, action);
    S.undo.push({ id: item.id, before, idx });
    if (S.undo.length > 50) S.undo.shift();
    applyCounts(res.counts);
    place(res.item, idx, true);
    const changes = res.thresholdChanges ?? [];
    if (changes.length) {
      const c = changes[0];
      toast(
        `${doneMessage(action, before, res.item)}. ${c.tracker}: Urgent now needs ${fmt(c.to)} (was ${fmt(c.from)}), learned from your ${c.n} labels`,
        true,
        7000,
      );
      await refreshState();
      renderDetail();
    } else {
      toast(doneMessage(action, before, res.item), true);
    }
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  } finally {
    S.busy = false;
  }
}

// Moving a post to another group asks first: on 2026-10-04 a few stray clicks
// moved ten posts unnoticed. Confirming the group a post is already in moves
// nothing, so it does not ask. The question sits in the post's panel, and the
// same key again (or Enter) answers it, so labelling stays fast.
const askBeforeMoving = () => saved.get("confirmMoves") !== "0";

function label(group) {
  const item = current();
  if (!item) return;
  const p = S.pendingMove;
  if (p && p.id === item.id && p.group === group) return confirmMove();
  if (item.group !== group && askBeforeMoving()) {
    S.pendingMove = { id: item.id, group };
    renderConfirm();
    return;
  }
  return act({ type: "label", group });
}

function renderConfirm() {
  const slot = $("confirm-slot");
  if (!slot) return;
  const p = S.pendingMove;
  if (!p || p.id !== S.sel) {
    fill(slot);
    slot.hidden = true;
    return;
  }
  const n = GROUPS.indexOf(p.group) + 1;
  fill(
    slot,
    h(
      "div",
      { class: `confirm g-${p.group}`, role: "alertdialog", "aria-label": `Move this post to ${LABEL[p.group]}?` },
      h("span", { class: "confirm-text" }, "Move this post to ", h("strong", {}, LABEL[p.group]), "?"),
      h("button", { class: "btn primary", type: "button", onclick: () => confirmMove() }, "Move ", h("kbd", {}, String(n)), h("kbd", {}, "Enter")),
      h("button", { class: "btn", type: "button", onclick: cancelMove }, "Cancel ", h("kbd", {}, "Esc")),
      h("label", { class: "dont-ask" }, h("input", { type: "checkbox", id: "dont-ask" }), "Don't ask again"),
    ),
  );
  slot.hidden = false;
}

function confirmMove() {
  const p = S.pendingMove;
  const dontAsk = $("dont-ask")?.checked;
  S.pendingMove = null;
  renderConfirm();
  if (!p || p.id !== S.sel) return;
  if (dontAsk) {
    saved.set("confirmMoves", "0");
    $("ask-moves").checked = false;
  }
  return act({ type: "label", group: p.group });
}

function cancelMove() {
  S.pendingMove = null;
  renderConfirm();
}

/** Put an updated item back in the list, or take it out if it no longer belongs, and move on. */
function place(updated, idx, advance) {
  if (belongs(updated)) {
    S.items[idx] = updated;
    $(`row-${updated.id}`)?.replaceWith(rowEl(updated));
    const next = advance ? S.items[idx + 1] : null;
    select(next ? next.id : updated.id, { scroll: true });
  } else {
    S.items.splice(idx, 1);
    $(`row-${updated.id}`)?.remove();
    const next = S.items[Math.min(idx, S.items.length - 1)];
    select(next ? next.id : null, { scroll: true });
    renderEmpty();
  }
}

async function undo() {
  const u = S.undo.pop();
  if (!u) return toast("Nothing to undo.");
  try {
    let item = await api(`/api/items/${u.id}`);
    if (item.status !== u.before.status) {
      const a = u.before.status === "new" || u.before.status === "backfill" ? { type: "reopen", status: u.before.status } : { type: u.before.status };
      item = (await api(`/api/items/${u.id}/action`, a)).item;
    }
    if (item.userGroup !== u.before.userGroup) {
      const a = u.before.userGroup ? { type: "label", group: u.before.userGroup } : { type: "unlabel" };
      item = (await api(`/api/items/${u.id}/action`, a)).item;
    }
    const at = S.items.findIndex((i) => i.id === item.id);
    if (belongs(item)) {
      if (at >= 0) S.items[at] = item;
      else S.items.splice(Math.min(u.idx, S.items.length), 0, item);
      renderList();
      select(item.id, { scroll: true });
    } else if (at >= 0) {
      S.items.splice(at, 1);
      renderList();
      select(S.items[Math.min(at, S.items.length - 1)]?.id ?? null);
    }
    await refreshState();
    S.known = { ...S.state.counts };
    toast(belongs(item) ? "Undone" : `Undone: the post is back in ${LABEL[item.group ?? "pending"]}`);
  } catch (err) {
    toast(`Undo failed: ${err.message}`);
  }
}

function applyCounts(counts) {
  if (!S.state) return;
  S.state.counts = counts;
  S.known = { ...counts };
  renderTabs();
}

// ---------------------------------------------------------------- tabs, filters, polling

function visibleTabs() {
  return TABS.filter((g) => g !== "pending" || S.state?.counts.pending || S.tab === "pending");
}

function setTab(g) {
  if (!TABS.includes(g)) return;
  S.tab = g;
  saved.set("tab", g);
  document.body.classList.remove("reading");
  renderTabs();
  loadList();
}

function switchTab(d) {
  const tabs = visibleTabs();
  const i = tabs.indexOf(S.tab);
  setTab(tabs[(i + d + tabs.length) % tabs.length]);
}

function showFresh() {
  if ($("fresh").hidden) return;
  loadList({ keep: true });
}

async function tick() {
  const ok = await refreshState();
  if (!ok) return;
  for (const row of document.querySelectorAll(".row")) {
    const age = row.querySelector(".age");
    if (age) age.textContent = ago(Number(row.dataset.created));
  }
  if (S.view === "open" && S.known && S.tab !== "pending") {
    const added = S.state.counts[S.tab] - S.known[S.tab];
    const btn = $("fresh");
    if (added > 0) {
      btn.textContent = `${added} new ${added === 1 ? "post" : "posts"} · show`;
      btn.hidden = false;
    }
  }
}

async function renderFeeds() {
  const body = $("feeds-body");
  fill(body, h("p", { class: "hint" }, "Loading…"));
  let feeds;
  try {
    feeds = await api("/api/feeds");
  } catch (err) {
    fill(body, h("p", { class: "v-error" }, `Could not load feeds: ${err.message}`));
    return;
  }
  const kind = { search: "Search", subreddit: "New posts", comments: "Comments" };
  fill(body, 
    h(
      "table",
      { class: "feeds-table" },
      h("thead", {}, h("tr", {}, ["Feed", "Trackers", "Every", "Last fetch", "Next"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        feeds.map((f) =>
          h(
            "tr",
            {},
            h("td", {}, h("div", {}, kind[f.kind]), h("div", { class: "what" }, f.what), f.lastError ? h("div", { class: "err" }, f.lastError) : null),
            h("td", {}, f.trackers.join(", ")),
            h("td", {}, f.intervalS ? `${Math.round(f.intervalS / 60)} min` : "–"),
            h(
              "td",
              {},
              f.lastFetch
                ? [ago(f.lastFetch), " · ", h("span", { class: f.lastStatus === 200 ? "ok" : "err" }, String(f.lastStatus ?? "network error")), f.lastCount !== null ? ` · ${f.lastCount} items` : ""]
                : "never",
            ),
            h("td", {}, f.nextDue === null ? "next free minute" : f.nextDue <= Date.now() ? "due now" : until(f.nextDue)),
          ),
        ),
      ),
    ),
  );
}

function openDialog(id) {
  const d = $(id);
  if (d.open) return;
  if (id === "feeds") renderFeeds();
  d.showModal();
}

// ---------------------------------------------------------------- keyboard

// Shortcuts must work in any keyboard layout. With a Russian layout the J key
// types "о", so a key that is not one of ours falls back to the physical key.
// A Latin layout still uses the letter it types, so Dvorak keeps its own J.
const OURS = new Set(["j", "k", "o", "r", "s", "u", "z", "1", "2", "3", "4", "[", "]", ".", "/", "?"]);
const BY_CODE = {
  KeyJ: "j", KeyK: "k", KeyO: "o", KeyR: "r", KeyS: "s", KeyU: "u", KeyZ: "z",
  Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Numpad1: "1", Numpad2: "2", Numpad3: "3", Numpad4: "4",
  BracketLeft: "[", BracketRight: "]", Period: ".", Slash: "/",
};

function keyOf(e) {
  if (e.key.length > 1) return e.key;
  const k = e.key.toLowerCase();
  if (OURS.has(k)) return k;
  const c = BY_CODE[e.code];
  if (!c) return k;
  return c === "/" && e.shiftKey ? "?" : c;
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  if (S.page !== "inbox") return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) {
    if (e.key === "Escape" || (e.key === "Enter" && t === $("q"))) t.blur();
    return;
  }
  if (t instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
  const k = keyOf(e);
  if (S.pendingMove) {
    const n = String(GROUPS.indexOf(S.pendingMove.group) + 1);
    if (k === "Enter" || k === n) {
      e.preventDefault();
      confirmMove();
      return;
    }
    cancelMove();
    if (k === "Escape") {
      e.preventDefault();
      return;
    }
  }
  switch (k) {
    case "j":
    case "ArrowDown":
      move(1);
      break;
    case "k":
    case "ArrowUp":
      move(-1);
      break;
    case "o":
    case "Enter":
      openThread(current());
      break;
    case "r":
      if (current() && isOpen(current())) act({ type: "replied" });
      break;
    case "s":
      if (current() && isOpen(current())) act({ type: "skipped" });
      break;
    case "1":
    case "2":
    case "3":
    case "4":
      label(GROUPS[Number(k) - 1]);
      break;
    case "u":
    case "z":
      undo();
      break;
    case "[":
      switchTab(-1);
      break;
    case "]":
      switchTab(1);
      break;
    case "/":
      $("q").focus();
      break;
    case ".":
      showFresh();
      break;
    case "?":
      openDialog("help");
      break;
    case "Escape":
      document.body.classList.remove("reading");
      break;
    default:
      return;
  }
  e.preventDefault();
}

// ---------------------------------------------------------------- trackers page

const T = { data: null, editing: null, error: null, deleting: null };

function showPage(page) {
  S.page = page;
  const trackers = page === "trackers";
  document.querySelector("main.layout").hidden = trackers;
  $("trackers-page").hidden = !trackers;
  $("trackers-btn").setAttribute("aria-pressed", String(trackers));
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(!trackers && t.dataset.group === S.tab));
  if (trackers) loadTrackerPage();
}

async function loadTrackerPage() {
  try {
    T.data = await api("/api/trackers");
  } catch (err) {
    fill($("trackers-body"), h("p", { class: "v-error" }, `Could not load trackers: ${err.message}`));
    return;
  }
  renderTrackerPage();
}

const csv = (list) => (list ?? []).join(", ");
const splitList = (s) => s.split(/[,\s]+/).map((x) => x.replace(/^\/?r\//i, "").trim()).filter(Boolean);
const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

function renderTrackerPage() {
  const body = $("trackers-body");
  if (T.editing) return fill(body, trackerForm(T.editing));
  if (!T.data.trackers.length)
    return fill(
      body,
      h("div", { class: "empty" }, h("p", { class: "empty-title" }, "No trackers yet."), h("p", { class: "empty-sub" }, "Add one to start collecting posts.")),
    );
  fill(body, h("div", { class: "tracker-list" }, T.data.trackers.map(trackerCard)));
}

function trackerCard(t) {
  const r = t.raw;
  const tpl = T.data.templates[r.template ?? "help"];
  const e = t.effective;
  const source = e.urgentSource === "manual" ? "set by you" : e.urgentSource === "learned" ? `learned from ${e.learnedFrom} labels` : "default";
  const deleting = T.deleting === r.name;
  return h(
    "article",
    { class: `tracker-card${r.paused ? " paused" : ""}` },
    h(
      "div",
      { class: "tc-head" },
      h("h2", {}, r.name),
      h("span", { class: "chip" }, tpl?.title ?? r.template),
      r.paused ? h("span", { class: "badge" }, "paused") : null,
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => savePaused(r, !r.paused) }, r.paused ? "Resume" : "Pause"),
      h("button", { class: "btn", type: "button", onclick: () => editTracker(r) }, "Edit"),
      h("button", { class: "btn", type: "button", onclick: () => ((T.deleting = r.name), renderTrackerPage()) }, "Delete"),
    ),
    deleting
      ? h(
          "div",
          { class: "confirm g-noise" },
          h("span", { class: "confirm-text" }, "Delete ", h("strong", {}, r.name), "? Its posts stay in the inbox."),
          h("button", { class: "btn primary", type: "button", onclick: () => removeTracker(r.name) }, "Delete"),
          h("button", { class: "btn", type: "button", onclick: () => ((T.deleting = null), renderTrackerPage()) }, "Cancel"),
        )
      : null,
    h("p", { class: "tc-about" }, r.about),
    h(
      "dl",
      { class: "tc-facts" },
      r.queries?.length ? [h("dt", {}, "Searches"), h("dd", {}, r.queries.map((q) => h("code", {}, q)))] : null,
      r.subreddits?.length ? [h("dt", {}, "All new posts in"), h("dd", {}, csv(r.subreddits.map((s) => `r/${s}`)))] : null,
      r.commentSubreddits?.length ? [h("dt", {}, "Comments in"), h("dd", {}, csv(r.commentSubreddits.map((s) => `r/${s}`)))] : null,
      r.excludeSubreddits?.length ? [h("dt", {}, "Skips"), h("dd", {}, csv(r.excludeSubreddits.map((s) => `r/${s}`)))] : null,
      h("dt", {}, "Open posts"),
      h("dd", { class: "tc-counts" }, GROUPS.map((g) => h("span", { class: `badge g-${g}` }, `${LABEL[g]} ${t.counts[g]}`))),
      h("dt", {}, "Urgent needs"),
      h("dd", {}, `${fmt(e.urgent)} (${source})`),
    ),
  );
}

function editTracker(raw) {
  T.editing = raw ? { ...raw, _previous: raw.name } : { template: "help", queries: [] };
  T.error = null;
  renderTrackerPage();
  $("tf-name")?.focus();
}

function trackerForm(r) {
  const templates = T.data.templates;
  const current = templates[r.template ?? "help"];
  const field = (id, label, control, hint) => h("div", { class: "field" }, h("label", { for: id }, label), control, hint ? h("p", { class: "hint" }, hint) : null);
  const groupField = (g) =>
    h("textarea", { id: `tf-group-${g}`, rows: "2", placeholder: current.groups[g] }, r.groups?.[g] ?? "");
  return h(
    "form",
    {
      class: "tracker-form",
      onsubmit: (e) => {
        e.preventDefault();
        saveTracker();
      },
    },
    h("h2", {}, r._previous ? `Edit ${r._previous}` : "New tracker"),
    T.error ? h("p", { class: "v-error", role: "alert" }, T.error) : null,
    field("tf-name", "Name", h("input", { id: "tf-name", value: r.name ?? "", required: true, maxlength: "60", placeholder: "freshclone, Node.js news, Rust jobs…" })),
    h(
      "fieldset",
      { class: "field goals" },
      h("legend", {}, "What is it for?"),
      Object.values(templates).map((t) =>
        h(
          "label",
          { class: `goal${t.id === (r.template ?? "help") ? " on" : ""}` },
          h("input", {
            type: "radio",
            name: "tf-template",
            value: t.id,
            checked: t.id === (r.template ?? "help"),
            onchange: () => {
              T.editing = { ...readForm(), template: t.id };
              renderTrackerPage();
            },
          }),
          h("span", { class: "goal-title" }, t.title),
          h("span", { class: "goal-sum" }, t.summary),
        ),
      ),
    ),
    field(
      "tf-about",
      "About",
      h("textarea", { id: "tf-about", rows: "3", required: true, placeholder: current.aboutExample }, r.about ?? ""),
      "Who you are and what matters to you, in a sentence or two. Name the subject broadly first, then what matters most: the model judges every post against this.",
    ),
    field(
      "tf-queries",
      "Search for",
      h("textarea", { id: "tf-queries", rows: "4", placeholder: '"works on my machine"\n"fails on CI"\nlockfile "npm ci"' }, (r.queries ?? []).join("\n")),
      "One per line. Quotes make an exact phrase; words without quotes must all appear. Reddit's search is loose: the model sorts out what does not fit.",
    ),
    field("tf-comments", "Also read comments in", h("input", { id: "tf-comments", value: csv(r.commentSubreddits), placeholder: "node, javascript" }), "Subreddits whose new comments are checked for the phrases above. Reddit's search does not find comments."),
    field("tf-subs", "Every new post in", h("input", { id: "tf-subs", value: csv(r.subreddits), placeholder: "optional" }), "Subreddits to read in full, no phrases needed."),
    field("tf-exclude", "Skip", h("input", { id: "tf-exclude", value: csv(r.excludeSubreddits), placeholder: "ProgrammerHumor" }), "Posts from these subreddits go straight to Noise."),
    h(
      "details",
      { class: "field" },
      h("summary", {}, "What each group means for this tracker"),
      h("p", { class: "hint" }, "Leave a box empty to use the text of the goal you picked, shown greyed out."),
      GROUPS.map((g) => h("div", { class: "field" }, h("label", { for: `tf-group-${g}` }, LABEL[g]), groupField(g))),
      field(
        "tf-hours",
        "Urgent only within",
        h("input", { id: "tf-hours", type: "number", min: "1", max: "48", step: "1", value: r.urgentWithinHours ?? "", placeholder: String(current.urgentWithinHours) }),
        "Hours after posting. Older posts go to Worth a look.",
      ),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { class: "btn primary", type: "submit" }, "Save"),
      h("button", { class: "btn", type: "button", onclick: () => ((T.editing = null), renderTrackerPage()) }, "Cancel"),
    ),
  );
}

function readForm() {
  const val = (id) => $(id)?.value.trim() ?? "";
  const groups = {};
  for (const g of GROUPS) if (val(`tf-group-${g}`)) groups[g] = val(`tf-group-${g}`);
  const hours = Number(val("tf-hours"));
  return {
    ...T.editing,
    name: val("tf-name"),
    template: document.querySelector('input[name="tf-template"]:checked')?.value ?? "help",
    about: val("tf-about"),
    queries: lines($("tf-queries")?.value ?? ""),
    commentSubreddits: splitList(val("tf-comments")),
    subreddits: splitList(val("tf-subs")),
    excludeSubreddits: splitList(val("tf-exclude")),
    groups,
    urgentWithinHours: hours > 0 ? hours : null,
  };
}

async function saveTracker() {
  const form = readForm();
  const { _previous, ...tracker } = form;
  try {
    await api("/api/trackers", { tracker, previousName: _previous });
  } catch (err) {
    T.editing = form;
    T.error = err.message;
    renderTrackerPage();
    return;
  }
  toast(_previous ? `Saved ${tracker.name}` : `Added ${tracker.name}. Its first posts arrive within a few minutes.`);
  T.editing = null;
  await refreshState();
  await loadTrackerPage();
}

async function savePaused(raw, paused) {
  try {
    await api("/api/trackers", { tracker: { ...raw, paused }, previousName: raw.name });
  } catch (err) {
    return toast(`Could not save: ${err.message}`);
  }
  toast(paused ? `Paused ${raw.name}: no new posts until you resume it` : `Resumed ${raw.name}`);
  await refreshState();
  await loadTrackerPage();
}

async function removeTracker(name) {
  try {
    await api(`/api/trackers/${encodeURIComponent(name)}/delete`, {});
  } catch (err) {
    return toast(`Could not delete: ${err.message}`);
  }
  T.deleting = null;
  toast(`Deleted ${name}`);
  await refreshState();
  await loadTrackerPage();
}

// ---------------------------------------------------------------- start

function bind() {
  for (const btn of document.querySelectorAll(".tab"))
    btn.addEventListener("click", () => {
      if (S.page !== "inbox") showPage("inbox");
      setTab(btn.dataset.group);
    });
  $("trackers-btn").addEventListener("click", () => showPage(S.page === "trackers" ? "inbox" : "trackers"));
  $("add-tracker").addEventListener("click", () => editTracker(null));
  let searchTimer = 0;
  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.q = $("q").value.trim();
      loadList();
    }, 250);
  });
  $("tracker").addEventListener("change", () => {
    S.tracker = $("tracker").value;
    saved.set("tracker", S.tracker);
    loadList();
  });
  $("view").addEventListener("change", () => {
    S.view = $("view").value;
    saved.set("view", S.view);
    loadList();
  });
  $("more").addEventListener("click", () => loadMore());
  $("fresh").addEventListener("click", showFresh);
  $("help-btn").addEventListener("click", () => openDialog("help"));
  $("help-btn-2").addEventListener("click", () => openDialog("help"));
  $("feeds-btn").addEventListener("click", () => openDialog("feeds"));
  $("ask-moves").checked = askBeforeMoving();
  $("ask-moves").addEventListener("change", () => saved.set("confirmMoves", $("ask-moves").checked ? "1" : "0"));
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => {
      if (e.target === d || e.target.closest("[data-close]")) d.close();
    });
  }
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
}

async function init() {
  bind();
  const view = saved.get("view");
  S.view = ["open", "done", "all"].includes(view) ? view : "open";
  $("view").value = S.view;
  S.tracker = saved.get("tracker") ?? "";
  while (!(await refreshState())) await new Promise((r) => setTimeout(r, 3000));

  const deep = location.pathname.match(/^\/i\/(t[13]_[a-z0-9]+)$/i);
  if (deep) {
    try {
      const item = await api(`/api/items/${deep[1]}`);
      S.pin = item;
      S.tab = item.group ?? "pending";
      S.view = isOpen(item) ? "open" : "done";
      S.tracker = "";
      $("view").value = S.view;
      $("tracker").value = "";
    } catch {
      toast("That post is not in the inbox.");
    }
    history.replaceState(null, "", "/");
  } else {
    const last = saved.get("tab");
    S.tab = S.state.counts.urgent > 0 ? "urgent" : TABS.includes(last) ? last : "worth";
  }
  renderTabs();
  await loadList();
  setInterval(tick, POLL_MS);
}

init();
