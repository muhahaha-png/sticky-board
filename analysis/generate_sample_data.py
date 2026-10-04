"""
generate_sample_data.py
Author: Sajid Muhammad

Makes a synthetic Sticky Board export so the analysis notebook can run
before you have real data. Every number in the output is made up.

The generator builds in a few patterns on purpose. If the analysis is
working, it should find them again:
  * exam prep and project tasks get snoozed more often
  * tasks broken into steps get snoozed less often
  * bigger tasks get snoozed more; 2-minute tasks rarely are
  * soft-priority tasks get snoozed more than urgent ones

Usage (from the project root):
    python analysis/generate_sample_data.py
    python analysis/generate_sample_data.py --rows 500 --seed 7

Uses only the Python standard library.
"""
from __future__ import annotations

import argparse
import csv
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

WINNIPEG = ZoneInfo("America/Winnipeg")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "data" / "sample_tasks_synthetic.csv"

# Same column order as the app's "Export data (CSV)" button (js/app.js).
COLUMNS = [
    "task_id", "text", "priority", "category", "size", "color",
    "steps_total", "steps_done", "created_at", "remind_at", "first_remind_at",
    "done", "done_at", "archived", "snoozes", "focus_minutes",
]

# The sample covers one month of a fall term and is "exported" here.
TERM_START = datetime(2026, 9, 3, tzinfo=WINNIPEG)
EXPORT_TIME = datetime(2026, 10, 3, 21, 0, tzinfo=WINNIPEG)

# name: (sampling weight, effect on log-odds of snoozing, example tasks)
CATEGORIES = {
    "assignment": (0.28, 0.3, ["Problem set {n}", "Lab report {n}", "Essay draft", "Reading response {n}"]),
    "exam":       (0.14, 0.7, ["Review lectures {n}-{m}", "Practice midterm", "Make a formula sheet"]),
    "class":      (0.14, 0.0, ["Watch lecture {n} recording", "Email the TA", "Read chapter {n}"]),
    "project":    (0.10, 0.6, ["Clean the project dataset", "Write project proposal", "Group project check-in"]),
    "work":       (0.10, -0.2, ["Submit timesheet", "Prep for shift", "Reply to manager"]),
    "personal":   (0.10, 0.0, ["Call home", "Plan the weekend", "Book a haircut"]),
    "health":     (0.07, 0.2, ["Gym session", "Book a doctor's appointment", "Meal prep"]),
    "errand":     (0.07, -0.3, ["Laundry", "Groceries", "Pick up a parcel"]),
}
# name: (sampling weight, effect on log-odds of snoozing, chance of never finishing)
PRIORITIES = {
    "urgent": (0.15, -0.5, 0.02),
    "high":   (0.30, -0.2, 0.04),
    "normal": (0.40, 0.0, 0.07),
    "soft":   (0.15, 0.5, 0.15),
}
# name: (sampling weight, effect on log-odds of snoozing, median hours to finish, mean hours until reminder)
SIZES = {
    "tiny":  (0.20, -1.2, 0.5, 1.0),
    "short": (0.40, 0.0, 5.0, 6.0),
    "long":  (0.25, 0.4, 18.0, 24.0),
    "deep":  (0.15, 0.8, 36.0, 48.0),
}
BASE_LOG_ODDS = -0.8
STEPS_EFFECT = -0.9          # breaking a task down lowers the odds of snoozing
LATE_HOUR_EFFECT = 0.03      # per hour after 2 pm: tasks written late get put off a bit more
SNOOZE_MINUTES = 15
COLORS = ["canary", "rose", "lime", "aqua", "tangerine", "lilac"]

# Relative chance a task is written at each hour of the day (0 = midnight).
HOUR_WEIGHTS = [2, 1, 0.5, 0.2, 0.1, 0.1, 0.3, 1, 3, 5, 6, 7,
                5, 5, 5, 5, 5, 4, 5, 7, 8, 9, 7, 4]


def weighted_key(rng: random.Random, options: dict) -> str:
    keys = list(options)
    return rng.choices(keys, weights=[options[k][0] for k in keys], k=1)[0]


def poisson(rng: random.Random, mean: float) -> int:
    """Knuth's algorithm; fine for small means."""
    limit, k, product = math.exp(-mean), 0, rng.random()
    while product > limit:
        k += 1
        product *= rng.random()
    return k


