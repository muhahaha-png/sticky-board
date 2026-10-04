"""
sticky_analysis.py
Author: Sajid Muhammad

Functions for analysing a Sticky Board CSV export with pandas.
The notebook (task_analysis.ipynb) calls these, and
tests/test_sticky_analysis.py checks them with pytest.

Times in the export are UTC. They are converted to Winnipeg time so
"hour of day" and "day of week" match a Manitoba student's day.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

LOCAL_TZ = "America/Winnipeg"

# Must match CSV_COLUMNS in js/app.js
EXPECTED_COLUMNS = [
    "task_id", "text", "priority", "category", "size", "color",
    "steps_total", "steps_done", "created_at", "remind_at", "first_remind_at",
    "done", "done_at", "archived", "snoozes", "focus_minutes",
]
TIME_COLUMNS = ["created_at", "remind_at", "first_remind_at", "done_at"]
COUNT_COLUMNS = ["steps_total", "steps_done", "snoozes", "focus_minutes"]
PRIORITY_ORDER = ["urgent", "high", "normal", "soft"]
SIZE_ORDER = ["tiny", "short", "long", "deep"]
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# Chart colours, inspired by the University of Manitoba palette
COLORS = {
    "brown": "#4F2C1D",   # Bison brown
    "gold": "#F2A900",    # Wheat gold
    "lake": "#385E9D",    # Lake blue
    "ink": "#2B180F",
    "muted": "#6E5647",
    "light": "#C8B29B",
    "grid": "#E8DFD4",
}


# ---------------------------------------------------------------------------
# Loading and cleaning
# ---------------------------------------------------------------------------

def load_tasks(path: str | Path) -> pd.DataFrame:
    """Read a Sticky Board CSV export and return a DataFrame with proper types."""
    df = pd.read_csv(path, dtype={"task_id": str, "text": str})
    missing = [col for col in EXPECTED_COLUMNS if col not in df.columns]
    if missing:
        raise ValueError(f"{path} is missing columns {missing}. Is it a Sticky Board export?")
    df = df[EXPECTED_COLUMNS].copy()

    for col in TIME_COLUMNS:
        df[col] = pd.to_datetime(df[col], utc=True, errors="coerce").dt.tz_convert(LOCAL_TZ)
    for col in ["done", "archived"]:
        df[col] = df[col].astype(str).str.strip().str.lower().eq("true")
    for col in COUNT_COLUMNS:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)

    # Categoricals keep a sensible order in tables and charts.
    # Values not in the list (custom priorities from config.js) become NaN.
    df["priority"] = pd.Categorical(df["priority"], categories=PRIORITY_ORDER)
    df["size"] = pd.Categorical(df["size"], categories=SIZE_ORDER)
    df["text"] = df["text"].fillna("")
    return df


def check_data(df: pd.DataFrame) -> list[str]:
    """Return a list of data-quality problems (empty list = looks fine)."""
    problems = []
    duplicates = df["task_id"].duplicated().sum()
    if duplicates:
        problems.append(f"{duplicates} duplicate task_id values")
    if df["created_at"].isna().any():
        problems.append(f"{df['created_at'].isna().sum()} tasks have no created_at time")
    done_without_time = (df["done"] & df["done_at"].isna()).sum()
    if done_without_time:
        problems.append(f"{done_without_time} tasks are marked done but have no done_at time")
    finished_early = (df["done_at"] < df["created_at"]).sum()
    if finished_early:
        problems.append(f"{finished_early} tasks were finished before they were created")
    too_many_steps = (df["steps_done"] > df["steps_total"]).sum()
    if too_many_steps:
        problems.append(f"{too_many_steps} tasks have more steps done than steps in total")
    for col, allowed in [("priority", PRIORITY_ORDER), ("size", SIZE_ORDER)]:
        unknown = df[col].isna().sum()
        if unknown:
            problems.append(f"{unknown} tasks have a {col} outside {allowed} (custom values from config.js?)")
    return problems


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add the columns used in the analysis. Returns a new DataFrame."""
    out = df.copy()
    out["was_snoozed"] = out["snoozes"] > 0
    out["has_steps"] = out["steps_total"] > 0
    out["hours_to_done"] = (out["done_at"] - out["created_at"]).dt.total_seconds() / 3600

    # Finished before the first reminder? Only defined for finished tasks that had a reminder.
    has_deadline = out["done"] & out["first_remind_at"].notna()
    beat = out["done_at"] <= out["first_remind_at"]
    out["beat_reminder"] = beat.where(has_deadline).astype("boolean")

    out["created_hour"] = out["created_at"].dt.hour
    out["created_weekday"] = pd.Categorical(out["created_at"].dt.day_name(), categories=WEEKDAYS)
    out["step_completion"] = out["steps_done"] / out["steps_total"].where(out["has_steps"])
    return out


