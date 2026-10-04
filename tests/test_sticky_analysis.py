"""
Tests for analysis/sticky_analysis.py and analysis/generate_sample_data.py.

Run from the project root:
    pytest
"""
import sqlite3

import numpy as np
import pandas as pd
import pytest

import generate_sample_data as gen
import sticky_analysis as sa

HEADER = ",".join(sa.EXPECTED_COLUMNS)

# Two rows written exactly the way the app's export button writes them.
# The first task's text has a comma, quotes and a line break, so it must be quoted.
ROW_DONE = (
    'n1,"Read ch. 4, then ""summarise""\nit",high,assignment,short,canary,3,3,'
    "2026-10-01T15:00:00.000Z,2026-10-01T23:15:00.000Z,2026-10-01T23:00:00.000Z,"
    "true,2026-10-01T17:30:00.000Z,false,1,25"
)
ROW_OPEN = "n2,Laundry,soft,errand,short,lime,0,0,2026-10-02T02:00:00.000Z,,,false,,false,0,0"


def write_csv(tmp_path, rows, header=HEADER):
    path = tmp_path / "tasks.csv"
    path.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def tasks(tmp_path):
    return sa.load_tasks(write_csv(tmp_path, [ROW_DONE, ROW_OPEN]))


def test_load_tasks_parses_types(tasks):
    assert len(tasks) == 2
    assert tasks.loc[0, "text"] == 'Read ch. 4, then "summarise"\nit'
    assert tasks["done"].tolist() == [True, False]
    assert tasks["snoozes"].tolist() == [1, 0]
    # 15:00 UTC on Oct 1 is 10:00 in Winnipeg (CDT, UTC-5)
    assert str(tasks["created_at"].dt.tz) == sa.LOCAL_TZ
    assert tasks.loc[0, "created_at"].hour == 10
    assert pd.isna(tasks.loc[1, "remind_at"])
    assert list(tasks["priority"].cat.categories) == sa.PRIORITY_ORDER


def test_load_tasks_rejects_wrong_file(tmp_path):
    header = HEADER.replace(",snoozes", "")
    with pytest.raises(ValueError, match="snoozes"):
        sa.load_tasks(write_csv(tmp_path, [], header=header))


def test_check_data_finds_no_problems_in_clean_data(tasks):
    assert sa.check_data(tasks) == []


def test_check_data_flags_task_finished_before_created(tasks):
    broken = tasks.copy()
    broken.loc[0, "done_at"] = broken.loc[0, "created_at"] - pd.Timedelta(hours=1)
    assert any("before they were created" in p for p in sa.check_data(broken))


def test_add_features(tasks):
    f = sa.add_features(tasks)
    assert f.loc[0, "hours_to_done"] == pytest.approx(2.5)
    assert np.isnan(f.loc[1, "hours_to_done"])
    assert f["was_snoozed"].tolist() == [True, False]
    assert f["has_steps"].tolist() == [True, False]
    assert bool(f.loc[0, "beat_reminder"]) is True   # done 17:30 UTC, first reminder 23:00 UTC
    assert pd.isna(f.loc[1, "beat_reminder"])        # not done, no reminder
    assert f.loc[0, "step_completion"] == pytest.approx(1.0)
    assert np.isnan(f.loc[1, "step_completion"])


def test_summary_by_counts_each_group(tasks):
    table = sa.summary_by(sa.add_features(tasks), "category")
    assert table.loc["assignment", "tasks"] == 1
    assert table.loc["assignment", "snoozed_rate"] == 1.0
    assert table.loc["errand", "completion_rate"] == 0.0


def test_daily_completions_fills_days_with_zero(tasks):
    end = pd.Timestamp("2026-10-03 12:00", tz=sa.LOCAL_TZ)
    daily = sa.daily_completions(tasks, days=3, end=end)
    assert [d.isoformat() for d in daily.index] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    assert daily.tolist() == [1, 0, 0]


def test_current_streak():
    done_at = pd.to_datetime(["2026-10-01 20:00", "2026-10-02 09:00"]).tz_localize(sa.LOCAL_TZ)
    df = pd.DataFrame({"done": [True, True], "done_at": done_at})
    # Oct 3 has nothing done yet, but the day isn't over, so the streak is still 2
    assert sa.current_streak(df, today=pd.Timestamp("2026-10-03 10:00", tz=sa.LOCAL_TZ)) == 2
    # By Oct 4 the streak has been broken
    assert sa.current_streak(df, today=pd.Timestamp("2026-10-04 10:00", tz=sa.LOCAL_TZ)) == 0


def test_bootstrap_diff_interval_contains_true_difference():
    a = [1] * 30 + [0] * 70   # 30%
    b = [1] * 60 + [0] * 40   # 60%
    diff, low, high = sa.bootstrap_diff(a, b, n_boot=2000, seed=1)
    assert diff == pytest.approx(-0.3)
    assert low < -0.3 < high
    assert high < 0


def test_steps_vs_snoozing_needs_both_groups(tasks):
    with pytest.raises(ValueError):
        sa.steps_vs_snoozing(sa.add_features(tasks))


def test_to_sqlite_round_trip(tasks):
    conn = sqlite3.connect(":memory:")
    assert sa.to_sqlite(tasks, conn) == 2
    assert conn.execute("SELECT COUNT(*), SUM(done) FROM tasks").fetchone() == (2, 1)
    conn.close()


def test_generator_is_reproducible_and_matches_export_format(tmp_path):
    first = gen.generate(rows=60, seed=7)
    assert first == gen.generate(rows=60, seed=7)
    assert gen.COLUMNS == sa.EXPECTED_COLUMNS

    path = tmp_path / "sample.csv"
    gen.write_csv(first, path)
    df = sa.add_features(sa.load_tasks(path))
    assert len(df) == 60
    assert sa.check_data(df) == []


def test_full_analysis_runs_on_sample_data(tmp_path):
    path = tmp_path / "sample.csv"
    gen.write_csv(gen.generate(rows=320, seed=2026), path)
    df = sa.add_features(sa.load_tasks(path))

    steps = sa.steps_vs_snoozing(df, n_boot=500)
    assert 0 <= steps["p_value"] <= 1
    assert steps["ci_low"] <= steps["difference"] <= steps["ci_high"]

    odds = sa.snooze_odds_ratios(df)
    assert "has steps (vs none)" in odds.index
    assert (odds["odds_ratio"] > 0).all()

    cv = sa.snooze_model_cv(df, folds=5)
    assert 0 <= cv["auc_mean"] <= 1
    assert cv["baseline_auc"] == pytest.approx(0.5)
