"""Infrastructure cost estimation using Romanian PNRR/ANRSC public data."""

import math

EUR_TO_RON = 5.0
AVG_HOUSEHOLD_SIZE = 2.8
# Matches extraction/fetch_villages.py WATER_PER_CAPITA_L so live-analysis
# demand lines up with the water_need_m3_day values shown on village zones.
DAILY_LITERS_PER_PERSON = 120.0
PNRR_COVERAGE = 0.85          # 85% for communes < 10,000 population
PNRR_POPULATION_LIMIT = 10_000

COSTS = {
    "pipeline_eur_per_km": 85_000,
    "pumping_station_base_eur": 45_000,
    "pumping_per_meter_elevation_eur": 800,
    "treatment_plant_eur": 25_000,
    "reservoir_eur_per_m3": 150,
    "connection_per_household_eur": 1_200,
}


def estimate_infrastructure_cost(
    distance_to_village_km: float,
    elevation_difference_m: float,
    village_population: int,
    daily_flow_liters: float,
) -> dict:
    """
    Estimate total water infrastructure cost for a spring-to-village system.

    elevation_difference_m: positive = spring is higher than village (gravity feed),
                             negative = spring is lower (pumping required).
    """
    households = max(1, math.ceil(village_population / AVG_HOUSEHOLD_SIZE))
    daily_demand_liters = village_population * DAILY_LITERS_PER_PERSON
    supply_ratio = daily_flow_liters / daily_demand_liters if daily_demand_liters > 0 else 0.0

    # Pipeline
    pipeline_eur = distance_to_village_km * COSTS["pipeline_eur_per_km"]

    # Pumping — only when spring is below village
    pumping_eur = 0.0
    needs_pumping = elevation_difference_m < 0
    if needs_pumping:
        lift_m = abs(elevation_difference_m)
        pumping_eur = COSTS["pumping_station_base_eur"] + lift_m * COSTS["pumping_per_meter_elevation_eur"]

    # Treatment plant
    treatment_eur = COSTS["treatment_plant_eur"]

    # Reservoir — size for 1.5 days of demand, converted to m³
    reservoir_m3 = math.ceil(daily_demand_liters * 1.5 / 1000)
    reservoir_eur = reservoir_m3 * COSTS["reservoir_eur_per_m3"]

    # Household connections
    connections_eur = households * COSTS["connection_per_household_eur"]

    total_eur = pipeline_eur + pumping_eur + treatment_eur + reservoir_eur + connections_eur

    pnrr_eligible = village_population < PNRR_POPULATION_LIMIT
    pnrr_grant_eur = total_eur * PNRR_COVERAGE if pnrr_eligible else 0.0
    village_contribution_eur = total_eur - pnrr_grant_eur

    breakdown = {
        "pipeline_eur": round(pipeline_eur),
        "pumping_eur": round(pumping_eur),
        "treatment_plant_eur": round(treatment_eur),
        "reservoir_eur": round(reservoir_eur),
        "household_connections_eur": round(connections_eur),
    }

    feasibility = _feasibility(supply_ratio, total_eur, village_population)
    recommendation = _recommendation(
        supply_ratio, needs_pumping, pnrr_eligible,
        village_contribution_eur, households, feasibility,
    )

    return {
        "total_cost_eur": round(total_eur),
        "total_cost_ron": round(total_eur * EUR_TO_RON),
        "breakdown_eur": breakdown,
        "pnrr_eligible": pnrr_eligible,
        "pnrr_grant_eur": round(pnrr_grant_eur),
        "village_contribution_eur": round(village_contribution_eur),
        "village_contribution_ron": round(village_contribution_eur * EUR_TO_RON),
        "cost_per_household_eur": round(village_contribution_eur / households),
        "households": households,
        "reservoir_m3": reservoir_m3,
        "needs_pumping": needs_pumping,
        "supply_covers_demand_pct": round(supply_ratio * 100, 1),
        "feasibility": feasibility,
        "confidence": 0.75,
        "recommendation": recommendation,
    }


def _feasibility(supply_ratio: float, total_eur: float, population: int) -> str:
    if supply_ratio < 0.5:
        return "insufficient_supply"
    if supply_ratio < 0.8:
        return "marginal"
    if total_eur / max(population, 1) > 5_000:
        return "high_cost"
    return "viable"


def _recommendation(
    supply_ratio: float,
    needs_pumping: bool,
    pnrr_eligible: bool,
    contribution_eur: float,
    households: int,
    feasibility: str,
) -> str:
    parts = []

    if feasibility == "insufficient_supply":
        parts.append("Spring flow is insufficient to meet village demand — consider combining multiple springs.")
    elif feasibility == "marginal":
        parts.append("Spring flow covers partial demand — supplement with rainwater harvesting or a second source.")
    elif feasibility == "viable":
        parts.append("Spring flow is sufficient for full village supply.")

    if needs_pumping:
        parts.append("Gravity feed is not possible; pumping station required (increases operational costs).")
    else:
        parts.append("Gravity-fed system possible — no pumping costs.")

    if pnrr_eligible:
        per_hh = round(contribution_eur / households)
        parts.append(
            f"PNRR financing covers 85% of cost. Village contribution: ~{per_hh:,} EUR/household."
        )
    else:
        parts.append("Village exceeds PNRR population limit — full cost must be locally financed or via county budget.")

    return " ".join(parts)