# ---------------------------------------------------------------------------
# Descriptive statistics
# ---------------------------------------------------------------------------

def summary_by(df: pd.DataFrame, column: str, sort_by: str | None = "snoozed_rate") -> pd.DataFrame:
    """Completion and procrastination stats for each value of `column`."""
    table = df.groupby(column, observed=True).agg(
        tasks=("task_id", "count"),
        completion_rate=("done", "mean"),
        snoozed_rate=("was_snoozed", "mean"),
        mean_snoozes=("snoozes", "mean"),
        median_hours_to_done=("hours_to_done", "median"),
    )
    if sort_by:
        table = table.sort_values(sort_by, ascending=False)
    return table.round(2)


def _local_date(moment: pd.Timestamp | None) -> date:
    if moment is None:
        moment = pd.Timestamp.now(tz=LOCAL_TZ)
    elif moment.tzinfo is None:
        moment = moment.tz_localize(LOCAL_TZ)
    return moment.tz_convert(LOCAL_TZ).date()


def daily_completions(df: pd.DataFrame, days: int = 14, end: pd.Timestamp | None = None) -> pd.Series:
    """Tasks finished on each of the last `days` days (Winnipeg time), oldest first."""
    finished = df.loc[df["done"], "done_at"].dropna()
    counts = finished.dt.date.value_counts()
    last = _local_date(end)
    dates = [last - timedelta(days=i) for i in range(days - 1, -1, -1)]
    values = [int(counts.get(d, 0)) for d in dates]
    return pd.Series(values, index=pd.Index(dates, name="date"), name="tasks_done")


def current_streak(df: pd.DataFrame, today: pd.Timestamp | None = None) -> int:
    """Days in a row with at least one task done. Today still counts if it's not over yet."""
    done_days = set(df.loc[df["done"], "done_at"].dropna().dt.date)
    day = _local_date(today)
    if day not in done_days:
        day -= timedelta(days=1)
    streak = 0
    while day in done_days:
        streak += 1
        day -= timedelta(days=1)
    return streak


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def bootstrap_diff(a, b, n_boot: int = 5000, seed: int = 2026, level: float = 0.95) -> tuple[float, float, float]:
    """Difference in means (a - b) with a percentile bootstrap confidence interval."""
    rng = np.random.default_rng(seed)
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    boot_a = rng.choice(a, size=(n_boot, a.size), replace=True).mean(axis=1)
    boot_b = rng.choice(b, size=(n_boot, b.size), replace=True).mean(axis=1)
    diffs = boot_a - boot_b
    tail = (1 - level) / 2
    return float(a.mean() - b.mean()), float(np.quantile(diffs, tail)), float(np.quantile(diffs, 1 - tail))


