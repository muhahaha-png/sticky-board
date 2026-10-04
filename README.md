# Sticky Board

**A sticky-note task app that helps students beat procrastination, plus a Python analysis of the data it collects.**

**Sajid Muhammad** · B.Sc. Data Science, University of Manitoba

Students rarely forget *what* they have to do. They put off *starting*. Sticky Board turns each task into a sticky note with a priority, a category and a reminder. It encourages breaking tasks into small first steps and offers a 5-minute "just start" timer. Every snooze and every finished task is recorded, so the second half of the project asks a data question: **which tasks get put off, and does breaking them down help?**

| Part | Built with |
|---|---|
| Web app | HTML, CSS, JavaScript (no frameworks, no build step) |
| Data analysis | Python, pandas, SQL (SQLite), SciPy, statsmodels, scikit-learn, matplotlib, Jupyter |
| Quality | pytest, GitHub Actions |

---

## The app

- **Sticky notes** in six paper colours on a dark desk, with a light theme too. The paper texture (grain, fibres, the adhesive band, a lifted corner) is drawn in CSS with no image files.
- **Organise.** Every task has:
  - a priority: Urgent, High, Normal or Soft (Soft means flexible, no pressure)
  - a category: Assignment, Exam prep, Class, Project, Work, Personal, Health or Errand
  - a size: 2 minutes, under 30 min, about an hour, or deep work

  You can filter and sort the board by these.
- **Your next move.** The app picks the one task to start now, based on priority, how close it is to due, how often it's been snoozed, and whether it's a quick win.
- **Break it down.** Add steps to any task and tick them off on the note.
- **Reminders that ask "did you finish this?"** You can answer *Yes, done* / *Start 5 min* / *Snooze* / *Dismiss*. After 3 snoozes the note suggests a smaller first step.
- **Focus timer.** 5 ("just start"), 15, 25 (Pomodoro) or 50 minutes, plus breaks. Minutes are logged on the task.
- **Done tray.** Finished tasks move here, crossed off, with how long they took and whether they beat the reminder.
- **Sounds.** Pick a sound for each kind of alert, from 7 built-in sounds made with the Web Audio API. You can also upload your own, set the volume, and repeat urgent reminders.
- **Insights and export.**
  - Insights: streak, beat-the-reminder rate, a 14-day chart, and snoozes by category.
  - **Export data (CSV)** feeds the Python analysis.

## The analysis

[`analysis/task_analysis.ipynb`](analysis/task_analysis.ipynb) answers four questions:

| Question | Method |
|---|---|
| Which kinds of tasks get put off most? | Grouped summaries in pandas, and the same query in SQL (SQLite) |
| Do tasks broken into steps get snoozed less? | Chi-square test of independence, plus a difference in proportions with a 95% bootstrap CI |
| How long do tasks take? Are they finished before the first reminder? | Log-scale distribution, quartiles by task size |
| Can we predict which tasks will be snoozed? | Logistic regression: odds ratios with CIs (statsmodels), and 5-fold cross-validated ROC AUC against a baseline (scikit-learn) |

**About the sample data.** `data/sample_tasks_synthetic.csv` is synthetic, made by [`analysis/generate_sample_data.py`](analysis/generate_sample_data.py) with a fixed seed. The generator plants known effects, for example that steps lower the odds of snoozing. Running the notebook on it checks that the methods recover effects that are really there. The results are not claims about real students. To analyse real data, export from the app and point `DATA_PATH` at your file.

All times are converted from UTC to `America/Winnipeg`, so hour-of-day and weekday features match a Manitoba student's day.

---

## Getting started

### Run the app

Open `index.html` in a browser. Tasks are saved in that browser.

To use desktop notifications, serve the folder locally instead. Run this from the project folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

To put it online, push to GitHub and turn on **Settings → Pages**. It's a static site, so nothing else is needed.

### Run the analysis

From the project folder, create a virtual environment:

```bash
python3 -m venv .venv
```

Activate it:

```bash
source .venv/bin/activate
```

Install the dependencies:

```bash
python -m pip install -r requirements.txt
```

Regenerate the synthetic sample. This step is optional, because the CSV is already included:

```bash
python analysis/generate_sample_data.py
```

Open the notebook:

```bash
jupyter lab analysis/task_analysis.ipynb
```

Run all cells. Charts are saved to `analysis/figures/`.

### Run the tests

```bash
pytest
```

The tests cover CSV parsing, including quoted text with commas and line breaks, feature engineering, the streak and daily counts, the bootstrap, SQLite loading, and an end-to-end run on the sample data. GitHub Actions runs them on every push.

---

## Data dictionary

One row per task, as written by **Export data (CSV)** (`CSV_COLUMNS` in `js/app.js`) and read by `load_tasks()` in `analysis/sticky_analysis.py`.