def iso_utc(moment: datetime | None) -> str:
    """Same format as JavaScript's Date.toISOString(), or blank."""
    if moment is None:
        return ""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def created_time(rng: random.Random) -> datetime:
    days = (EXPORT_TIME.date() - TERM_START.date()).days
    while True:
        day = TERM_START.date() + timedelta(days=rng.randrange(days + 1))
        hour = rng.choices(range(24), weights=HOUR_WEIGHTS, k=1)[0]
        moment = datetime(day.year, day.month, day.day, hour, rng.randrange(60), tzinfo=WINNIPEG)
        if moment < EXPORT_TIME:
            return moment


def make_task(rng: random.Random, index: int) -> dict:
    category = weighted_key(rng, CATEGORIES)
    priority = weighted_key(rng, PRIORITIES)
    size = weighted_key(rng, SIZES)
    _, cat_effect, templates = CATEGORIES[category]
    _, pri_effect, never_finish = PRIORITIES[priority]
    _, size_effect, median_hours, reminder_hours = SIZES[size]

    created = created_time(rng)
    n = rng.randint(1, 9)
    text = rng.choice(templates).format(n=n, m=n + 2)

    # Bigger and scarier tasks are more likely to be broken down.
    p_steps = 0.2 + (0.3 if size in ("long", "deep") else 0) + (0.1 if category in ("exam", "project") else 0)
    has_steps = rng.random() < p_steps
    steps_total = rng.randint(2, 5) if has_steps else 0

    # Was it snoozed? Logistic model with the effects listed at the top.
    log_odds = (BASE_LOG_ODDS + cat_effect + pri_effect + size_effect
                + (STEPS_EFFECT if has_steps else 0)
                + LATE_HOUR_EFFECT * (created.hour - 14))
    p_snooze = 1 / (1 + math.exp(-log_odds))
    snoozes = 0
    if rng.random() < p_snooze:
        snoozes = 1 + poisson(rng, 0.8 + (1.0 if size in ("long", "deep") else 0))

    # Reminder: most tasks get one.
    first_remind = remind = None
    if rng.random() < 0.85:
        lead = max(0.25, rng.expovariate(1 / reminder_hours))
        first_remind = created + timedelta(hours=lead)
        remind = first_remind + timedelta(minutes=SNOOZE_MINUTES * snoozes)

    # Time to finish: log-normal around the size's median, slower when snoozed.
    hours = median_hours * math.exp(rng.gauss(0, 0.9)) * (1 + 0.6 * snoozes)
    done_at = created + timedelta(hours=hours)
    done = done_at <= EXPORT_TIME and rng.random() >= never_finish
    if not done:
        done_at = None

    steps_done = steps_total if done else (rng.randint(0, steps_total - 1) if steps_total else 0)
    archived = bool(done and done_at < EXPORT_TIME - timedelta(days=7) and rng.random() < 0.7)

    focus = 0
    if size in ("long", "deep") and rng.random() < 0.6:
        focus = sum(rng.choice([15, 25, 25, 50]) for _ in range(rng.randint(1, 4)))
    elif size == "short" and rng.random() < 0.3:
        focus = rng.choice([5, 15, 25])

    return {
        "task_id": f"syn{index:04d}",
        "text": text,
        "priority": priority,
        "category": category,
        "size": size,
        "color": rng.choice(COLORS),
        "steps_total": steps_total,
        "steps_done": steps_done,
        "created_at": iso_utc(created),
        "remind_at": iso_utc(remind),
        "first_remind_at": iso_utc(first_remind),
        "done": "true" if done else "false",
        "done_at": iso_utc(done_at),
        "archived": "true" if archived else "false",
        "snoozes": snoozes,
        "focus_minutes": focus,
    }


def generate(rows: int = 320, seed: int = 2026) -> list[dict]:
    """Return `rows` synthetic tasks. The same seed always gives the same tasks."""
    rng = random.Random(seed)
    tasks = [make_task(rng, i + 1) for i in range(rows)]
    return sorted(tasks, key=lambda t: t["created_at"])


def write_csv(tasks: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(tasks)


def main() -> None:
    parser = argparse.ArgumentParser(description="Write a synthetic Sticky Board export.")
    parser.add_argument("--rows", type=int, default=320, help="number of tasks (default 320)")
    parser.add_argument("--seed", type=int, default=2026, help="random seed (default 2026)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output CSV path")
    args = parser.parse_args()

    tasks = generate(args.rows, args.seed)
    write_csv(tasks, args.out)
    done = sum(t["done"] == "true" for t in tasks)
    snoozed = sum(t["snoozes"] > 0 for t in tasks)
    print(f"Wrote {len(tasks)} synthetic tasks to {args.out}")
    print(f"  finished: {done / len(tasks):.0%} · snoozed at least once: {snoozed / len(tasks):.0%}")


if __name__ == "__main__":
    main()
