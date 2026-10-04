/* =============================================================
   Sticky Board · app.js
   Author: Sajid Muhammad (B.Sc. Data Science, University of Manitoba)

   Plain JavaScript with no frameworks and no build step, so the app
   runs by opening index.html. Lists and settings come from js/config.js.

   How the code is organised:
    1. Helpers        small functions used everywhere
    2. App state      the loaded tasks and what the page is showing
    3. Storage        claude.ai database, or this browser's localStorage
    4. Sound          SoundPlayer class (Web Audio synth + uploaded file)
    5. Task actions   done, snooze, steps, delete
    6. Reminders      checking due tasks and showing pop-ups
    7. Focus timer
    8. Task form      shared by "New task" and "Edit task"
    9. Rendering      next move, to do, done, insights
   10. Dialogs        edit task, sounds
   11. Export to CSV  for the Python analysis in /analysis
   12. Theme & footer
   13. Start-up

   Design choices:
    - Every change goes through `store` (put / patch / remove), so the
      rest of the code doesn't care where data is saved.
    - render() redraws the page from `notes` after each change. That is
      simpler than editing single elements and fast enough for a few
      hundred notes.
    - User text is always set with textContent, never innerHTML, so a
      note can't inject HTML into the page.
   ============================================================= */
(function () {
  "use strict";

  const CONFIG = window.STICKY_CONFIG;
  if (!CONFIG) {
    document.body.prepend("Sticky Board couldn't load js/config.js. Check that the file sits next to index.html.");
    return;
  }

  /* ================= 1. HELPERS ================= */

  // Shorter way to write document.getElementById
  function byId(id) {
    return document.getElementById(id);
  }

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  /**
   * Creates an element with attributes and children in one call, e.g.
   *   createEl("button", { class: "btn", onclick: save }, "Save")
   * - "class" sets className, "text" sets textContent
   * - any attribute starting with "on" becomes an event listener
   * - null / false children are skipped, so you can write `cond ? x : null`
   * Text is always added as text (never as HTML), so a note can't inject markup.
   */
  function createEl(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  // Replaces everything inside `el`. Skips null/false entries and flattens arrays.
  function setChildren(el, ...children) {
    const kept = children.flat().filter((child) => child != null && child !== false);
    el.replaceChildren(...kept);
  }

  // Turns a list like [{ key: "high", ... }] into { high: { key: "high", ... } }
  // so we can look things up by key instead of searching the list every time.
  function indexByKey(list) {
    const index = {};
    for (const item of list) {
      index[item.key] = item;
    }
    return index;
  }

  const PRIORITY = indexByKey(CONFIG.priorities);
  const CATEGORY = indexByKey(CONFIG.categories);
  const SIZE = indexByKey(CONFIG.sizes);
  const COLOR = indexByKey(CONFIG.colors);
  const REMINDER = indexByKey(CONFIG.reminders);
  const categoryLabel = (key) => (CATEGORY[key] ? CATEGORY[key].label : key);
  const priorityOf = (n) => PRIORITY[n.priority] || PRIORITY[CONFIG.defaults.priority];

  // localStorage can throw (private windows, storage turned off), so every
  // call is wrapped in try/catch and the app keeps working without it.
  const safeStorage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        // nothing to do
      }
    },
  };

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const newId = () => "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function tiltFor(id) {
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return ((Math.abs(hash) % 7) - 3) * 0.6 + "deg";
  }

  function duration(ms) {
    const minutes = Math.round(Math.abs(ms) / MIN);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return minutes + " min";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return hours + " h" + (rest ? " " + rest + " min" : "");
    return plural(Math.round(hours / 24), "day");
  }

  function clockTime(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ", " + time;
  }

  function toInputValue(ts) {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * MIN);
    return d.toISOString().slice(0, 16);
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function formatMinutes(total) {
    if (total < 60) return total + " min";
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return hours + " h" + (rest ? " " + rest + " m" : "");
  }

  function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Turns a reminder choice into a timestamp. null = no reminder, NaN = invalid custom time. */
  function reminderTime(key, customValue) {
    const choice = REMINDER[key];
    if (!choice || key === "none") return null;
    const now = Date.now();
    if (choice.minutes) return now + choice.minutes * MIN;
    if (choice.at) {
      const d = new Date();
      d.setDate(d.getDate() + (choice.at.dayOffset || 0));
      d.setHours(choice.at.hour, choice.at.minute || 0, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    if (key === "custom") {
      const t = new Date(customValue).getTime();
      return isNaN(t) ? NaN : t;
    }
    return null;
  }

  /* ================= 2. APP STATE ================= */

  let notes = {};          // id -> task
  let store = null;        // where tasks are saved (see section 3)
  let loaded = false;
  const ui = { focusPick: null, confirmDelete: null, confirmArchive: false, editingId: null };
  const view = Object.assign({ priority: "all", category: "all", sort: "smart" }, safeStorage.get("sb.view", {}));
  const slipsOnScreen = new Set();
  const remindedThisVisit = new Set();

  const allNotes = () => Object.values(notes);
  const openNotes = () => allNotes().filter((n) => !n.done);
  const doneTodayCount = () => {
    const today = dayKey(Date.now());
    return allNotes().filter((n) => n.done && n.doneAt && dayKey(n.doneAt) === today).length;
  };

  /** Fills in missing fields so older saved tasks keep working. */
  const LEGACY_COLORS = { yellow: "canary", pink: "rose", green: "lime", blue: "aqua", orange: "tangerine" };
  function normalize(id, raw) {
    const color = LEGACY_COLORS[raw.color] || (COLOR[raw.color] ? raw.color : CONFIG.defaults.color);
    return {
      id,
      text: String(raw.text || ""),
      color,
      priority: PRIORITY[raw.priority] ? raw.priority : CONFIG.defaults.priority,
      category: raw.category || CONFIG.defaults.category,
      size: raw.size || CONFIG.defaults.size,
      steps: Array.isArray(raw.steps) ? raw.steps.filter((s) => s && s.t).map((s) => ({ t: String(s.t), d: !!s.d })) : [],
      createdAt: raw.createdAt || Date.now(),
      remindAt: raw.remindAt || null,
      firstRemindAt: raw.firstRemindAt || raw.remindAt || null,
      notified: !!raw.notified,
      snoozes: raw.snoozes || 0,
      done: !!raw.done,
      doneAt: raw.doneAt || null,
      archived: !!raw.archived,
      focusMin: raw.focusMin || 0,
    };
  }

  /* ================= 3. STORAGE =================
     Published on claude.ai, tasks go to the artifact's private database
     (only the signed-in person can read their own). Opened any other way,
     tasks are kept in this browser's localStorage. */

  function browserStore(onChange) {
    const KEY = "sb.notes";
    let data = safeStorage.get(KEY, null) || safeStorage.get("sticky-board-notes", {}) || {};
    const emit = () => {
      const out = {};
      for (const [id, n] of Object.entries(data)) out[id] = normalize(id, n);
      onChange(out);
    };
    const save = () => {
      if (!safeStorage.set(KEY, data)) toast({ title: "Not saved", text: "This browser is blocking storage, so changes will be lost when you close the page." });
    };
    setTimeout(emit, 0);
    return {
      put(n) { data[n.id] = n; save(); },
      patch(id, fields) { if (data[id]) { data[id] = Object.assign({}, data[id], fields); save(); } },
      remove(id) { delete data[id]; save(); },
    };
  }

  function databaseStore(db, userId, onChange) {
    const collection = db.collection("data/users/" + userId);
    const queues = {};
    // One write at a time per task, in order.
    const queue = (id, write) => {
      queues[id] = (queues[id] || Promise.resolve()).then(write).catch((err) => {
        if (err && err.code === "quota_exceeded") toast({ title: "Board is full", text: "Delete some done or archived notes to make room." });
        else toast({ title: "Not saved", text: "A change didn't save. Check your connection, then try again." });
      });
    };
    collection.onSnapshot(
      (snap) => {
        const next = {};
        snap.docs.forEach((doc) => {
          const body = doc.data();
          if (body && body.text != null) next[doc.id] = normalize(doc.id, body);
        });
        onChange(next);
      },
      () => setStorageNote("Live sync stopped. Reload the page to reconnect.")
    );
    return {
      put(n) { const body = Object.assign({}, n); delete body.id; queue(n.id, () => collection.doc(n.id).set(body)); },
      patch(id, fields) { queue(id, () => collection.doc(id).update(fields)); },
      remove(id) { queue(id, () => collection.doc(id).delete()); },
    };
  }

  /** Updates the page straight away, then saves in the background. */
  function withInstantUpdates(backing) {
    return {
      put(n) { notes[n.id] = n; render(); backing.put(n); },
      patch(id, fields) {
        if (!notes[id]) return;
        notes[id] = Object.assign({}, notes[id], fields);
        render();
        backing.patch(id, fields);
      },
      remove(id) { delete notes[id]; render(); backing.remove(id); },
    };
  }

  function setStorageNote(text) { byId("storageNote").textContent = text; }

  function onData(next) {
    const firstLoad = !loaded;
    notes = next;
    loaded = true;
    render();
    checkReminders();
    if (firstLoad) renderFocusBar();
    else tickTimer();
  }

  async function connectStorage() {
    let db = null;
    let userId = null;
    try {
      if (window.claude && typeof window.claude.use === "function") {
        const [dbApi, userApi] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
        db = dbApi;
        userId = userApi ? await userApi.id() : null;
      }
    } catch (e) { db = null; }

    if (db && userId) {
      store = withInstantUpdates(databaseStore(db, userId, onData));
      setStorageNote("Saved to your account. Only you can see these notes.");
    } else {
      store = withInstantUpdates(browserStore(onData));
      setStorageNote("Saved in this browser.");
    }
  }

  /* ================= 4. SOUND =================
     SoundPlayer plays every alert. The sounds are synthesised with the
     Web Audio API (oscillators + volume envelopes), so the project needs
     no audio files. The "recipes" for each sound live in config.js. */

  class SoundPlayer {
    constructor(config) {
      this.config = config;
      this.prefs = Object.assign({}, config.soundDefaults, safeStorage.get("sb.sound", {}));
      this.context = null;        // AudioContext, created after the first click
      this.customBuffer = null;   // the uploaded sound, decoded and ready to play
      this.customData = safeStorage.get("sb.customSound", null);   // upload as a data: URL
      this.customName = safeStorage.get("sb.customSoundName", "");
    }

    // Browsers block audio until the user interacts with the page,
    // so this runs on the first click / key press (and before playing).
    unlock() {
      try {
        if (!this.context) {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          this.context = new AudioContextClass();
        }
        if (this.context.state === "suspended") {
          this.context.resume();
        }
      } catch (e) {
        this.context = null;
      }
      this.decodeCustomSound();
      return this.context;
    }

    savePrefs() {
      safeStorage.set("sb.sound", this.prefs);
    }

    getCustomName() {
      if (!this.customData) return "";
      return this.customName || "Uploaded sound";
    }

    // Returns false if the browser wouldn't store the file (it still plays this visit).
    setCustomSound(dataUrl, name) {
      this.customData = dataUrl;
      this.customName = name;
      this.customBuffer = null;
      const saved = safeStorage.set("sb.customSound", dataUrl) && safeStorage.set("sb.customSoundName", name);
      this.decodeCustomSound();
      return saved;
    }

    removeCustomSound() {
      this.customData = null;
      this.customBuffer = null;
      this.customName = "";
      safeStorage.remove("sb.customSound");
      safeStorage.remove("sb.customSoundName");
      // Anything that was using the custom sound goes back to its default.
      for (const event of ["reminder", "urgent", "timer", "done"]) {
        if (this.prefs[event] === "custom") {
          this.prefs[event] = this.config.soundDefaults[event];
        }
      }
      this.savePrefs();
    }

    decodeCustomSound() {
      if (!this.customData || this.customBuffer || !this.context) return;
      try {
        // "data:audio/mpeg;base64,AAAA..." -> raw bytes -> AudioBuffer
        const base64 = this.customData.split(",")[1];
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
        this.context.decodeAudioData(
          bytes.buffer,
          (buffer) => { this.customBuffer = buffer; },
          () => { this.customBuffer = null; }
        );
      } catch (e) {
        this.customBuffer = null;
      }
    }

    // Plays one recipe from config.js. Returns its length in seconds.
    playRecipe(recipe, startOffset) {
      const ctx = this.context;
      const start = ctx.currentTime + 0.03 + startOffset;
      const master = ctx.createGain();
      master.gain.value = this.prefs.volume * (recipe.gain == null ? 1 : recipe.gain);
      master.connect(ctx.destination);

      let length = 0;
      for (const [frequency, at, noteLength] of recipe.notes || []) {
        length = Math.max(length, at + noteLength);
        for (const [ratio, loudness] of recipe.partials || [[1, 1]]) {
          const oscillator = ctx.createOscillator();
          const envelope = ctx.createGain();
          const noteStart = start + at;
          oscillator.type = recipe.wave || "sine";
          oscillator.frequency.value = frequency * ratio;
          // Fast fade in, then exponential fade out: sounds like a struck note.
          envelope.gain.setValueAtTime(0.0001, noteStart);
          envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.4 * loudness), noteStart + 0.012);
          envelope.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteLength);
          oscillator.connect(envelope).connect(master);
          oscillator.start(noteStart);
          oscillator.stop(noteStart + noteLength + 0.05);
        }
      }
      return length;
    }

    playCustom(startOffset) {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = this.customBuffer;
      gain.gain.value = this.prefs.volume;
      source.connect(gain).connect(this.context.destination);
      source.start(this.context.currentTime + 0.03 + startOffset);
      return Math.min(this.customBuffer.duration, 4);
    }

    // name: a key from config.sounds, or "custom". times: how many repeats.
    play(name, times = 1) {
      if (!this.unlock()) return;
      let offset = 0;
      for (let i = 0; i < times; i++) {
        let length;
        if (name === "custom" && this.customBuffer) {
          length = this.playCustom(offset);
        } else {
          const recipe = this.config.sounds[name] || this.config.sounds.chime;
          length = this.playRecipe(recipe, offset);
        }
        offset += length + 0.35;   // short gap between repeats
      }
    }

    // event: "reminder" | "timer" | "done". Urgent reminders use their own sound.
    playFor(event, priority) {
      if (event === "reminder" && priority === "urgent") {
        const repeats = this.prefs.repeatUrgent ? 3 : 1;
        this.play(this.prefs.urgent, repeats);
      } else {
        this.play(this.prefs[event]);
      }
    }
  }

  const sound = new SoundPlayer(CONFIG);
  document.addEventListener("pointerdown", () => sound.unlock(), { once: true });
  document.addEventListener("keydown", () => sound.unlock(), { once: true });

  /* ================= 5. TASK ACTIONS ================= */

  function addTask(fields) {
    const n = normalize(newId(), Object.assign({ createdAt: Date.now(), notified: false, snoozes: 0, done: false }, fields));
    n.firstRemindAt = n.remindAt;
    store.put(n);
  }

  function markDone(id) {
    const n = notes[id];
    if (!n || n.done) return;
    removeSlip(id);
    if (timer && timer.noteId === id && timer.kind === "focus") stopTimer(true);
    ui.focusPick = null;
    const finish = () => {
      store.patch(id, { done: true, doneAt: Date.now() });
      sound.playFor("done");
      const today = doneTodayCount();
      toast({ title: "Done · " + plural(today, "task") + " today", text: pick(CONFIG.celebrations), timeout: 4500 });
    };
    const card = document.querySelector('.note[data-id="' + id + '"]');
    if (card && !reducedMotion()) { card.classList.add("leaving"); setTimeout(finish, 230); }
    else finish();
  }

  function reopen(id) { store.patch(id, { done: false, doneAt: null, notified: true, archived: false }); }

  function snooze(id) {
    const n = notes[id];
    if (!n) return;
    removeSlip(id);
    store.patch(id, { remindAt: Date.now() + CONFIG.snoozeMinutes * MIN, notified: false, snoozes: n.snoozes + 1 });
  }

  function toggleStep(id, index) {
    const n = notes[id];
    if (!n || !n.steps[index]) return;
    const steps = n.steps.map((s, i) => (i === index ? { t: s.t, d: !s.d } : s));
    store.patch(id, { steps });
    if (steps.every((s) => s.d)) {
      toast({
        title: "Every step is ticked",
        text: "“" + n.text + "”. Mark the whole task done?",
        paper: n.color,
        actions: [{ label: "Mark done", solid: true, run: () => markDone(id) }],
      });
    }
  }

  function deleteTask(id) {
    ui.confirmDelete = null;
    removeSlip(id);
    if (timer && timer.noteId === id) stopTimer(false);
    store.remove(id);
  }

  function addExamples() {
    const now = Date.now();
    const examples = [
      { text: "Example: Finish problem set 3 (linear regression)", color: "canary", priority: "urgent", category: "assignment", size: "long",
        remindAt: now + 3 * HOUR, steps: [{ t: "Open the notebook", d: true }, { t: "Do questions 1–2", d: false }, { t: "Do questions 3–5", d: false }, { t: "Submit on Canvas", d: false }] },
      { text: "Example: Review lecture slides for the midterm", color: "aqua", priority: "high", category: "exam", size: "deep",
        remindAt: now + MIN, snoozes: 3, steps: [{ t: "Skim weeks 1–3", d: false }, { t: "Make a one-page formula sheet", d: false }] },
      { text: "Example: Email the TA about office hours", color: "rose", priority: "normal", category: "class", size: "tiny", remindAt: now + HOUR },
      { text: "Example: Do laundry", color: "lime", priority: "soft", category: "errand", size: "short", remindAt: null },
    ];
    examples.forEach((ex, i) => addTask(Object.assign({}, ex, { createdAt: now - (i + 1) * HOUR })));
  }

  /* ================= 6. REMINDERS & POP-UPS ================= */

  function checkReminders() {
    if (!loaded) return;
    const now = Date.now();
    for (const n of openNotes()) {
      if (!n.remindAt || n.remindAt > now) continue;
      if (!n.notified) {
        showReminder(n);
        store.patch(n.id, { notified: true });
        sound.playFor("reminder", n.priority);
        desktopNotify(n);
      } else if (!remindedThisVisit.has(n.id)) {
        // Came due while the page was closed: remind once per visit.
        showReminder(n);
      }
    }
  }

  function showReminder(n) {
    if (slipsOnScreen.has(n.id)) return;
    slipsOnScreen.add(n.id);
    remindedThisVisit.add(n.id);
    const firstStep = n.steps.find((s) => !s.d);
    const stuck = n.snoozes >= CONFIG.stuckAfterSnoozes;
    const quick = CONFIG.focusPresets[0];
    const slip = createEl("div", { class: "slip paper-bg", "data-slip": n.id, role: "alert", style: "--c: var(--paper-" + n.color + ")" },
      createEl("div", { class: "slip-kicker" + (n.priority === "urgent" ? " hot" : "") }, "Reminder · " + priorityOf(n).label + " · did you finish this?"),
      createEl("p", { class: "slip-text", text: n.text }),
      firstStep ? createEl("p", { class: "slip-line" }, "Start with: ", createEl("b", { text: firstStep.t })) : null,
      createEl("p", { class: "slip-line", text: stuck ? CONFIG.stuckMessage.replace("{n}", n.snoozes) : pick(CONFIG.nudges) }),
      createEl("div", { class: "slip-actions" },
        createEl("button", { class: "pbtn solid", type: "button", onclick: () => markDone(n.id) }, "Yes, done"),
        createEl("button", { class: "pbtn", type: "button", onclick: () => { removeSlip(n.id); startTimer(n.id, quick.minutes); } }, "Start " + quick.minutes + " min"),
        createEl("button", { class: "pbtn", type: "button", onclick: () => snooze(n.id) }, "Snooze " + CONFIG.snoozeMinutes + " min"),
        createEl("button", { class: "pbtn ghost", type: "button", onclick: () => removeSlip(n.id) }, "Dismiss")));
    byId("slips").append(slip);
  }

  function removeSlip(id) {
    slipsOnScreen.delete(id);
    const slip = document.querySelector('[data-slip="' + id + '"]');
    if (slip) slip.remove();
  }

  /** General pop-up for timers, celebrations and errors. */
  function toast({ title, text, actions = [], timeout = 0, paper = "canary" }) {
    const slip = createEl("div", { class: "slip paper-bg", role: "status", style: "--c: var(--paper-" + paper + ")" });
    const close = () => slip.remove();
    slip.append(
      createEl("div", { class: "slip-kicker", text: title }),
      text ? createEl("p", { class: "slip-line", text }) : null,
      createEl("div", { class: "slip-actions" },
        actions.map((a) => createEl("button", { class: "pbtn" + (a.solid ? " solid" : ""), type: "button", onclick: () => { close(); a.run(); } }, a.label)),
        createEl("button", { class: "pbtn ghost", type: "button", onclick: close }, actions.length ? "Not now" : "Close")));
    byId("slips").append(slip);
    if (timeout) setTimeout(close, timeout);
  }

  function desktopNotify(n) {
    if (!sound.prefs.desktop) return;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Reminder: " + n.text, { body: "Did you finish this? Open Sticky Board to mark it done or snooze it.", tag: n.id });
      }
    } catch (e) { /* not allowed here */ }
  }

  /* ================= 7. FOCUS TIMER ================= */

  let timer = safeStorage.get("sb.timer", null); // { noteId, kind: "focus"|"break", minutes, endsAt, pausedLeft }
  let timerInterval = null;

  const saveTimer = () => (timer ? safeStorage.set("sb.timer", timer) : safeStorage.remove("sb.timer"));
  const timeLeft = () => (timer.pausedLeft != null ? timer.pausedLeft : timer.endsAt - Date.now());

  function startTimer(noteId, minutes, kind = "focus") {
    if (timer) stopTimer(true);
    sound.unlock();
    timer = { noteId, kind, minutes, endsAt: Date.now() + minutes * MIN, pausedLeft: null };
    ui.focusPick = null;
    saveTimer();
    renderFocusBar();
    render();
  }

  /** Stops the timer. With credit, minutes already worked are added to the task. */
  function stopTimer(credit) {
    if (!timer) return;
    const t = timer;
    timer = null;
    saveTimer();
    if (credit && t.kind === "focus" && notes[t.noteId]) {
      const worked = Math.floor((t.minutes * MIN - Math.max(0, t.pausedLeft != null ? t.pausedLeft : t.endsAt - Date.now())) / MIN);
      if (worked >= 1) store.patch(t.noteId, { focusMin: notes[t.noteId].focusMin + worked });
    }
    renderFocusBar();
    render();
  }

  function togglePause() {
    if (!timer) return;
    if (timer.pausedLeft != null) { timer.endsAt = Date.now() + timer.pausedLeft; timer.pausedLeft = null; }
    else timer.pausedLeft = timer.endsAt - Date.now();
    saveTimer();
    renderFocusBar();
  }

  function addFiveMinutes() {
    if (!timer) return;
    if (timer.pausedLeft != null) timer.pausedLeft += 5 * MIN;
    else timer.endsAt += 5 * MIN;
    timer.minutes += 5;
    saveTimer();
    tickTimer();
  }

  function finishTimer() {
    const t = timer;
    const n = notes[t.noteId];
    timer = null;
    saveTimer();
    if (t.kind === "focus" && n) store.patch(n.id, { focusMin: n.focusMin + t.minutes });
    sound.playFor("timer");
    renderFocusBar();
    render();
    const open = n && !n.done;
    if (t.kind === "focus") {
      toast({
        title: "Focus session done · " + t.minutes + " min",
        text: n ? "Nice work on “" + n.text + "”. Finished, or another round?" : "Nice work.",
        paper: n ? n.color : "canary",
        actions: open ? [
          { label: "Mark done", solid: true, run: () => markDone(n.id) },
          { label: "Another " + t.minutes + " min", run: () => startTimer(n.id, t.minutes) },
          { label: CONFIG.breakMinutes + " min break", run: () => startTimer(n.id, CONFIG.breakMinutes, "break") },
        ] : [],
      });
    } else {
      toast({
        title: "Break's over",
        text: open ? "Ready to get back to “" + n.text + "”?" : "Ready for the next task?",
        actions: open ? [{ label: "Focus 25 min", solid: true, run: () => startTimer(n.id, 25) }] : [],
      });
    }
  }

  function tickTimer() {
    if (!timer) { clearInterval(timerInterval); timerInterval = null; updateTitle(); return; }
    if (!timerInterval) timerInterval = setInterval(tickTimer, 1000);
    const left = timeLeft();
    if (left <= 0) { if (loaded) finishTimer(); return; }
    const timeEl = byId("focusTime");
    if (timeEl) timeEl.textContent = mmss(left);
    const bar = byId("focusProgress");
    if (bar) bar.style.width = (100 - (left / (timer.minutes * MIN)) * 100).toFixed(2) + "%";
    updateTitle();
  }

  function renderFocusBar() {
    const bar = byId("focusBar");
    if (!timer) { bar.hidden = true; bar.replaceChildren(); tickTimer(); return; }
    const n = notes[timer.noteId];
    const paused = timer.pausedLeft != null;
    const label = timer.kind === "break" ? "On a break" : paused ? "Paused" : "Focusing on";
    bar.hidden = false;
    bar.replaceChildren(
      createEl("div", { class: "focus-time", id: "focusTime", "aria-live": "off" }, mmss(timeLeft())),
      createEl("div", { class: "focus-what" },
        createEl("span", { class: "label", text: label }),
        createEl("div", { class: "focus-task", text: timer.kind === "break" ? "Stretch, drink water, look away from the screen" : n ? n.text : "Your task" })),
      createEl("div", { class: "row" },
        createEl("button", { class: "btn small", type: "button", id: "timerPause", onclick: togglePause }, paused ? "Resume" : "Pause"),
        createEl("button", { class: "btn small ghost", type: "button", id: "timerPlus", onclick: addFiveMinutes }, "+5 min"),
        timer.kind === "focus" && n && !n.done ? createEl("button", { class: "btn small primary", type: "button", id: "timerDone", onclick: () => markDone(n.id) }, "Mark done") : null,
        createEl("button", { class: "btn small ghost", type: "button", id: "timerStop", onclick: () => stopTimer(true) }, "Stop")),
      createEl("div", { class: "focus-progress", id: "focusProgress" }));
    tickTimer();
  }

  function updateTitle() {
    const overdue = openNotes().filter((n) => n.remindAt && n.remindAt <= Date.now()).length;
    let title = "Sticky Board";
    if (overdue) title = "(" + overdue + ") " + title;
    if (timer) title = mmss(timeLeft()) + " · " + title;
    document.title = title;
  }

  /* ================= 8. TASK FORM =================
     Builds the priority / category / size / reminder / colour fields.
     Used for both the New task pad and the Edit task dialog. */

  function taskFields(prefix, values, onColorChange) {
    const wrap = createEl("div", { class: "fields" });

    // Priority
    const hint = createEl("p", { class: "field-hint", text: priorityOf(values).hint });
    const segmented = createEl("div", { class: "segmented" });
    CONFIG.priorities.forEach((p) => {
      const id = prefix + "-priority-" + p.key;
      const input = createEl("input", { type: "radio", name: prefix + "-priority", id, value: p.key });
      input.checked = p.key === values.priority;
      segmented.append(input, createEl("label", { for: id, title: p.hint }, createEl("span", { class: "dot dot-" + p.key, "aria-hidden": "true" }), p.label));
    });
    segmented.addEventListener("change", (e) => { hint.textContent = PRIORITY[e.target.value].hint; });
    wrap.append(createEl("fieldset", { class: "field wide" }, createEl("legend", { class: "label" }, "Priority"), segmented, hint));

    // Category and size
    const select = (id, list, current) => {
      const el = createEl("select", { id });
      list.forEach((item) => el.append(createEl("option", { value: item.key }, item.label)));
      if (!list.some((item) => item.key === current)) el.append(createEl("option", { value: current }, current));
      el.value = current;
      return el;
    };
    const category = select(prefix + "-category", CONFIG.categories, values.category);
    const size = select(prefix + "-size", CONFIG.sizes, values.size);
    wrap.append(
      createEl("div", { class: "field" }, createEl("label", { class: "label", for: category.id }, "Category"), category),
      createEl("div", { class: "field" }, createEl("label", { class: "label", for: size.id }, "How long will it take?"), size));

    // Reminder
    const reminderOptions = CONFIG.reminders.slice();
    if (values.remindAt) reminderOptions.unshift({ key: "keep", label: "Keep: " + clockTime(values.remindAt) });
    const reminder = select(prefix + "-reminder", reminderOptions, values.remindAt ? "keep" : values.reminder || CONFIG.defaults.reminder);
    const custom = createEl("input", { type: "datetime-local", id: prefix + "-reminder-at" });
    custom.value = toInputValue(values.remindAt || Date.now() + 2 * HOUR);
    custom.hidden = reminder.value !== "custom";
    reminder.addEventListener("change", () => { custom.hidden = reminder.value !== "custom"; });
    wrap.append(createEl("div", { class: "field" }, createEl("label", { class: "label", for: reminder.id }, "Remind me"), reminder, custom));

    // Colour
    const swatches = createEl("div", { class: "swatches" });
    CONFIG.colors.forEach((c) => {
      const id = prefix + "-color-" + c.key;
      const input = createEl("input", { type: "radio", name: prefix + "-color", id, value: c.key });
      input.checked = c.key === values.color;
      swatches.append(input, createEl("label", { for: id, title: c.label, style: "--c: var(--paper-" + c.key + ")" }, createEl("span", { class: "sr-only", text: c.label })));
    });
    swatches.addEventListener("change", (e) => { if (onColorChange) onColorChange(e.target.value); });
    wrap.append(createEl("fieldset", { class: "field" }, createEl("legend", { class: "label" }, "Note colour"), swatches));

    return {
      el: wrap,
      read() {
        const checked = (name) => { const el = wrap.querySelector('input[name="' + prefix + "-" + name + '"]:checked'); return el ? el.value : null; };
        const key = reminder.value;
        const remindAt = key === "keep" ? values.remindAt : reminderTime(key, custom.value);
        return {
          priority: checked("priority") || CONFIG.defaults.priority,
          color: checked("color") || CONFIG.defaults.color,
          category: category.value,
          size: size.value,
          remindAt,
          reminderKey: key,
          invalidReminder: Number.isNaN(remindAt),
          focusCustom: () => custom.focus(),
        };
      },
    };
  }

  const parseSteps = (text, previous = []) => {
    const doneByText = Object.fromEntries(previous.map((s) => [s.t, s.d]));
    return text.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean).slice(0, 12)
      .map((t) => ({ t, d: !!doneByText[t] }));
  };

  let composerForm = null;
  const composerValues = Object.assign({}, CONFIG.defaults, safeStorage.get("sb.lastChoices", {}));

  function buildComposer() {
    const pad = byId("composerPad");
    pad.style.setProperty("--c", "var(--paper-" + composerValues.color + ")");
    composerForm = taskFields("new", composerValues, (color) => pad.style.setProperty("--c", "var(--paper-" + color + ")"));
    byId("composerFields").append(composerForm.el);
    byId("composer").addEventListener("submit", (e) => { e.preventDefault(); submitComposer(); });
    for (const id of ["newText", "newSteps"]) {
      byId(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComposer(); }
      });
    }
  }

  function submitComposer() {
    sound.unlock();
    const text = byId("newText").value.trim();
    if (!text) { byId("newText").focus(); return; }
    if (!store) return;
    const v = composerForm.read();
    if (v.invalidReminder) { v.focusCustom(); return; }
    addTask({ text, steps: parseSteps(byId("newSteps").value), priority: v.priority, color: v.color, category: v.category, size: v.size, remindAt: v.remindAt });
    safeStorage.set("sb.lastChoices", { priority: v.priority, color: v.color, category: v.category, size: v.size, reminder: v.reminderKey === "custom" ? CONFIG.defaults.reminder : v.reminderKey });
    byId("newText").value = "";
    byId("newSteps").value = "";
    byId("newText").focus();
  }

  /* ================= 9. RENDERING ================= */

  function urgencyScore(n, now) {
    let score = priorityOf(n).weight * 10;
    if (n.remindAt) {
      const left = n.remindAt - now;
      if (left <= 0) score += 15;
      else if (left < HOUR) score += 8;
      else if (left < 6 * HOUR) score += 4;
    }
    score += Math.min(n.snoozes, 5) * 3;
    if (n.size === "tiny") score += 4;
    return score;
  }

  const SORTS = {
    smart:    { label: "Next move first", compare: (a, b, now) => urgencyScore(b, now) - urgencyScore(a, now) },
    due:      { label: "Reminder time",   compare: (a, b) => (a.remindAt || Infinity) - (b.remindAt || Infinity) },
    priority: { label: "Priority",        compare: (a, b) => priorityOf(b).weight - priorityOf(a).weight },
    newest:   { label: "Newest first",    compare: (a, b) => b.createdAt - a.createdAt },
  };

  /** Re-draws everything. Keeps keyboard focus on the same control. */
  function render(includeInsights = true) {
    const focusedId = document.activeElement && document.activeElement.id;
    const now = Date.now();
    renderTally(now);
    renderNextMove(now);
    renderFilters();
    renderBoard(now);
    renderDone();
    if (includeInsights) renderInsights(now);
    updateTitle();
    if (focusedId && document.activeElement === document.body && byId(focusedId)) byId(focusedId).focus();
  }

  function renderTally(now) {
    const open = openNotes();
    const overdue = open.filter((n) => n.remindAt && n.remindAt <= now).length;
    const pill = (num, label, alert) => createEl("span", { class: "pill" + (alert ? " alert" : "") }, createEl("b", {}, String(num)), " " + label);
    setChildren(byId("tally"),
      pill(open.length, "to do"),
      overdue ? pill(overdue, "overdue", true) : null,
      pill(doneTodayCount(), "done today"));
  }

  function whyList(n, now) {
    const items = [{ text: priorityOf(n).label + " priority", hot: n.priority === "urgent" }];
    if (n.remindAt) {
      const left = n.remindAt - now;
      if (left <= 0) items.push({ text: "Overdue by " + duration(left), hot: true });
      else items.push({ text: "Due in " + duration(left) });
    }
    if (n.snoozes) items.push({ text: "Snoozed " + plural(n.snoozes, "time"), hot: n.snoozes >= CONFIG.stuckAfterSnoozes });
    if (n.size === "tiny") items.push({ text: "Takes 2 minutes: do it now" });
    return createEl("ul", { class: "why" }, items.map((it) => createEl("li", { class: it.hot ? "hot" : null, text: it.text })));
  }

  function streakDays() {
    const days = new Set(allNotes().filter((n) => n.done && n.doneAt).map((n) => dayKey(n.doneAt)));
    let streak = 0;
    let cursor = Date.now();
    if (!days.has(dayKey(cursor))) cursor -= DAY; // today isn't over yet
    while (days.has(dayKey(cursor))) { streak++; cursor -= DAY; }
    return streak;
  }

  function renderNextMove(now) {
    const box = byId("nextMove");
    if (!loaded) { box.replaceChildren(createEl("div", { class: "next-empty" }, createEl("p", { class: "hint", text: "Loading your notes…" }))); return; }
    const open = openNotes();
    const stats = createEl("p", { class: "next-stats" }, plural(doneTodayCount(), "task") + " done today · " + plural(streakDays(), "day") + " streak");
    if (!open.length) {
      box.replaceChildren(createEl("div", { class: "next-empty" },
        createEl("span", { class: "label", text: "Your next move" }),
        createEl("p", { text: allNotes().length ? "Nothing waiting. Enjoy the break, or add the next task below." : "Add your first task below. This spot will always show the one task to start with." }),
        stats));
      return;
    }
    const n = open.slice().sort((a, b) => urgencyScore(b, now) - urgencyScore(a, now))[0];
    const firstStep = n.steps.find((s) => !s.d);
    const presets = CONFIG.focusPresets;
    const shortest = presets[0];
    const pomodoro = presets.find((p) => p.minutes === 25) || presets[presets.length - 1];
    box.replaceChildren(
      createEl("div", { class: "mini-note paper-bg", style: "--c: var(--paper-" + n.color + ")" },
        createEl("div", { class: "note-top" },
          createEl("span", { class: "note-cat", text: categoryLabel(n.category) }),
          createEl("span", { class: "stamp stamp-" + n.priority, text: priorityOf(n).label })),
        createEl("p", { class: "note-text", text: n.text })),
      createEl("div", { class: "next-info" },
        createEl("span", { class: "label", text: "Your next move" }),
        whyList(n, now),
        firstStep
          ? createEl("p", { class: "first-step" }, "First step: ", createEl("b", { text: firstStep.t }))
          : createEl("p", { class: "first-step" }, "Not sure where to start? ",
              createEl("button", { class: "btn small ghost", type: "button", id: "nextBreakDown", onclick: () => openEdit(n.id) }, "Break it into steps")),
        createEl("div", { class: "row" },
          createEl("button", { class: "btn primary", type: "button", id: "nextQuick", onclick: () => startTimer(n.id, shortest.minutes) }, shortest.label + " · " + shortest.minutes + " min"),
          createEl("button", { class: "btn", type: "button", id: "nextPomodoro", onclick: () => startTimer(n.id, pomodoro.minutes) }, pomodoro.label + " · " + pomodoro.minutes + " min"),
          createEl("button", { class: "btn ghost", type: "button", id: "nextDone", onclick: () => markDone(n.id) }, "Mark done")),
        stats));
  }

  function renderFilters() {
    const open = openNotes();
    const chip = (key, label, count, dotClass) => createEl("button", {
      class: "chip-btn", type: "button", id: "filter-" + key, "aria-pressed": String(view.priority === key),
      onclick: () => { view.priority = key; safeStorage.set("sb.view", view); render(false); },
    }, dotClass ? createEl("span", { class: "dot " + dotClass, "aria-hidden": "true" }) : null, label, createEl("span", { class: "n", text: String(count) }));
    setChildren(byId("priorityChips"),
      chip("all", "All", open.length),
      CONFIG.priorities.map((p) => chip(p.key, p.label, open.filter((n) => n.priority === p.key).length, "dot-" + p.key)));
  }

  function setupFilterSelects() {
    const cat = byId("categoryFilter");
    cat.append(createEl("option", { value: "all" }, "All"));
    CONFIG.categories.forEach((c) => cat.append(createEl("option", { value: c.key }, c.label)));
    cat.value = CATEGORY[view.category] ? view.category : "all";
    cat.addEventListener("change", () => { view.category = cat.value; safeStorage.set("sb.view", view); render(false); });

    const sort = byId("sortSelect");
    Object.entries(SORTS).forEach(([key, s]) => sort.append(createEl("option", { value: key }, s.label)));
    sort.value = SORTS[view.sort] ? view.sort : "smart";
    sort.addEventListener("change", () => { view.sort = sort.value; safeStorage.set("sb.view", view); render(false); });
  }

  function renderBoard(now) {
    const box = byId("todo");
    const open = openNotes();
    const shown = open
      .filter((n) => view.priority === "all" || n.priority === view.priority)
      .filter((n) => view.category === "all" || n.category === view.category)
      .sort((a, b) => (SORTS[view.sort] || SORTS.smart).compare(a, b, now));
    byId("todoCount").textContent = open.length ? plural(open.length, "task") : "";

    if (!loaded) { box.replaceChildren(createEl("div", { class: "empty" }, createEl("p", { text: "Loading your notes…" }))); return; }
    if (!open.length) {
      box.replaceChildren(createEl("div", { class: "empty" },
        createEl("p", { text: allNotes().length
          ? "Everything is done. Write the next task on the pad above."
          : "Your board is empty. Write a task on the pad above and press Stick note. Each note reminds you when it's due and moves to Done when you finish it." }),
        allNotes().length ? null : createEl("button", { class: "btn small", type: "button", id: "addExamples", onclick: addExamples }, "Add example notes")));
      return;
    }
    if (!shown.length) {
      box.replaceChildren(createEl("div", { class: "empty" },
        createEl("p", { text: "No tasks match these filters." }),
        createEl("button", { class: "btn small", type: "button", id: "clearFilters", onclick: () => {
          view.priority = "all"; view.category = "all"; byId("categoryFilter").value = "all"; safeStorage.set("sb.view", view); render(false);
        } }, "Show all tasks")));
      return;
    }
    box.replaceChildren(createEl("div", { class: "board" }, shown.map((n) => noteCard(n, now))));
  }

  function reminderTag(n, now) {
    if (!n.remindAt) return createEl("span", { class: "tag", text: "No reminder" });
    const left = n.remindAt - now;
    if (left <= 0) return createEl("span", { class: "tag overdue", text: "Overdue " + duration(left) });
    if (left < HOUR) return createEl("span", { class: "tag soon", text: "Due in " + duration(left) });
    return createEl("span", { class: "tag", text: "Due " + clockTime(n.remindAt) });
  }

  function noteCard(n, now) {
    const overdue = n.remindAt && n.remindAt <= now;
    const timing = timer && timer.noteId === n.id;
    const card = createEl("article", { class: "note" + (overdue ? " due" : "") + (timing ? " timing" : ""), "data-id": n.id, style: "--tilt: " + tiltFor(n.id) });
    const paper = createEl("div", { class: "paper", style: "--c: var(--paper-" + n.color + ")" });
    card.append(paper);

    paper.append(
      createEl("div", { class: "note-top" },
        createEl("span", { class: "note-cat", text: categoryLabel(n.category) }),
        createEl("span", { class: "stamp stamp-" + n.priority, text: priorityOf(n).label })),
      createEl("p", { class: "note-text", text: n.text }));

    if (n.steps.length) {
      const doneSteps = n.steps.filter((s) => s.d).length;
      paper.append(
        createEl("ul", { class: "steps" }, n.steps.map((step, i) => {
          const id = "step-" + n.id + "-" + i;
          const box = createEl("input", { type: "checkbox", id });
          box.checked = step.d;
          box.addEventListener("change", () => toggleStep(n.id, i));
          return createEl("li", { class: step.d ? "is-checked" : null }, box, createEl("label", { for: id, text: step.t }));
        })),
        createEl("div", { class: "step-progress" },
          createEl("div", { class: "step-track" }, createEl("div", { class: "step-fill", style: "width: " + Math.round((doneSteps / n.steps.length) * 100) + "%" })),
          doneSteps + " of " + n.steps.length));
    }

    if (n.snoozes >= CONFIG.stuckAfterSnoozes) paper.append(createEl("p", { class: "nudge", text: CONFIG.stuckMessage.replace("{n}", n.snoozes) }));

    paper.append(createEl("div", { class: "note-meta" },
      reminderTag(n, now),
      SIZE[n.size] ? createEl("span", { class: "tag", text: SIZE[n.size].label }) : null,
      n.focusMin ? createEl("span", { class: "tag", text: formatMinutes(n.focusMin) + " focused" }) : null,
      timing ? createEl("span", { class: "tag good", text: "Timer running" }) : null));

    const btn = (label, id, onclick, cls) => createEl("button", { class: "pbtn" + (cls ? " " + cls : ""), type: "button", id: id + "-" + n.id, onclick }, label);
    let actions;
    if (ui.confirmDelete === n.id) {
      actions = [btn("Delete for good", "del-yes", () => deleteTask(n.id), "danger"), btn("Keep", "del-no", () => { ui.confirmDelete = null; render(false); })];
    } else if (ui.focusPick === n.id) {
      actions = CONFIG.focusPresets.map((p) => btn(p.minutes + " min", "focus-" + p.minutes, () => startTimer(n.id, p.minutes)))
        .concat(btn("Cancel", "focus-cancel", () => { ui.focusPick = null; render(false); }, "ghost"));
    } else {
      actions = [
        btn("✓ Done", "done", () => markDone(n.id), "solid"),
        btn("Focus", "focus", () => { ui.focusPick = n.id; ui.confirmDelete = null; render(false); }),
        btn("Edit", "edit", () => openEdit(n.id)),
        btn("Delete", "delete", () => { ui.confirmDelete = n.id; ui.focusPick = null; render(false); }),
      ];
    }
    paper.append(createEl("div", { class: "note-actions" }, actions), createEl("div", { class: "note-foot", text: "Written " + clockTime(n.createdAt) }));
    return card;
  }

  function renderDone() {
    const done = allNotes().filter((n) => n.done && !n.archived).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    byId("doneCount").textContent = done.length ? done.length + " finished" : "";
    const controls = byId("archiveControls");
    if (!done.length) {
      controls.replaceChildren();
      byId("done").replaceChildren(createEl("p", { class: "hint", text: "Finished tasks land here, crossed off. Press Done on any note to move it." }));
      return;
    }
    if (ui.confirmArchive) {
      controls.replaceChildren(
        createEl("span", { class: "hint", text: "Archive " + plural(done.length, "note") + "? They leave this tray but still count in Insights." }),
        createEl("button", { class: "btn small", type: "button", id: "archiveYes", onclick: () => { ui.confirmArchive = false; done.forEach((n) => store.patch(n.id, { archived: true })); } }, "Archive"),
        createEl("button", { class: "btn small ghost", type: "button", id: "archiveNo", onclick: () => { ui.confirmArchive = false; render(false); } }, "Cancel"));
    } else {
      controls.replaceChildren(createEl("button", { class: "btn small ghost", type: "button", id: "archiveAsk", onclick: () => { ui.confirmArchive = true; render(false); } }, "Archive all"));
    }
    byId("done").replaceChildren(createEl("div", { class: "board" }, done.map(doneCard)));
  }

  function doneCard(n) {
    const beat = n.firstRemindAt && n.doneAt && n.doneAt <= n.firstRemindAt;
    return createEl("article", { class: "note is-done", "data-id": n.id },
      createEl("div", { class: "paper", style: "--c: var(--paper-" + n.color + ")" },
        createEl("div", { class: "note-top" },
          createEl("span", { class: "note-cat", text: categoryLabel(n.category) }),
          createEl("span", { class: "stamp stamp-done", text: "Done" })),
        createEl("p", { class: "note-text", text: n.text }),
        createEl("div", { class: "note-meta" },
          n.doneAt ? createEl("span", { class: "tag", text: clockTime(n.doneAt) }) : null,
          n.doneAt ? createEl("span", { class: "tag", text: "Took " + duration(n.doneAt - n.createdAt) }) : null,
          beat ? createEl("span", { class: "tag good", text: "Beat the reminder" }) : null),
        createEl("div", { class: "note-actions" },
          createEl("button", { class: "pbtn", type: "button", id: "reopen-" + n.id, onclick: () => reopen(n.id) }, "Move back"),
          createEl("button", { class: "pbtn danger", type: "button", id: "remove-" + n.id, onclick: () => store.remove(n.id) }, "Delete"))));
  }

  /* ----- Insights: simple descriptive stats on your own tasks ----- */

  function renderInsights(now) {
    const box = byId("insights");
    const all = allNotes();
    const done = all.filter((n) => n.done && n.doneAt);
    if (!loaded) { box.replaceChildren(); return; }
    if (!done.length) {
      box.replaceChildren(createEl("div", { class: "empty" }, createEl("p", { text: "Finish a few tasks and your patterns show up here: your streak, how often you beat your reminders, and which kinds of tasks you put off most." })));
      return;
    }

    // Headline numbers
    const withReminder = done.filter((n) => n.firstRemindAt);
    const beat = withReminder.filter((n) => n.doneAt <= n.firstRemindAt).length;
    const beatRate = withReminder.length ? Math.round((beat / withReminder.length) * 100) + "%" : "–";
    const focusTotal = all.reduce((sum, n) => sum + n.focusMin, 0);
    const streak = streakDays();
    const kpi = (label, value, sub) => createEl("div", { class: "kpi" }, createEl("span", { class: "label", text: label }), createEl("span", { class: "value", text: value }), createEl("span", { class: "sub", text: sub }));

    // Tasks finished per day, last 14 days
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * DAY);
      days.push({ key: dayKey(d.getTime()), date: d, count: 0 });
    }
    const index = Object.fromEntries(days.map((d, i) => [d.key, i]));
    done.forEach((n) => { const i = index[dayKey(n.doneAt)]; if (i != null) days[i].count++; });
    const max = Math.max(1, ...days.map((d) => d.count));
    const total14 = days.reduce((s, d) => s + d.count, 0);
    const plot = createEl("div", { class: "plot", role: "img", "aria-label": total14 + " tasks finished in the last 14 days, most in one day: " + max });
    plot.append(createEl("div", { class: "gridline", style: "bottom: 100%" }, createEl("span", { text: String(max) })));
    plot.append(createEl("div", { class: "gridline", style: "bottom: 50%" }, createEl("span", { text: max >= 2 ? String(Math.round(max / 2 * 10) / 10) : "" })));
    days.forEach((d, i) => {
      const isToday = i === days.length - 1;
      const label = (isToday ? "Today" : d.date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) + ": " + plural(d.count, "task");
      plot.append(createEl("div", { class: "col" + (isToday ? " today" : ""), tabindex: "0", "data-tip": label, "aria-label": label },
        createEl("div", { class: "bar", style: "height: " + (d.count / max) * 100 + "%" })));
    });
    const xlabels = createEl("div", { class: "xlabels", "aria-hidden": "true" },
      days.map((d, i) => createEl("span", { class: i === days.length - 1 ? "today" : null, text: String(d.date.getDate()) })));

    // Snoozes per task, by category (where you procrastinate most)
    const byCat = {};
    all.forEach((n) => {
      byCat[n.category] = byCat[n.category] || { tasks: 0, snoozes: 0 };
      byCat[n.category].tasks++;
      byCat[n.category].snoozes += n.snoozes;
    });
    const cats = Object.entries(byCat).map(([key, v]) => ({ key, avg: v.snoozes / v.tasks, tasks: v.tasks })).sort((a, b) => b.avg - a.avg);
    const maxAvg = Math.max(0.01, ...cats.map((c) => c.avg));
    const anySnoozes = cats.some((c) => c.avg > 0);

    // Plain-language findings
    const findings = [];
    if (anySnoozes && cats[0].avg >= 1) findings.push(categoryLabel(cats[0].key) + " tasks get snoozed most (" + cats[0].avg.toFixed(1) + " times each on average). Try breaking the next one into smaller steps.");
    const medianMs = median(done.map((n) => n.doneAt - n.createdAt));
    if (medianMs != null) findings.push("Median time from writing a task to finishing it: " + duration(medianMs) + ".");
    if (done.length >= 5) {
      const weekdays = [0, 0, 0, 0, 0, 0, 0];
      done.forEach((n) => weekdays[new Date(n.doneAt).getDay()]++);
      const best = weekdays.indexOf(Math.max(...weekdays));
      const name = new Date(2024, 0, 7 + best).toLocaleDateString([], { weekday: "long" });
      findings.push("You finish the most tasks on " + name + "s.");
    }
    const stepped = done.filter((n) => n.steps.length);
    if (stepped.length >= 2 && done.length - stepped.length >= 2) {
      const avgSnooze = (list) => list.reduce((s, n) => s + n.snoozes, 0) / list.length;
      const a = avgSnooze(stepped);
      const b = avgSnooze(done.filter((n) => !n.steps.length));
      if (a < b) findings.push("Tasks you broke into steps were snoozed less (" + a.toFixed(1) + " vs " + b.toFixed(1) + " times).");
    }

    setChildren(box,
      createEl("div", { class: "kpis" },
        kpi("Done today", String(doneTodayCount()), plural(done.length, "task") + " finished in total"),
        kpi("Streak", plural(streak, "day"), streak ? "In a row with at least one task done" : "Finish one today to start a streak"),
        kpi("Beat the reminder", beatRate, withReminder.length ? beat + " of " + withReminder.length + " done before the first reminder" : "No reminders set yet"),
        kpi("Focus time", formatMinutes(focusTotal), "Logged with the focus timer")),
      createEl("div", { class: "insight-grid" },
        createEl("div", { class: "panel" },
          createEl("h3", { text: "Tasks finished per day" }),
          createEl("p", { class: "hint", text: "Last 14 days. Today is highlighted. Hover or tab to a bar for the count." }),
          plot, xlabels),
        createEl("div", { class: "panel" },
          createEl("h3", { text: "Average snoozes per task" }),
          createEl("p", { class: "hint", text: "By category. Higher means it gets put off more." }),
          anySnoozes
            ? createEl("div", { class: "hbars" }, cats.map((c) => createEl("div", { class: "hbar" },
                createEl("span", { class: "name", text: categoryLabel(c.key) }),
                createEl("div", { class: "track" }, createEl("div", { class: "fill", style: "width: " + (c.avg / maxAvg) * 100 + "%" })),
                createEl("span", { class: "val", text: c.avg.toFixed(1) + "×" }))))
            : createEl("p", { class: "hint", text: "No snoozes yet. Nice." }))),
      findings.length ? createEl("ul", { class: "findings" }, findings.map((f) => createEl("li", { text: f }))) : null);
  }

  /* ================= 10. DIALOGS ================= */

  let editForm = null;

  function openEdit(id) {
    const n = notes[id];
    if (!n) return;
    ui.editingId = id;
    byId("editText").value = n.text;
    byId("editSteps").value = n.steps.map((s) => s.t).join("\n");
    const pad = byId("editPad");
    pad.style.setProperty("--c", "var(--paper-" + n.color + ")");
    editForm = taskFields("edit", n, (color) => pad.style.setProperty("--c", "var(--paper-" + color + ")"));
    byId("editFields").replaceChildren(editForm.el);
    byId("editDialog").showModal();
    byId("editText").focus();
  }

  function saveEdit(e) {
    e.preventDefault();
    const n = notes[ui.editingId];
    if (!n) { byId("editDialog").close(); return; }
    const text = byId("editText").value.trim();
    if (!text) { byId("editText").focus(); return; }
    const v = editForm.read();
    if (v.invalidReminder) { v.focusCustom(); return; }
    const reminderChanged = v.remindAt !== n.remindAt;
    store.patch(n.id, {
      text,
      steps: parseSteps(byId("editSteps").value, n.steps),
      priority: v.priority, color: v.color, category: v.category, size: v.size,
      remindAt: v.remindAt,
      notified: reminderChanged ? false : n.notified,
      firstRemindAt: n.firstRemindAt || v.remindAt,
    });
    if (reminderChanged) removeSlip(n.id);
    byId("editDialog").close();
  }

  // The four moments that can each have their own sound.
  const SOUND_EVENTS = [
    { key: "reminder", label: "Reminder" },
    { key: "urgent", label: "Urgent reminder" },
    { key: "timer", label: "Focus timer ends" },
    { key: "done", label: "Task completed" },
  ];

  function soundOptions() {
    const options = [];
    for (const [key, recipe] of Object.entries(CONFIG.sounds)) {
      options.push({ key: key, label: recipe.label });
    }
    if (sound.getCustomName()) {
      options.push({ key: "custom", label: "Your sound: " + sound.getCustomName() });
    }
    return options;
  }

  function soundRow(event, options) {
    const id = "sound-" + event.key;
    const select = createEl("select", { id: id });
    for (const option of options) {
      select.append(createEl("option", { value: option.key }, option.label));
    }
    // Use the saved choice if it still exists, otherwise the default from config.js
    const saved = sound.prefs[event.key];
    const savedStillExists = options.some((option) => option.key === saved);
    select.value = savedStillExists ? saved : CONFIG.soundDefaults[event.key];

    select.addEventListener("change", () => {
      sound.prefs[event.key] = select.value;
      sound.savePrefs();
      sound.play(select.value);
    });

    const previewButton = createEl("button", { class: "btn small", type: "button", id: "preview-" + event.key }, "Play");
    previewButton.addEventListener("click", () => {
      const repeats = event.key === "urgent" && sound.prefs.repeatUrgent ? 3 : 1;
      sound.play(select.value, repeats);
    });

    return createEl("div", { class: "sound-row" },
      createEl("label", { for: id }, createEl("span", { text: event.label })),
      select,
      previewButton);
  }

  function renderSoundRows() {
    const options = soundOptions();
    setChildren(byId("soundRows"), SOUND_EVENTS.map((event) => soundRow(event, options)));

    const customName = sound.getCustomName();
    byId("customRemove").hidden = !customName;
    if (customName) {
      byId("customStatus").textContent = "Using “" + customName + "”. Pick “Your sound” in any list above.";
    } else {
      byId("customStatus").textContent = "Upload a short MP3, WAV or M4A under 1 MB. It's saved in this browser.";
    }
  }

  function openSoundDialog() {
    sound.unlock();
    renderSoundRows();
    byId("soundVolume").value = sound.prefs.volume;
    byId("repeatUrgent").checked = Boolean(sound.prefs.repeatUrgent);
    const notificationsAllowed = "Notification" in window && Notification.permission === "granted";
    byId("desktopNotify").checked = Boolean(sound.prefs.desktop) && notificationsAllowed;
    byId("soundDialog").showModal();
  }

  function handleCustomSoundUpload(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      byId("customStatus").textContent = "That file is over 1 MB. Trim it or pick a shorter sound.";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const saved = sound.setCustomSound(reader.result, file.name);
      renderSoundRows();
      if (!saved) {
        byId("customStatus").textContent = "Loaded “" + file.name + "” for this visit only. This browser wouldn't save it.";
      }
      input.value = "";
    };
    reader.onerror = () => {
      byId("customStatus").textContent = "Couldn't read that file. Try an MP3 or WAV.";
    };
    reader.readAsDataURL(file);
  }

  async function handleDesktopToggle(event) {
    const checkbox = event.target;
    const status = byId("desktopStatus");
    status.textContent = "";

    if (!checkbox.checked) {
      sound.prefs.desktop = false;
      sound.savePrefs();
      return;
    }

    let permission = "denied";
    try {
      if ("Notification" in window) {
        permission = await Notification.requestPermission();
      }
    } catch (err) {
      permission = "denied";
    }

    if (permission === "granted") {
      sound.prefs.desktop = true;
      status.textContent = "Desktop notifications are on.";
    } else {
      checkbox.checked = false;
      sound.prefs.desktop = false;
      status.textContent = "This page isn't allowed to show desktop notifications here. They work when you run the project from your own computer or website (see README).";
    }
    sound.savePrefs();
  }

  function setupSoundDialog() {
    const dialog = byId("soundDialog");
    byId("soundBtn").addEventListener("click", openSoundDialog);
    byId("soundClose").addEventListener("click", () => dialog.close());
    byId("soundForm").addEventListener("submit", (e) => {
      e.preventDefault();
      dialog.close();
    });

    byId("soundVolume").addEventListener("change", (e) => {
      sound.prefs.volume = Number(e.target.value);
      sound.savePrefs();
      sound.play(sound.prefs.reminder);   // let the user hear the new volume
    });
    byId("repeatUrgent").addEventListener("change", (e) => {
      sound.prefs.repeatUrgent = e.target.checked;
      sound.savePrefs();
    });

    byId("customFile").addEventListener("change", handleCustomSoundUpload);
    byId("customRemove").addEventListener("click", () => {
      sound.removeCustomSound();
      renderSoundRows();
    });
    byId("desktopNotify").addEventListener("change", handleDesktopToggle);
  }

  function setupEditDialog() {
    byId("editForm").addEventListener("submit", saveEdit);
    byId("editCancel").addEventListener("click", () => byId("editDialog").close());
    byId("editDialog").addEventListener("close", () => { ui.editingId = null; });
  }

  /* ================= 11. EXPORT TO CSV =================
     One row per task, snake_case columns, ISO 8601 times in UTC.
     analysis/sticky_analysis.py reads exactly this format, so if you
     add a column here, add it to EXPECTED_COLUMNS there too. */

  const CSV_COLUMNS = [
    "task_id", "text", "priority", "category", "size", "color",
    "steps_total", "steps_done", "created_at", "remind_at", "first_remind_at",
    "done", "done_at", "archived", "snoozes", "focus_minutes",
  ];

  const isoOrBlank = (ts) => (ts ? new Date(ts).toISOString() : "");

  /** Quotes a value only when it needs it (commas, quotes, line breaks). */
  function csvCell(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function tasksToCsv(list) {
    const rows = list
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => [
        n.id, n.text, n.priority, n.category, n.size, n.color,
        n.steps.length, n.steps.filter((s) => s.d).length,
        isoOrBlank(n.createdAt), isoOrBlank(n.remindAt), isoOrBlank(n.firstRemindAt),
        n.done, isoOrBlank(n.doneAt), n.archived, n.snoozes, n.focusMin,
      ]);
    return [CSV_COLUMNS].concat(rows).map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  async function exportCsv() {
    const list = allNotes();
    if (!list.length) { toast({ title: "Nothing to export yet", text: "Add a few tasks first.", timeout: 4000 }); return; }
    const csv = tasksToCsv(list);
    const filename = "sticky-board-tasks-" + dayKey(Date.now()) + ".csv";

    // On claude.ai the page asks the viewer before saving a file.
    let downloads = null;
    try { if (window.claude && typeof window.claude.use === "function") downloads = await window.claude.use("downloads"); }
    catch (e) { downloads = null; }
    if (downloads) {
      try {
        await downloads.save({ filename, data: csv });
        toast({ title: "Exported " + plural(list.length, "task"), text: "Open " + filename + " with the notebook in the analysis folder.", timeout: 6000 });
      } catch (err) {
        if (err && err.code !== "declined") toast({ title: "Export didn't work", text: "This view can't save files. Try opening the page in a browser tab." });
      }
      return;
    }

    // Anywhere else: a normal browser download.
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = createEl("a", { href: url, download: filename, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ================= 12. THEME & FOOTER ================= */

  function renderAuthor() {
    const a = CONFIG.author || {};
    const parts = [a.program, a.school].filter(Boolean).join(", ");
    const line = byId("authorLine");
    line.replaceChildren("Sticky Board · a student project" + (a.name ? " by " : ""));
    if (a.name) line.append(a.link ? createEl("a", { href: a.link, target: "_blank", rel: "noopener" }, a.name) : a.name);
    if (parts) line.append(" · " + parts);
  }


  function currentTheme() {
    const set = document.documentElement.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function setupTheme() {
    const saved = safeStorage.get("sb.theme", null);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    const btn = byId("themeBtn");
    const label = () => { btn.textContent = currentTheme() === "dark" ? "Light mode" : "Dark mode"; };
    label();
    btn.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      safeStorage.set("sb.theme", next);
      label();
    });
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", label);
  }

  /* ================= 13. START-UP ================= */

  setupTheme();
  renderAuthor();
  buildComposer();
  setupFilterSelects();
  setupEditDialog();
  setupSoundDialog();
  byId("exportCsv").addEventListener("click", exportCsv);
  render();
  renderFocusBar();
  connectStorage();

  // Every 20 seconds: refresh countdowns and fire any reminders that came due.
  setInterval(() => { render(false); checkReminders(); }, 20 * 1000);
})();