| Column | Type | Meaning |
|---|---|---|
| `task_id` | text | Unique id |
| `text` | text | What the task says |
| `priority` | category | `urgent`, `high`, `normal`, `soft` |
| `category` | category | `assignment`, `exam`, `class`, `project`, `work`, `personal`, `health`, `errand` |
| `size` | category | `tiny` (2 min), `short`, `long`, `deep` |
| `color` | category | Note colour |
| `steps_total`, `steps_done` | int | Steps the task was broken into, and how many are ticked |
| `created_at` | datetime (UTC) | When the task was written |
| `remind_at` | datetime (UTC) | Current reminder time (moves when snoozed); blank = no reminder |
| `first_remind_at` | datetime (UTC) | The original reminder time, used for "beat the reminder" |
| `done` | bool | Finished? |
| `done_at` | datetime (UTC) | When it was finished; blank if not |
| `archived` | bool | Cleared from the Done tray (still counted in Insights) |
| `snoozes` | int | Times the reminder was snoozed |
| `focus_minutes` | int | Minutes logged with the focus timer |

## Project structure

```
sticky-board/
├── index.html                 Page layout (each section labelled)
├── css/styles.css             Styling; colours and fonts are tokens at the top
├── js/
│   ├── config.js              Priorities, categories, timers, messages, sounds, your name
│   └── app.js                 App logic in 13 numbered sections
├── analysis/
│   ├── task_analysis.ipynb    The analysis notebook
│   ├── sticky_analysis.py     Loading, cleaning, stats, models, charts
│   ├── generate_sample_data.py  Synthetic data with known effects (standard library only)
│   └── figures/               Charts saved by the notebook
├── data/
│   └── sample_tasks_synthetic.csv
├── tests/test_sticky_analysis.py
├── requirements.txt
├── pytest.ini
└── .github/workflows/tests.yml
```

## Customising

| To change… | Edit |
|---|---|
| Your name and program in the footer | `js/config.js` → `author` |
| Priorities, categories, sizes | `js/config.js` → `priorities`, `categories`, `sizes` |
| Reminder choices, snooze length, timers | `js/config.js` → `reminders`, `snoozeMinutes`, `focusPresets` |
| Encouraging messages | `js/config.js` → `nudges`, `celebrations`, `stuckMessage` |
| Sounds (each is a short synth recipe) | `js/config.js` → `sounds` |
| Colours and fonts | `css/styles.css` → section 1 |

If you add a column to the export, add it to `EXPECTED_COLUMNS` in `analysis/sticky_analysis.py` too.

## Design notes

- **Colours** are inspired by the University of Manitoba palette: Bison brown `#4F2C1D`, Wheat gold `#F2A900` and Lake blue `#385E9D`. This is a student project and is not affiliated with or endorsed by the University of Manitoba.
- **Accessibility.**
  - Every control has a label, keyboard focus is visible, and chart bars can be reached by keyboard.
  - The app respects `prefers-reduced-motion`.
  - Text contrast meets WCAG AA in both themes.
- **Privacy.** Tasks stay in your browser (or your Claude account when the app is published there). Real exports matching `data/sticky-board-tasks-*.csv` are listed in `.gitignore`, so they aren't committed by accident.

## Skills shown

- Data cleaning and validation with pandas (types, time zones, quality checks)
- SQL aggregation with `GROUP BY`, `CASE` and `HAVING`
- Statistical inference: chi-square test, bootstrap confidence intervals, logistic regression with odds ratios
- Machine learning workflow: preprocessing pipeline, stratified k-fold cross-validation, comparing against a baseline
- Data visualisation with matplotlib
- Reproducibility: seeded synthetic data, pinned requirements, automated tests and CI
- Front-end development: HTML, CSS, JavaScript, Web Audio, accessibility

## Research behind the features

- Gollwitzer, P. M. (1999). Implementation intentions: Strong effects of simple plans. *American Psychologist, 54*(7), 493–503. This is the basis for writing the first step.
- Steel, P. (2007). The nature of procrastination: A meta-analytic and theoretical review of quintessential self-regulatory failure. *Psychological Bulletin, 133*(1), 65–94. Tasks that feel big, vague or far away get delayed.
- Cirillo, F. *The Pomodoro Technique*. The source of the focus timer.
- Allen, D. (2001). *Getting Things Done*. The source of the 2-minute rule.

## Limitations and next steps

- One person's tasks make a small sample, and that person's tasks aren't independent of each other. With consent, collecting exports from several students would allow a mixed-effects model with a random effect per student.
- A snooze is a click in the app. It's a stand-in for procrastination, not a measure of it.
- The data is observational, so associations aren't causes.
- Possible extensions: recurring tasks, a calendar view, and looking at workload around midterm weeks.