def steps_vs_snoozing(df: pd.DataFrame, n_boot: int = 5000, seed: int = 2026) -> dict:
    """Compare how often tasks with and without steps get snoozed.

    Chi-square test of independence on the 2x2 table, plus the difference
    in proportions with a 95% bootstrap confidence interval.
    """
    from scipy.stats import chi2_contingency

    with_steps = df.loc[df["has_steps"], "was_snoozed"].astype(float).to_numpy()
    without_steps = df.loc[~df["has_steps"], "was_snoozed"].astype(float).to_numpy()
    if len(with_steps) < 5 or len(without_steps) < 5:
        raise ValueError("Need at least 5 tasks with steps and 5 without to compare them.")

    table = pd.crosstab(df["has_steps"], df["was_snoozed"]).reindex(
        index=[False, True], columns=[False, True], fill_value=0)
    if (table.sum(axis=0) == 0).any():
        raise ValueError("Every task was snoozed, or none were, so there is nothing to compare.")
    chi2, p_value, _, _ = chi2_contingency(table)
    table.index = ["no steps", "has steps"]
    table.columns = ["not snoozed", "snoozed"]

    diff, low, high = bootstrap_diff(with_steps, without_steps, n_boot=n_boot, seed=seed)
    return {
        "table": table,
        "chi2": float(chi2),
        "p_value": float(p_value),
        "rate_with_steps": float(with_steps.mean()),
        "rate_without_steps": float(without_steps.mean()),
        "n_with_steps": len(with_steps),
        "n_without_steps": len(without_steps),
        "difference": diff,
        "ci_low": low,
        "ci_high": high,
    }


def _readable_term(term: str) -> str:
    """Turn patsy names like C(priority, Treatment('normal'))[T.high] into 'priority: high (vs normal)'."""
    match = re.match(r"C\((\w+), Treatment\('(\w+)'\)\)\[T\.(\w+)\]", term)
    if match:
        variable, reference, level = match.groups()
        return f"{variable.replace('task_', '')}: {level} (vs {reference})"
    if term == "has_steps":
        return "has steps (vs none)"
    return term


def snooze_odds_ratios(df: pd.DataFrame) -> pd.DataFrame:
    """Logistic regression (statsmodels) of 'was snoozed' on priority, size and steps.

    Returns odds ratios with 95% confidence intervals. Reference levels:
    normal priority, short task, no steps.
    """
    import statsmodels.formula.api as smf

    usable = df["priority"].notna() & df["size"].notna()
    data = pd.DataFrame({
        "snoozed": df.loc[usable, "was_snoozed"].astype(int),
        "priority": df.loc[usable, "priority"].astype(str),
        "task_size": df.loc[usable, "size"].astype(str),
        "has_steps": df.loc[usable, "has_steps"].astype(int),
    })
    formula = "snoozed ~ C(priority, Treatment('normal')) + C(task_size, Treatment('short')) + has_steps"
    fit = smf.logit(formula, data=data).fit(disp=False)
    ci = fit.conf_int()
    table = pd.DataFrame({
        "odds_ratio": np.exp(fit.params),
        "ci_low": np.exp(ci[0]),
        "ci_high": np.exp(ci[1]),
        "p_value": fit.pvalues,
    }).drop(index="Intercept")
    table.index = [_readable_term(term) for term in table.index]
    return table.round(3)


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

