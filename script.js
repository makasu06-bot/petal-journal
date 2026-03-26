// --- Minimal local journaling app (localStorage) ---
const $ = (id) => document.getElementById(id);

const els = {
  search: $("search"),
  date: $("date"),
  mood: $("mood"),
  title: $("title"),
  content: $("content"),
  moodChip: $("moodChip"),
  entryList: $("entryList"),
  count: $("count"),
  toast: $("toast"),
  status: $("status"),
  promptCard: $("promptCard"),
  tagRow: $("tagRow"),
  btnSave: $("btnSave"),
  btnDelete: $("btnDelete"),
  btnNew: $("btnNew"),
  btnExport: $("btnExport"),
  btnPrompt: $("btnPrompt"),
};

const STORAGE_KEY = "petal_journal_entries_v1";
let selectedId = null;
let activeTag = null;

const prompts = [
  "What’s one small win you had today?",
  "What felt heavy today—and what helped, even a little?",
  "Name one thing you can let go of tonight.",
  "What are you grateful for right now?",
  "If today had a theme song, what would it be?",
  "What do you want to remember about today?",
];

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveAll(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.style.display = "none"), 1300);
}

function fmtDate(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function setEditor(entry) {
  selectedId = entry?.id ?? null;
  els.date.value = entry?.date ?? todayISO();
  els.mood.value = entry?.mood ?? "Calm";
  els.title.value = entry?.title ?? "";
  els.content.value = entry?.content ?? "";
  syncMoodChip();
}

function syncMoodChip() {
  const label = els.mood.options[els.mood.selectedIndex].text; // includes your kaomoji
  els.moodChip.textContent = `Mood: ${label}`;
}

function playDeleteSfx() {
  const sfx = document.getElementById("deleteSfx");
  if (!sfx) return;
  sfx.currentTime = 0;
  sfx.play().catch(() => {}); // may be blocked until user interacts once
}

function upsertCurrent() {
  const entries = load();
  const data = {
    id: selectedId || uid(),
    date: els.date.value || todayISO(),
    mood: els.mood.value,
    title: els.title.value.trim() || "Untitled",
    content: els.content.value,
    tags: activeTag ? [activeTag] : [],
    updatedAt: new Date().toISOString(),
    createdAt: null,
  };

  const idx = entries.findIndex((e) => e.id === data.id);
  if (idx >= 0) {
    data.createdAt = entries[idx].createdAt || data.updatedAt;
    entries[idx] = { ...entries[idx], ...data };
  } else {
    data.createdAt = data.updatedAt;
    entries.unshift(data);
  }

  saveAll(entries);
  selectedId = data.id;
  renderList();
  playSaveSfx();
  toast("Saved");
}

function deleteCurrent() {
  if (!selectedId) return toast("Nothing selected");

  const entries = load().filter((e) => e.id !== selectedId);
  saveAll(entries);
  setEditor(null);
  renderList();

  playDeleteSfx(); // <- joke sound
  toast("Deleted");
}
function playSaveSfx() {
  const sfx = document.getElementById("saveSfx");
  if (!sfx) return;
  sfx.currentTime = 0;
  sfx.play().catch(() => {});
}

function filtered(entries) {
  const q = els.search.value.trim().toLowerCase();
  return entries.filter((e) => {
    const hay = `${e.title}\n${e.content}\n${(e.tags || []).join(" ")}`.toLowerCase();
    const okQ = !q || hay.includes(q);
    const okTag = !activeTag || (e.tags || []).includes(activeTag);
    return okQ && okTag;
  });
}

function renderList() {
  const entries = load().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const list = filtered(entries);
  els.count.textContent = `${list.length} shown`;

  els.entryList.innerHTML = "";
  list.forEach((e) => {
    const card = document.createElement("div");
    card.className = "entry-card";
    card.tabIndex = 0;
    card.innerHTML = `
      <h4>${escapeHtml(e.title || "Untitled")}</h4>
      <p>${escapeHtml(fmtDate(e.date))} • ${escapeHtml(e.mood || "Calm")}</p>
      <p>${escapeHtml(snippet(e.content || ""))}</p>
    `;
    card.addEventListener("click", () => setEditor(e));
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") setEditor(e);
    });
    els.entryList.appendChild(card);
  });
}

