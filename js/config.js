/* =============================================================
   Sticky Board · config.js
   Author: Sajid Muhammad

   Every list and setting you might want to change lives here.
   Edit a value, save the file, reload the page. No build step.

   Tips
   - `key` values are saved with each task. If you rename a key,
     tasks that used the old key keep showing it as plain text.
   - Labels are what people see. Change them freely.
   - Note paper colours are set in css/styles.css (--paper-<key>).
   ============================================================= */

window.STICKY_CONFIG = {

  /* ---------- About you (shown in the page footer) ----------
     Leave name empty to hide it. */
  author: {
    name: "Sajid Muhammad",
    program: "B.Sc. Data Science",
    school: "University of Manitoba",
    link: "",            // e.g. your GitHub or LinkedIn URL
  },

  /* ---------- Note paper colours ---------- */
  colors: [
    { key: "canary",    label: "Canary" },
    { key: "rose",      label: "Rose" },
    { key: "lime",      label: "Lime" },
    { key: "aqua",      label: "Aqua" },
    { key: "tangerine", label: "Tangerine" },
    { key: "lilac",     label: "Lilac" },
  ],

  /* ---------- Priority levels ----------
     weight: higher = more important. Used to pick "Your next move"
     and for the Priority sort. */
  priorities: [
    { key: "urgent", label: "Urgent", weight: 4, hint: "Hard deadline. This has to happen today." },
    { key: "high",   label: "High",   weight: 3, hint: "Important. Schedule it soon." },
    { key: "normal", label: "Normal", weight: 2, hint: "A regular task." },
    { key: "soft",   label: "Soft",   weight: 1, hint: "Flexible. Nice to get done, no pressure." },
  ],

  /* ---------- Categories ---------- */
  categories: [
    { key: "assignment", label: "Assignment" },
    { key: "exam",       label: "Exam prep" },
    { key: "class",      label: "Class" },
    { key: "project",    label: "Project" },
    { key: "work",       label: "Work / job" },
    { key: "personal",   label: "Personal" },
    { key: "health",     label: "Health" },
    { key: "errand",     label: "Errand" },
  ],

  /* ---------- Task size ----------
     Small tasks get a boost in "Your next move" (quick wins
     build momentum, the 2-minute rule). */
  sizes: [
    { key: "tiny",  label: "2 minutes" },
    { key: "short", label: "Under 30 min" },
    { key: "long",  label: "About an hour" },
    { key: "deep",  label: "Deep work (2 h+)" },
  ],

  /* ---------- Reminder choices ----------
     minutes: remind this many minutes from now.
     at: remind at a clock time ({ hour, minute, dayOffset }).
     "custom" shows a date-time picker. "none" means no reminder. */
  reminders: [
    { key: "15m",      label: "In 15 minutes", minutes: 15 },
    { key: "1h",       label: "In 1 hour",     minutes: 60 },
    { key: "3h",       label: "In 3 hours",    minutes: 180 },
    { key: "evening",  label: "This evening (6 pm)", at: { hour: 18 } },
    { key: "tomorrow", label: "Tomorrow 9 am", at: { hour: 9, dayOffset: 1 } },
    { key: "custom",   label: "Pick a time…" },
    { key: "none",     label: "No reminder" },
  ],

  /* ---------- What a new task starts with ---------- */
  defaults: {
    color: "canary",
    priority: "normal",
    category: "assignment",
    size: "short",
    reminder: "1h",
  },

  /* ---------- Procrastination helpers ---------- */
  snoozeMinutes: 15,
  // After this many snoozes a note shows a gentle "you seem stuck" message.
  stuckAfterSnoozes: 3,
  stuckMessage: "You've snoozed this {n} times. Try just 5 minutes, or split it into a smaller first step.",

  // Focus timer lengths offered on each note (minutes).
  focusPresets: [
    { minutes: 5,  label: "Just start" },
    { minutes: 15, label: "Quick sprint" },
    { minutes: 25, label: "Pomodoro" },
    { minutes: 50, label: "Deep work" },
  ],
  breakMinutes: 5,

  // Shown on reminders, picked at random.
  nudges: [
    "Starting is the hardest part. Give it five minutes, then decide.",
    "Aim for a rough first pass. You can polish it later.",
    "Make the first step tiny: open the file and write one line.",
    "You don't need to feel motivated to start. Starting is what brings the motivation.",
    "Put your phone in another room for one timer.",
    "If it takes under two minutes, do it right now.",
    "Future you is counting on present you. Just begin.",
  ],

  // Shown when a task is marked done, picked at random.
  celebrations: [
    "Nice work. One less thing on your mind.",
    "Crossed off. Take a breath.",
    "That's progress. Keep the streak going.",
    "Done. That counts.",
  ],

  /* ---------- Sounds ----------
     Every sound is synthesised in the browser, so there are no
     audio files to host. Each recipe:
       wave:     "sine" | "triangle" | "square" | "sawtooth"
       partials: [[frequencyRatio, loudness], ...] overtones per note
       notes:    [[frequencyHz, startSeconds, lengthSeconds], ...]
       gain:     overall loudness multiplier (square waves are loud)
     Add your own by copying one and changing the numbers. */
  sounds: {
    chime:   { label: "Glass chime", wave: "sine", partials: [[1, 1], [2, 0.25]], notes: [[880, 0, 0.7], [1318.5, 0.16, 0.9]] },
    bell:    { label: "Desk bell", wave: "sine", partials: [[1, 1], [2.76, 0.45], [5.4, 0.2]], notes: [[1046.5, 0, 1.6]] },
    marimba: { label: "Marimba", wave: "sine", partials: [[1, 1], [4, 0.3]], notes: [[523.3, 0, 0.35], [659.3, 0.12, 0.35], [784, 0.24, 0.6]] },
    rise:    { label: "Gentle rise", wave: "triangle", partials: [[1, 1]], notes: [[392, 0, 0.5], [523.3, 0.2, 0.5], [659.3, 0.4, 0.9]] },
    pop:     { label: "Paper pop", wave: "triangle", partials: [[1, 1]], notes: [[620, 0, 0.09], [930, 0.07, 0.14]] },
    digital: { label: "Digital beep", wave: "square", gain: 0.35, partials: [[1, 1]], notes: [[1046.5, 0, 0.09], [1046.5, 0.16, 0.09], [1046.5, 0.32, 0.09]] },
    alarm:   { label: "Alarm", wave: "square", gain: 0.35, partials: [[1, 1]], notes: [[880, 0, 0.16], [660, 0.2, 0.16], [880, 0.4, 0.16], [660, 0.6, 0.16]] },
    silent:  { label: "Silent", notes: [] },
  },

  // Which sound plays for which moment. "custom" = the file you upload.
  soundDefaults: {
    reminder: "chime",
    urgent: "alarm",
    timer: "marimba",
    done: "pop",
    volume: 0.6,
    repeatUrgent: true,
    desktop: false,
  },
};