def snooze_model_cv(df: pd.DataFrame, folds: int = 5, seed: int = 2026) -> dict:
    """Cross-validated ROC AUC for predicting whether a task gets snoozed.

    Logistic regression (scikit-learn) on priority, category, size, steps and
    the hour the task was written, compared with a baseline that always
    predicts the overall snooze rate (AUC 0.5).
    """
    from sklearn.compose import ColumnTransformer
    from sklearn.dummy import DummyClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    X = pd.DataFrame({
        "priority": df["priority"].astype(str),
        "category": df["category"].astype(str),
        "task_size": df["size"].astype(str),
        "has_steps": df["has_steps"].astype(int),
        "created_hour": df["created_hour"].astype(int),
    })
    y = df["was_snoozed"].astype(int)
    if y.nunique() < 2 or y.value_counts().min() < folds:
        raise ValueError(f"Need at least {folds} snoozed and {folds} not-snoozed tasks for {folds}-fold CV.")

    preprocess = ColumnTransformer([
        ("categories", OneHotEncoder(handle_unknown="ignore"), ["priority", "category", "task_size"]),
        ("numbers", StandardScaler(), ["has_steps", "created_hour"]),
    ])
    model = Pipeline([("prep", preprocess), ("logreg", LogisticRegression(max_iter=1000))])
    cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)

    auc = cross_val_score(model, X, y, cv=cv, scoring="roc_auc")
    baseline = cross_val_score(DummyClassifier(strategy="prior"), X, y, cv=cv, scoring="roc_auc")
    return {
        "auc_mean": float(auc.mean()),
        "auc_std": float(auc.std()),
        "fold_auc": [round(float(a), 3) for a in auc],
        "baseline_auc": float(baseline.mean()),
    }


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

def to_sqlite(df: pd.DataFrame, conn: sqlite3.Connection, table: str = "tasks") -> int:
    """Write the raw export columns to a SQLite table so they can be queried with SQL."""
    out = df[EXPECTED_COLUMNS].copy()
    for col in TIME_COLUMNS:
        out[col] = out[col].dt.strftime("%Y-%m-%d %H:%M:%S")
    for col in ["priority", "size"]:
        out[col] = out[col].astype(str)
    for col in ["done", "archived"]:
        out[col] = out[col].astype(int)
    out.to_sql(table, conn, index=False, if_exists="replace")
    return len(out)


# ---------------------------------------------------------------------------
# Charts (matplotlib)
# ---------------------------------------------------------------------------

def use_chart_style() -> None:
    """Clean, consistent matplotlib defaults for every chart in the notebook."""
    import matplotlib as mpl

    mpl.rcParams.update({
        "figure.dpi": 110,
        "savefig.dpi": 160,
        "savefig.bbox": "tight",
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.edgecolor": COLORS["light"],
        "axes.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "axes.axisbelow": True,
        "grid.color": COLORS["grid"],
        "grid.linewidth": 0.8,
        "axes.titlesize": 12,
        "axes.titleweight": "bold",
        "axes.titlelocation": "left",
        "axes.titlecolor": COLORS["ink"],
        "axes.labelcolor": COLORS["muted"],
        "axes.labelsize": 10,
        "xtick.color": COLORS["muted"],
        "ytick.color": COLORS["muted"],
        "text.color": COLORS["ink"],
        "font.size": 10,
    })


def _save(fig, path: str | Path | None) -> None:
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(path)


def plot_rate_by(table: pd.DataFrame, rate_column: str, title: str, xlabel: str, save_to=None):
    """Horizontal bar chart of a 0-1 rate, highest at the top, with direct labels."""
    import matplotlib.pyplot as plt
    from matplotlib.ticker import PercentFormatter

    data = table[rate_column].sort_values()
    fig, ax = plt.subplots(figsize=(7, 0.42 * len(data) + 1.2))
    bars = ax.barh(data.index.astype(str), data.to_numpy(), color=COLORS["brown"], height=0.6)
    ax.bar_label(bars, labels=[f"{v:.0%}" for v in data], padding=4, fontsize=9, color=COLORS["ink"])
    ax.xaxis.set_major_formatter(PercentFormatter(1.0))
    ax.set_xlim(0, max(0.05, float(data.max()) * 1.2))
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.grid(axis="y", visible=False)
    ax.tick_params(axis="y", length=0)
    _save(fig, save_to)
    return fig