function snippet(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 80) + "…" : t || "—";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setPrompt() {
  const p = prompts[Math.floor(Math.random() * prompts.length)];
  els.promptCard.textContent = p;
}

function exportJSON() {
  const data = load();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `petal-journal-export-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Tag filtering
els.tagRow.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-tag]");
  if (!btn) return;

  const tag = btn.getAttribute("data-tag");
  activeTag = activeTag === tag ? null : tag;

  [...els.tagRow.querySelectorAll("[data-tag]")].forEach((b) => {
    b.style.outline =
      b.getAttribute("data-tag") === activeTag
        ? "3px solid color-mix(in srgb, var(--primary) 45%, transparent)"
        : "none";
  });

  renderList();
});

// Events
els.mood.addEventListener("change", syncMoodChip);
els.btnSave.addEventListener("click", upsertCurrent);
els.btnDelete.addEventListener("click", deleteCurrent);
els.btnNew.addEventListener("click", () => {
  setEditor(null);
  toast("New entry");
});
els.btnExport.addEventListener("click", exportJSON);
els.btnPrompt.addEventListener("click", setPrompt);
els.search.addEventListener("input", renderList);

// Init
setEditor({ date: todayISO(), mood: "Calm", title: "", content: "" });
setPrompt();
renderList();

// --- Sparkle cursor trail (canvas) ---
(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.getElementById("sparkles");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const colors = ["#FFA5D6", "#FFD6EE", "#ECD2E0", "#CED1F8", "#A7ABDE"];
  const particles = [];
  let last = { x: 0, y: 0, t: 0 };

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  addEventListener("resize", resize);

  function spawn(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.4 + Math.random() * 1.6;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 0.4,
        r: 1 + Math.random() * 2.2,
        life: 18 + Math.random() * 18,
        color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.25,
      });
    }
  }

  addEventListener(
    "pointermove",
    (e) => {
      const now = performance.now();
      const x = e.clientX,
        y = e.clientY;

      if (now - last.t < 12) return;

      const dx = x - last.x,
        dy = y - last.y;
      const dist = Math.hypot(dx, dy);
      const count = Math.max(2, Math.min(10, Math.floor(dist / 6)));

      spawn(x, y, count);
      last = { x, y, t: now };
    },
    { passive: true }
  );

  function drawStar(x, y, r, rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.45, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r * 0.45, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.03;
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.rot += p.vr;
      p.life -= 1;

      const alpha = Math.max(0, Math.min(1, p.life / 24));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      drawStar(p.x, p.y, p.r, p.rot);
      ctx.globalAlpha = alpha * 0.25;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 2.2, 0, Math.PI * 2);
      ctx.fill();

      if (p.life <= 0) particles.splice(i, 1);
    }

    ctx.globalAlpha = 1;

    if (particles.length > 500) particles.splice(0, particles.length - 500);

    requestAnimationFrame(tick);
  }
  tick();
})();

// --- Background music controls (local mp3 in <audio id="bgm">) ---
(() => {
  const audio = document.getElementById("bgm");
  const btn = document.getElementById("btnMusic");
  const vol = document.getElementById("musicVol");
  if (!audio || !btn || !vol) return;

  const savedVol = localStorage.getItem("petal_music_vol");
  if (savedVol !== null) vol.value = savedVol;
  audio.volume = Number(vol.value);

  function setBtn() {
    btn.textContent = audio.paused ? "Play music" : "Pause music";
  }
  setBtn();

  vol.addEventListener("input", () => {
    audio.volume = Number(vol.value);
    localStorage.setItem("petal_music_vol", String(vol.value));
  });

  btn.addEventListener("click", async () => {
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
      setBtn();
    } catch {
      btn.textContent = "Music unavailable";
    }
  });
})();
