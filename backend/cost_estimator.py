"""Infrastructure requirements estimation (pipeline distance, no monetary values)."""

import math

AVG_HOUSEHOLD_SIZE = 2.8
DAILY_LITERS_PER_PERSON = 120.0


def estimate_infrastructure_cost(
    distance_to_village_km: float,
    elevation_difference_m: float,
    village_population: int,
    daily_flow_liters: float,
) -> dict:
    """
    Estimate pipeline requirements for a spring-to-village water system.

    elevation_difference_m: positive = spring is higher than village (gravity feed),
                             negative = spring is lower (pumping required).

    Returns pipeline distance in km, supply feasibility, and operational notes.
    No monetary values are included.
    """
    households = max(1, math.ceil(village_population / AVG_HOUSEHOLD_SIZE))
    daily_demand_liters = village_population * DAILY_LITERS_PER_PERSON
    supply_ratio = daily_flow_liters / daily_demand_liters if daily_demand_liters > 0 else 0.0

    needs_pumping = elevation_difference_m < 0
    reservoir_m3 = math.ceil(daily_demand_liters * 1.5 / 1000)

    feasibility = _feasibility(supply_ratio)
    recommendation = _recommendation(supply_ratio, needs_pumping, feasibility)

    return {
        "pipeline_km": round(distance_to_village_km, 2),
        "needs_pumping": needs_pumping,
        "elevation_diff_m": round(elevation_difference_m, 1),
        "households": households,
        "reservoir_m3": reservoir_m3,
        "supply_covers_demand_pct": round(supply_ratio * 100, 1),
        "feasibility": feasibility,
        "confidence": 0.75,
        "recommendation": recommendation,
    }


def _feasibility(supply_ratio: float) -> str:
    if supply_ratio < 0.5:
        return "insufficient_supply"
    if supply_ratio < 0.8:
        return "marginal"
    return "viable"


def _recommendation(supply_ratio: float, needs_pumping: bool, feasibility: str) -> str:
    parts = []

    if feasibility == "insufficient_supply":
        parts.append("Spring flow is insufficient to meet village demand — consider combining multiple springs.")
    elif feasibility == "marginal":
        parts.append("Spring flow covers partial demand — supplement with rainwater harvesting or a second source.")
    else:
        parts.append("Spring flow is sufficient for full village supply.")

    if needs_pumping:
        parts.append("Gravity feed is not possible; a pumping station will be required.")
    else:
        parts.append("Gravity-fed system possible — no pumping required.")

    return " ".join(parts)
