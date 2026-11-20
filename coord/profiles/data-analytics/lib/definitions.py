"""Canonical definitions — ONE place for the constants every analytic agrees on
(generic template).

A drifting definition silently dilutes or inflates every downstream rate. Pin the
load-bearing definitions here and import them everywhere instead of re-deriving:
  - period bounds (the reporting window),
  - the FX / currency rule (enforced by the currency_suffix gate),
  - segment normalizers (so a label maps to exactly one canonical bucket).

TODO(borrower): resolve every TODO below with your engagement's real values.
Keep this module pure data + small pure functions — no I/O, no side effects.
"""
from __future__ import annotations

from datetime import date


# --- Period bounds -----------------------------------------------------------
# The canonical reporting window. Every "this period" filter derives from here so
# no analytic invents its own boundaries. The period-identity gate checks that an
# output's period matches its declared `period` in pipeline.yml.
DEFAULT_PERIOD = "REPLACE_ME"              # TODO: e.g. "Q1_2026"
PERIOD_START = date(1970, 1, 1)           # TODO: first day of the window
PERIOD_END = date(1970, 1, 1)             # TODO: last day of the window (inclusive)


def in_period(d: date) -> bool:
    """True if ``d`` falls inside the canonical reporting window."""
    return PERIOD_START <= d <= PERIOD_END


# --- FX / currency rule ------------------------------------------------------
# Single source for the currency basis. Monetary columns must carry a currency
# suffix (_usd / _<local>) or be declared currency_exempt in pipeline.yml.
BASE_CURRENCY = "USD"
LOCAL_CURRENCY = "REPLACE_ME"             # TODO: e.g. "SAR"; or None if single-currency
FX_LOCAL_PER_USD: float | None = None     # TODO: e.g. 3.75; None if single-currency

CURRENCY_RULE = (
    "Declare the currency of every monetary output. Never present a local-currency "
    "figure as USD (or vice-versa). Convert only via FX_LOCAL_PER_USD."
)


def local_to_usd(amount_local: float) -> float:
    """Convert a local-currency amount to USD using the pinned FX rate.

    Raises if no FX rate is configured — fail loud rather than emit a wrong basis.
    """
    if FX_LOCAL_PER_USD is None:
        raise ValueError("FX_LOCAL_PER_USD is not set in definitions.py")
    return amount_local / FX_LOCAL_PER_USD


# --- Segment normalizers -----------------------------------------------------
# Map raw/variant labels to one canonical bucket so joins and group-bys agree.
# TODO: fill SEGMENT_ALIASES with your project's real label variants.
SEGMENT_ALIASES: dict[str, str] = {
    # "raw label (lowercased)": "canonical_segment",
    # "trad trade": "traditional_trade",
    # "modern": "modern_trade",
}


def normalize_segment(raw: str | None) -> str | None:
    """Return the canonical segment for a raw label (case/space-insensitive).

    Unknown labels pass through normalized (lower/stripped) rather than dropped —
    surface unmapped labels in a DQ probe so SEGMENT_ALIASES can be extended.
    """
    if raw is None:
        return None
    key = str(raw).strip().lower()
    return SEGMENT_ALIASES.get(key, key)


# --- Population bases ---------------------------------------------------------
# Cite a denominator BY NAME, never a raw number. Pin the canonical bases so every
# rate uses the same base. TODO: replace with your engagement's real bases.
POPULATION_BASES: dict[str, str] = {
    # "base_name": "what it counts / when to use it",
    # "all_active":  "THE operating denominator — rates, %-of-X, opportunity sizing",
    # "all_master":  "master joins / signal layers — NEVER a denominator",
}
DEFAULT_DENOMINATOR = "REPLACE_ME"        # TODO: the base name used for rates by default