def plot_daily(series: pd.Series, title: str, save_to=None):
    """Bar per day; the last (most recent) day is highlighted."""
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator

    n = len(series)
    fig, ax = plt.subplots(figsize=(8, 3.2))
    colors = [COLORS["light"]] * (n - 1) + [COLORS["brown"]]
    ax.bar(range(n), series.to_numpy(), color=colors, width=0.7)
    step = max(1, n // 7)
    ticks = [i for i in range(n) if (n - 1 - i) % step == 0]
    ax.set_xticks(ticks)
    ax.set_xticklabels([series.index[i].strftime("%b %d") for i in ticks])
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.grid(axis="x", visible=False)
    ax.set_title(title)
    ax.set_ylabel("tasks finished")
    _save(fig, save_to)
    return fig


def plot_hours_to_done(df: pd.DataFrame, save_to=None):
    """Histogram of hours from writing a task to finishing it, on a log scale."""
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    hours = df["hours_to_done"].dropna()
    hours = hours[hours > 0]
    fig, ax = plt.subplots(figsize=(7, 3.4))
    if hours.nunique() > 1:
        bins = np.logspace(np.log10(hours.min()), np.log10(hours.max()), 25)
        ax.set_xscale("log")
    else:
        bins = 10
    ax.hist(hours, bins=bins, color=COLORS["brown"], edgecolor="white", linewidth=0.8)
    median = float(hours.median())
    ax.axvline(median, color=COLORS["gold"], linewidth=2)
    ax.annotate(f"median {median:.1f} h", xy=(median, 1), xycoords=("data", "axes fraction"),
                xytext=(6, -14), textcoords="offset points", fontsize=9, color=COLORS["ink"])
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g} h"))
    ax.grid(axis="x", visible=False)
    ax.set_title("Time from writing a task to finishing it")
    ax.set_ylabel("tasks")
    _save(fig, save_to)
    return fig


def plot_steps_comparison(result: dict, save_to=None):
    """Two bars: share snoozed without vs with steps, with the test result underneath."""
    import matplotlib.pyplot as plt
    from matplotlib.ticker import PercentFormatter

    rates = [result["rate_without_steps"], result["rate_with_steps"]]
    labels = [f"No steps\n(n = {result['n_without_steps']})", f"Broken into steps\n(n = {result['n_with_steps']})"]
    fig, ax = plt.subplots(figsize=(5.6, 3.8))
    bars = ax.bar(labels, rates, color=[COLORS["light"], COLORS["brown"]], width=0.55)
    ax.bar_label(bars, labels=[f"{r:.0%}" for r in rates], padding=4, fontsize=10, color=COLORS["ink"])
    ax.yaxis.set_major_formatter(PercentFormatter(1.0))
    ax.set_ylim(0, max(rates) * 1.25 + 0.02)
    ax.grid(axis="x", visible=False)
    ax.set_title("Share of tasks snoozed at least once")
    note = (f"Difference {result['difference']:+.0%} "
            f"(95% CI {result['ci_low']:+.0%} to {result['ci_high']:+.0%}), "
            f"chi-square p = {result['p_value']:.3g}")
    ax.text(0, -0.3, note, transform=ax.transAxes, fontsize=9, color=COLORS["muted"])
    _save(fig, save_to)
    return fig


def plot_odds_ratios(table: pd.DataFrame, save_to=None):
    """Forest plot of odds ratios with 95% confidence intervals (log scale)."""
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    data = table.sort_values("odds_ratio")
    y = np.arange(len(data))
    fig, ax = plt.subplots(figsize=(7, 0.45 * len(data) + 1.4))
    errors = [data["odds_ratio"] - data["ci_low"], data["ci_high"] - data["odds_ratio"]]
    ax.errorbar(data["odds_ratio"], y, xerr=errors, fmt="o", color=COLORS["lake"],
                elinewidth=2, capsize=0, markersize=7)
    ax.axvline(1, color=COLORS["muted"], linewidth=1, linestyle="--")
    ax.set_xscale("log")
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
    ax.set_yticks(y)
    ax.set_yticklabels(data.index)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("odds ratio (log scale): below 1 = snoozed less, above 1 = snoozed more")
    ax.set_title("What goes with snoozing? Logistic regression")
    _save(fig, save_to)
    return fig
