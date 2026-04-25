"""Open-Meteo historical precipitation and evapotranspiration."""

from datetime import date, timedelta
from typing import Optional
import requests
import numpy as np

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = 20


def get_historical_precipitation(lat: float, lon: float, years: int = 10) -> dict:
    """
    Fetch daily precipitation and ET₀ for the past `years` years from Open-Meteo.

    Returns a dict with annual/seasonal summaries and a 3-year linear trend.
    Falls back to regional defaults if the API is unreachable.
    """
    end = date.today() - timedelta(days=1)
    start = date(end.year - years, end.month, end.day)

    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": "precipitation_sum,et0_fao_evapotranspiration",
        "timezone": "auto",
    }

    try:
        resp = requests.get(ARCHIVE_URL, params=params, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        return _fallback_precipitation(lat, lon, years, error=str(exc))

    daily = data.get("daily", {})
    precip_mm = [v if v is not None else 0.0 for v in daily.get("precipitation_sum", [])]
    et0_mm = [v if v is not None else 0.0 for v in daily.get("et0_fao_evapotranspiration", [])]
    time_labels = daily.get("time", [])

    if not precip_mm:
        return _fallback_precipitation(lat, lon, years, error="empty response")

    annual_mm = _annual_totals(time_labels, precip_mm)
    annual_et0 = _annual_totals(time_labels, et0_mm)

    mean_annual_precip = float(np.mean(annual_mm)) if annual_mm else 0.0
    mean_annual_et0 = float(np.mean(annual_et0)) if annual_et0 else 0.0
    trend_mm_per_year = _linear_trend(annual_mm)

    dry_season_mm = _seasonal_mean(time_labels, precip_mm, months=[6, 7, 8])
    wet_season_mm = _seasonal_mean(time_labels, precip_mm, months=[3, 4, 5])

    recharge_mm = max(0.0, (mean_annual_precip - mean_annual_et0) * 0.25)

    if mean_annual_precip > 800:
        recommendation = "High precipitation zone — strong groundwater recharge potential."
    elif mean_annual_precip > 500:
        recommendation = "Moderate precipitation — seasonal spring flow likely; verify in dry months."
    else:
        recommendation = "Low precipitation — spring reliability uncertain; require dry-season field check."

    return {
        "mean_annual_precipitation_mm": round(mean_annual_precip, 1),
        "mean_annual_et0_mm": round(mean_annual_et0, 1),
        "estimated_recharge_mm": round(recharge_mm, 1),
        "dry_season_monthly_avg_mm": round(dry_season_mm, 1),
        "wet_season_monthly_avg_mm": round(wet_season_mm, 1),
        "trend_mm_per_year": round(trend_mm_per_year, 2),
        "annual_series": annual_mm,
        "years_analyzed": years,
        "confidence": 0.90,
        "recommendation": recommendation,
        "source": "Open-Meteo Archive API",
        "fallback": False,
    }


def get_forecast_precipitation(lat: float, lon: float, days: int = 7) -> dict:
    """48-hour (or up to 7-day) precipitation forecast from Open-Meteo."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "precipitation_sum,precipitation_probability_max",
        "forecast_days": min(days, 16),
        "timezone": "auto",
    }
    try:
        resp = requests.get(FORECAST_URL, params=params, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        return {"error": str(exc), "fallback": True}

    daily = data.get("daily", {})
    return {
        "dates": daily.get("time", []),
        "precipitation_mm": daily.get("precipitation_sum", []),
        "probability_pct": daily.get("precipitation_probability_max", []),
        "fallback": False,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _annual_totals(time_labels: list, values: list) -> list[float]:
    from collections import defaultdict
    by_year: dict = defaultdict(float)
    for t, v in zip(time_labels, values):
        year = t[:4]
        by_year[year] += v if v else 0.0
    return [round(v, 1) for v in by_year.values()]


def _seasonal_mean(time_labels: list, values: list, months: list[int]) -> float:
    subset = [v for t, v in zip(time_labels, values) if int(t[5:7]) in months]
    if not subset:
        return 0.0
    days_per_month = len(subset) / len(months) / max(1, len(set(t[:4] for t in time_labels)))
    return float(np.sum(subset) / max(1, len(set(t[:4] for t in time_labels))))


def _linear_trend(series: list[float]) -> float:
    if len(series) < 2:
        return 0.0
    x = np.arange(len(series), dtype=float)
    y = np.array(series, dtype=float)
    coeffs = np.polyfit(x, y, 1)
    return float(coeffs[0])


def _fallback_precipitation(lat: float, lon: float, years: int, error: str = "") -> dict:
    """Regional defaults for Carpathian Romania when API is unavailable."""
    mean_annual = 800.0 if lat > 45.0 else 600.0
    return {
        "mean_annual_precipitation_mm": mean_annual,
        "mean_annual_et0_mm": 550.0,
        "estimated_recharge_mm": round((mean_annual - 550.0) * 0.25, 1),
        "dry_season_monthly_avg_mm": 45.0,
        "wet_season_monthly_avg_mm": 90.0,
        "trend_mm_per_year": 0.0,
        "annual_series": [mean_annual] * years,
        "years_analyzed": years,
        "confidence": 0.40,
        "recommendation": "API unavailable — using regional defaults. Field verification required.",
        "source": "regional fallback",
        "fallback": True,
        "error": error,
    }
