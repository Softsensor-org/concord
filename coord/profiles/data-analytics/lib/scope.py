"""Scope guards — read-time filtering pattern (generic template).

PRINCIPLE: scope is a CONSUMPTION-LAYER guard, not a property of the data layer.
Certified outputs in ``06_outputs/`` are built broad (all-segment / all-period) on
purpose, so they can be reconciled and reused. A deliverable or dashboard panel
must NEVER be built directly off a broad certified file — it must apply scope
explicitly, at read time, here.

Pattern borrowed from the reference build, de-domained:
  - ``cohort_filter(df, cohort)``  — narrow a frame to a named cohort/experiment.
  - ``segment_only(df, col, value)`` — keep one segment of a categorical column.

Adapt the column-name lists and the cohort source to your project. Keep these
guards pure (no side effects) and case/whitespace-tolerant so a stray label does
not silently pass an out-of-scope row through.

TODO(borrower): wire ``_cohort_set`` to your real cohort definition file, and
extend ``_SEGMENT_COLS`` / ``_COHORT_COLS`` with your project's column aliases.
"""
from __future__ import annotations

from functools import lru_cache

import pandas as pd

# Column aliases to probe, in priority order. A frame is scoped by the FIRST
# matching column; if none match the frame is returned unchanged (so a frame
# that genuinely carries no segment/cohort axis is not silently emptied).
_SEGMENT_COLS = ["segment", "channel", "category", "group"]
_COHORT_COLS = ["cohort", "experiment", "route", "site_id", "entity_id"]


def segment_only(df: pd.DataFrame, col: str, value: str) -> pd.DataFrame:
    """Keep only rows whose ``col`` equals ``value`` (case/space-insensitive).

    Use to scope a channel/segment-bearing frame to a single segment at read
    time. Returns the frame unchanged if it is empty or lacks ``col`` — callers
    that REQUIRE the column should assert on it rather than rely on pass-through.

    Example::

        df = segment_only(load("06_outputs/example_customer_summary.csv"),
                          "segment", "retail")
    """
    if df is None or df.empty or col not in df.columns:
        return df
    want = str(value).strip().lower()
    s = df[col].astype("string").str.strip().str.lower()
    return df.loc[s.eq(want)].copy()


@lru_cache(maxsize=1)
def _cohort_set() -> frozenset:
    """The members of the named cohort/experiment, loaded once.

    TODO(borrower): replace the stub with a read of your cohort-definition file
    (e.g. a certified ``06_outputs/<cohort>_members.csv``) and return the
    frozenset of member keys. Cached because the source is a stable file.
    """
    # Example shape:
    #   members = pd.read_csv("06_outputs/example_cohort_members.csv")
    #   return frozenset(members["entity_id"].dropna().astype(str))
    return frozenset()


def cohort_filter(df: pd.DataFrame, cohort: str) -> pd.DataFrame:
    """Narrow a frame to a named cohort/experiment subset at read time.

    ``cohort=''`` (or any value other than the configured cohort name) leaves the
    full universe — the primary view. Pass the cohort name (e.g. ``'exp'``) to
    restrict to the experiment subset. Scopes by the first matching key column in
    ``_COHORT_COLS``; returns unchanged if the frame carries no such column.

    Example::

        df = cohort_filter(load("06_outputs/example_panel.csv"), "exp")
    """
    if not cohort or df is None or df.empty:
        return df
    members = _cohort_set()
    if not members:
        return df
    for c in _COHORT_COLS:
        if c in df.columns:
            return df.loc[df[c].astype(str).isin(members)].copy()
    return df
