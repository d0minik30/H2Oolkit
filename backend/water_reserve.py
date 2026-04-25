"""Groundwater volume estimation and 3-year trend from catchment + precipitation data."""

import numpy as np

RUNOFF_COEFFICIENT = 0.25     # Carpathian zone
SAFETY_FACTOR = 0.70          # Extract no more than 70% of estimated recharge
LITERS_PER_M3 = 1_000.0


def estimate_water_reserve(
    catchment_area_km2: float,
    annual_recharge_mm: float,
    precipitation_trend: float,
    spring_probability: float,
) -> dict:
    """
    Estimate sustainable daily flow and 3-year forward projection.

    catchment_area_km2    : contributing catchment from DEM analysis
    annual_recharge_mm    : effective recharge (precip - ET) × runoff coefficient
    precipitation_trend   : mm/year change in annual precipitation (from weather.py)
    spring_probability    : 0–1 score from spring_detector (scales confidence)
    """
    catchment_m2 = catchment_area_km2 * 1_000_000.0

    # Annual groundwater recharge volume
    annual_recharge_m3 = catchment_m2 * (annual_recharge_mm / 1_000.0) * RUNOFF_COEFFICIENT
    sustainable_annual_m3 = annual_recharge_m3 * SAFETY_FACTOR
    daily_flow_m3 = sustainable_annual_m3 / 365.0
    daily_flow_liters = daily_flow_m3 * LITERS_PER_M3

    # 3-year trend: how much does annual recharge change each year?
    recharge_trend_m3_per_year = (
        catchment_m2 * (precipitation_trend / 1_000.0) * RUNOFF_COEFFICIENT * SAFETY_FACTOR
    )
    year1 = sustainable_annual_m3
    year2 = sustainable_annual_m3 + recharge_trend_m3_per_year
    year3 = sustainable_annual_m3 + 2 * recharge_trend_m3_per_year

    trend_pct = (recharge_trend_m3_per_year / max(sustainable_annual_m3, 1)) * 100

    confidence = _confidence(catchment_area_km2, annual_recharge_mm, spring_probability)
    recommendation = _recommendation(daily_flow_liters, trend_pct, confidence, spring_probability)

    return {
        "daily_flow_liters": round(daily_flow_liters, 1),
        "daily_flow_m3": round(daily_flow_m3, 3),
        "sustainable_annual_m3": round(sustainable_annual_m3, 1),
        "annual_recharge_m3": round(annual_recharge_m3, 1),
        "three_year_projection_m3": {
            "year_1": round(year1, 1),
            "year_2": round(year2, 1),
            "year_3": round(year3, 1),
        },
        "trend_pct_per_year": round(trend_pct, 2),
        "catchment_area_km2": catchment_area_km2,
        "runoff_coefficient": RUNOFF_COEFFICIENT,
        "confidence": round(confidence, 2),
        "recommendation": recommendation,
    }


def _confidence(catchment_km2: float, recharge_mm: float, spring_prob: float) -> float:
    base = 0.60
    if catchment_km2 <= 0 or recharge_mm <= 0:
        return 0.20
    # Confidence scales with spring probability and reasonableness of inputs
    if catchment_km2 > 50:
        base -= 0.10  # very large catchment — GEE delineation may be imprecise
    base *= (0.5 + 0.5 * spring_prob)
    return float(np.clip(base, 0.20, 0.85))


def _recommendation(
    daily_liters: float, trend_pct: float,
    confidence: float, spring_prob: float,
) -> str:
    if spring_prob < 0.40:
        return (
            "Low spring probability — water volume estimates are speculative. "
            "Do not use for infrastructure sizing without field confirmation."
        )

    if daily_liters >= 10_000:
        supply_text = f"Estimated flow of {daily_liters:,.0f} L/day is sufficient for a small village."
    elif daily_liters >= 2_000:
        supply_text = f"Estimated flow of {daily_liters:,.0f} L/day supports 10–60 households."
    else:
        supply_text = f"Low estimated flow ({daily_liters:,.0f} L/day) — suitable only for a few households."

    if trend_pct < -5:
        trend_text = f"Declining trend ({trend_pct:.1f}%/yr) — capacity may decrease over time."
    elif trend_pct > 5:
        trend_text = f"Improving trend (+{trend_pct:.1f}%/yr) — recharge conditions strengthening."
    else:
        trend_text = "Stable long-term precipitation trend."

    conf_text = f"Estimate confidence: {confidence:.0%}." if confidence < 0.60 else ""

    return f"{supply_text} {trend_text} {conf_text}".strip()
