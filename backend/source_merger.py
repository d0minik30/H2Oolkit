"""
Source deduplication: identifies OSM and EU-Hydro entries that refer to the
same physical water body and merges them into a single enriched record.

Merge decision formula
----------------------
    P(same) = distance_score × type_score

    distance_score = exp(-distance_m / DISTANCE_DECAY)
                     → 1.00 at   0 m
                     → 0.72 at  50 m
                     → 0.51 at 100 m
                     → 0.26 at 200 m

    type_score = 0.5 + 0.5 × type_compatibility   (range 0.50 – 1.00)

    MERGE_THRESHOLD = 0.60  — pairs at or above this probability are merged
    MAX_DISTANCE_M  = 300   — pairs beyond this are never considered
    DISTANCE_DECAY  = 150   — decay constant (metres)

At threshold 0.60:
  same type, 50 m  → P ≈ 0.72 × 1.0  = 0.72  ✓ merged
  same type, 90 m  → P ≈ 0.55 × 1.0  = 0.55  ✗ separate sources
  diff type, 30 m  → P ≈ 0.82 × 0.60 = 0.49  ✗ separate sources
"""

import math
import logging

log = logging.getLogger("h2oolkit.merger")

MERGE_THRESHOLD = 0.60
MAX_DISTANCE_M  = 300
DISTANCE_DECAY  = 150

_TYPE_COMPAT: dict[tuple, float] = {
    ("lake",      "lake"):      1.0,
    ("lake",      "reservoir"): 0.8,
    ("reservoir", "lake"):      0.8,
    ("lake",      "pond"):      0.8,
    ("pond",      "lake"):      0.8,
    ("spring",    "spring"):    1.0,
    ("stream",    "river"):     0.7,
    ("river",     "stream"):    0.7,
    ("river",     "river"):     1.0,
    ("well",      "spring"):    0.4,
    ("spring",    "well"):      0.4,
}


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def same_source_probability(a: dict, b: dict) -> float:
    """
    Return the probability (0–1) that sources *a* and *b* refer to the same
    physical water body.

        P = exp(-d / DISTANCE_DECAY) × (0.5 + 0.5 × type_compatibility)
    """
    dist_m = _haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
    if dist_m > MAX_DISTANCE_M:
        return 0.0

    distance_score = math.exp(-dist_m / DISTANCE_DECAY)

    type_a = a.get("source_type", "unknown")
    type_b = b.get("source_type", "unknown")
    compat = _TYPE_COMPAT.get(
        (type_a, type_b),
        1.0 if type_a == type_b else 0.2,
    )

    return round(distance_score * (0.5 + 0.5 * compat), 3)


def merge_sources(osm_sources: list, eu_hydro_sources: list) -> list:
    """
    Merge OSM and EU-Hydro source lists, collapsing duplicates.

    Strategy
    --------
    For each OSM source, find the best-matching EU-Hydro source by
    same_source_probability.  If the best match reaches MERGE_THRESHOLD:
      - The OSM record is kept (authoritative for coordinates and name).
      - EU-Hydro metadata (eu_hydro_note, elevation fallback) enriches it.
      - ``data_sources`` becomes ["osm", "eu_hydro"].

    EU-Hydro sources with no OSM match are appended as standalone entries.

    Every source in the result gains a ``data_sources`` list field.
    """
    eu_matched: set[int] = set()

    annotated_osm = [dict(s) for s in osm_sources]
    for entry in annotated_osm:
        entry.setdefault("data_sources", ["osm"])

    for osm in annotated_osm:
        best_prob   = 0.0
        best_eu_idx = None

        for eu_idx, eu in enumerate(eu_hydro_sources):
            if eu_idx in eu_matched:
                continue
            prob = same_source_probability(osm, eu)
            if prob > best_prob:
                best_prob   = prob
                best_eu_idx = eu_idx

        if best_eu_idx is not None and best_prob >= MERGE_THRESHOLD:
            eu = eu_hydro_sources[best_eu_idx]
            eu_matched.add(best_eu_idx)

            osm["eu_hydro_linked"]   = True
            osm["eu_hydro_note"]     = eu.get(
                "eu_hydro_note", "Matched to EU-Hydro official water body."
            )
            osm["data_sources"]      = ["osm", "eu_hydro"]
            osm["merge_probability"] = best_prob
            if not osm.get("elevation") and eu.get("elevation"):
                osm["elevation"] = eu["elevation"]

            log.debug(
                "Merged: OSM '%s' ↔ EU-Hydro '%s' (P=%.2f, dist=%.0f m)",
                osm.get("name"), eu.get("name"), best_prob,
                _haversine_m(osm["lat"], osm["lon"], eu["lat"], eu["lon"]),
            )

    standalone_eu = []
    for eu_idx, eu in enumerate(eu_hydro_sources):
        if eu_idx not in eu_matched:
            entry = dict(eu)
            entry.setdefault("data_sources", ["eu_hydro"])
            standalone_eu.append(entry)

    merged = annotated_osm + standalone_eu
    log.info(
        "Source merger: %d OSM + %d EU-Hydro → %d total (%d duplicates removed)",
        len(osm_sources), len(eu_hydro_sources),
        len(merged), len(eu_matched),
    )
    return merged
