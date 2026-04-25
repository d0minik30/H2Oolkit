"""Multi-criteria spring probability scoring from GEE satellite data."""

import numpy as np

# Signal weights must sum to 1.0
_W_NDVI = 0.35
_W_SOIL = 0.30
_W_JRC = 0.20
_W_TOPO = 0.15

_RIVER_PENALTY_THRESHOLD_M = 200.0
_RIVER_PENALTY = 0.30


def calculate_spring_probability(
    ndvi_dry: float,
    ndvi_wet: float,
    soil_moisture_summer: float,
    jrc_occurrence: float,
    slope_degrees: float,
    elevation: float,
    distance_to_river_m: float,
) -> dict:
    """
    Combine five surface-signature signals into a spring probability score.

    All inputs come from the GEE data contract. Returns probability 0–1,
    per-signal scores, dominant signal, and farmer-readable recommendation.
    """
    ndvi_score = _score_vegetation_anomaly(ndvi_dry, ndvi_wet)
    soil_score = _score_soil_moisture(soil_moisture_summer)
    jrc_score = _score_jrc_occurrence(jrc_occurrence)
    topo_score = _score_topography(slope_degrees)

    raw = (
        _W_NDVI * ndvi_score
        + _W_SOIL * soil_score
        + _W_JRC * jrc_score
        + _W_TOPO * topo_score
    )

    river_penalty = _river_proximity_penalty(distance_to_river_m)
    probability = float(np.clip(raw - river_penalty, 0.0, 1.0))

    confidence = _estimate_confidence(ndvi_dry, ndvi_wet, soil_moisture_summer, jrc_occurrence, slope_degrees)

    signals = {
        "vegetation_anomaly": round(ndvi_score, 3),
        "soil_moisture": round(soil_score, 3),
        "jrc_water_history": round(jrc_score, 3),
        "topography": round(topo_score, 3),
    }
    dominant = max(signals, key=lambda k: signals[k])

    recommendation = _build_recommendation(probability, dominant, river_penalty, slope_degrees, elevation)

    return {
        "spring_probability": round(probability, 3),
        "confidence": round(confidence, 2),
        "signal_scores": signals,
        "dominant_signal": dominant,
        "river_penalty_applied": round(river_penalty, 3),
        "recommendation": recommendation,
        "inputs": {
            "ndvi_dry": ndvi_dry,
            "ndvi_wet": ndvi_wet,
            "soil_moisture_summer": soil_moisture_summer,
            "jrc_occurrence": jrc_occurrence,
            "slope_degrees": slope_degrees,
            "elevation": elevation,
            "distance_to_river_m": distance_to_river_m,
        },
    }


# ---------------------------------------------------------------------------
# Signal scorers — each returns 0.0–1.0
# ---------------------------------------------------------------------------

def _score_vegetation_anomaly(ndvi_dry: float, ndvi_wet: float) -> float:
    """High dry-season NDVI relative to wet season signals persistent moisture."""
    if ndvi_wet <= 0:
        return 0.0
    ratio = ndvi_dry / ndvi_wet
    # 0.85+ ratio = strong anomaly; < 0.5 = seasonal dryout
    return float(np.clip((ratio - 0.5) / 0.5, 0.0, 1.0))


def _score_soil_moisture(soil_moisture_summer: float) -> float:
    """Soil moisture 0–1; values above 0.4 in summer indicate persistent wetness."""
    return float(np.clip((soil_moisture_summer - 0.2) / 0.6, 0.0, 1.0))


def _score_jrc_occurrence(jrc_occurrence: float) -> float:
    """JRC occurrence 0–100 %; moderate values (20–60) favour spring vs river."""
    if jrc_occurrence <= 0:
        return 0.0
    if jrc_occurrence > 80:
        # Very high = permanent river channel, not a spring
        return 0.2
    return float(np.clip(jrc_occurrence / 60.0, 0.0, 1.0))


def _score_topography(slope_degrees: float) -> float:
    """Springs emerge at mid-slope (5–30°). Peaks and flat plains score near zero."""
    if 5 <= slope_degrees <= 30:
        # Peak score at ~15°
        return float(1.0 - abs(slope_degrees - 15.0) / 15.0)
    if slope_degrees < 5:
        return float(np.clip(slope_degrees / 5.0 * 0.3, 0.0, 0.3))
    # > 30°: steep — springs possible but rare
    return float(np.clip(1.0 - (slope_degrees - 30.0) / 30.0, 0.0, 0.4))


def _river_proximity_penalty(distance_m: float) -> float:
    """Locations < 200 m from a known river likely represent floodplain, not spring."""
    if distance_m >= _RIVER_PENALTY_THRESHOLD_M:
        return 0.0
    return _RIVER_PENALTY * (1.0 - distance_m / _RIVER_PENALTY_THRESHOLD_M)


def _estimate_confidence(
    ndvi_dry: float, ndvi_wet: float, soil_moisture: float,
    jrc: float, slope: float,
) -> float:
    """Confidence degrades when inputs are at boundary values or likely default-filled."""
    penalties = 0.0
    if ndvi_dry == ndvi_wet:
        penalties += 0.15
    if soil_moisture in (0.0, 1.0):
        penalties += 0.10
    if jrc == 0.0:
        penalties += 0.10
    if slope == 0.0:
        penalties += 0.10
    return max(0.30, 0.90 - penalties)


def _build_recommendation(
    prob: float, dominant: str, penalty: float,
    slope: float, elevation: float,
) -> str:
    signal_labels = {
        "vegetation_anomaly": "strong dry-season vegetation anomaly",
        "soil_moisture": "persistent summer soil moisture",
        "jrc_water_history": "historical surface water presence",
        "topography": "favourable mid-slope topography",
    }
    signal_text = signal_labels.get(dominant, dominant)

    if prob >= 0.75:
        verdict = "High spring probability"
        action = "Recommend Galileo-guided field survey to confirm and geo-reference the outlet."
    elif prob >= 0.50:
        verdict = "Moderate spring probability"
        action = "Consider field inspection in dry season (July–August) to verify persistent flow."
    elif prob >= 0.30:
        verdict = "Low spring probability"
        action = "Weak signals only — field visit is unlikely to be cost-effective at this site."
    else:
        verdict = "Very low spring probability"
        action = "Not recommended for further investigation."

    penalty_note = " Note: proximity to river reduces reliability." if penalty > 0.05 else ""
    elev_note = f" Elevation {elevation:.0f} m." if elevation else ""

    return f"{verdict} ({prob:.0%}) driven by {signal_text}.{elev_note} {action}{penalty_note}"
