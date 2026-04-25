"""PDF report generation using ReportLab."""

from datetime import date
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)

_BLUE = colors.HexColor("#1A5276")
_LIGHT_BLUE = colors.HexColor("#D6EAF8")
_GREEN = colors.HexColor("#1E8449")
_ORANGE = colors.HexColor("#CA6F1E")
_RED = colors.HexColor("#922B21")


def generate_report(analysis_result: dict, output_path: str) -> str:
    """
    Generate a PDF infrastructure report from an analyze_spring_location result.

    Returns the absolute path of the written PDF file.
    """
    output_path = str(Path(output_path).with_suffix(".pdf"))

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
    )

    styles = _build_styles()
    story = []

    story += _header(analysis_result, styles)
    story += _summary_box(analysis_result, styles)
    story += _spring_analysis_section(analysis_result, styles)
    story += _water_reserve_section(analysis_result, styles)
    story += _route_section(analysis_result, styles)
    story += _cost_section(analysis_result, styles)
    story += _alternatives_section(analysis_result, styles)
    story += _footer_section(styles)

    doc.build(story)
    return output_path


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------

def _header(result: dict, styles: dict) -> list:
    loc = result.get("location", {})
    village = result.get("village", {})
    today = date.today().strftime("%d %B %Y")

    elements = [
        Paragraph("H2Oolkit — Spring Water Infrastructure Report", styles["title"]),
        Paragraph(
            f"Village: <b>{village.get('name', 'Unknown')}</b> &nbsp;|&nbsp; "
            f"Spring coordinates: {loc.get('lat', 0):.5f}°N, {loc.get('lon', 0):.5f}°E &nbsp;|&nbsp; "
            f"Elevation: {loc.get('elevation', 0):.0f} m &nbsp;|&nbsp; {today}",
            styles["subtitle"],
        ),
        HRFlowable(width="100%", thickness=2, color=_BLUE),
        Spacer(1, 0.3 * cm),
    ]
    return elements


def _summary_box(result: dict, styles: dict) -> list:
    prob = result.get("spring_analysis", {}).get("spring_probability", 0)
    flow = result.get("water_reserve", {}).get("daily_flow_liters", 0)
    cost = result.get("cost", {}).get("total_cost_eur", 0)
    grant = result.get("cost", {}).get("pnrr_grant_eur", 0)
    contrib = result.get("cost", {}).get("village_contribution_eur", 0)
    confidence = result.get("overall_confidence", 0)
    recommendation = result.get("recommendation", "")

    prob_color = _GREEN if prob >= 0.65 else (_ORANGE if prob >= 0.40 else _RED)

    data = [
        ["Spring Probability", "Daily Flow", "Total Cost", "PNRR Grant", "Village Pays", "Confidence"],
        [
            Paragraph(f'<font color="{prob_color.hexval()}">{prob:.0%}</font>', styles["summary_value"]),
            Paragraph(f"{flow:,.0f} L/day", styles["summary_value"]),
            Paragraph(f"{cost:,.0f} EUR", styles["summary_value"]),
            Paragraph(f"{grant:,.0f} EUR", styles["summary_value"]),
            Paragraph(f"{contrib:,.0f} EUR", styles["summary_value"]),
            Paragraph(f"{confidence:.0%}", styles["summary_value"]),
        ],
    ]
    table = Table(data, colWidths=[3.0 * cm] * 6)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("BACKGROUND", (0, 1), (-1, 1), _LIGHT_BLUE),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, 1), [_LIGHT_BLUE]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))

    return [
        Paragraph("Executive Summary", styles["section"]),
        table,
        Spacer(1, 0.3 * cm),
        Paragraph(recommendation, styles["recommendation"]),
        Spacer(1, 0.4 * cm),
    ]


def _spring_analysis_section(result: dict, styles: dict) -> list:
    spring = result.get("spring_analysis", {})
    signals = spring.get("signal_scores", {})

    rows = [["Signal", "Score", "Weight"]]
    weights = {"vegetation_anomaly": "35%", "soil_moisture": "30%", "jrc_water_history": "20%", "topography": "15%"}
    labels = {
        "vegetation_anomaly": "Dry-season vegetation anomaly (Sentinel-2 NDVI)",
        "soil_moisture": "Summer soil moisture (Sentinel-1)",
        "jrc_water_history": "Historical surface water (JRC dataset)",
        "topography": "Topographic suitability (slope 5–30°)",
    }
    for key, label in labels.items():
        score = signals.get(key, 0)
        bar = "█" * int(score * 10) + "░" * (10 - int(score * 10))
        rows.append([label, f"{bar} {score:.2f}", weights.get(key, "")])

    penalty = spring.get("river_penalty_applied", 0)
    if penalty > 0:
        rows.append(["River proximity penalty", f"-{penalty:.2f}", "—"])

    table = _make_table(rows, styles)
    return [
        Paragraph("Spring Detection Analysis", styles["section"]),
        Paragraph(spring.get("recommendation", ""), styles["body"]),
        Spacer(1, 0.2 * cm),
        table,
        Spacer(1, 0.4 * cm),
    ]


def _water_reserve_section(result: dict, styles: dict) -> list:
    wr = result.get("water_reserve", {})
    proj = wr.get("three_year_projection_m3", {})
    weather = result.get("weather", {})

    rows = [
        ["Parameter", "Value"],
        ["Estimated daily flow", f"{wr.get('daily_flow_liters', 0):,.0f} L/day"],
        ["Sustainable annual volume", f"{wr.get('sustainable_annual_m3', 0):,.0f} m³/year"],
        ["Mean annual precipitation", f"{weather.get('mean_annual_precipitation_mm', 0):.0f} mm/year"],
        ["Estimated groundwater recharge", f"{weather.get('estimated_recharge_mm', 0):.0f} mm/year"],
        ["Precipitation trend", f"{weather.get('trend_mm_per_year', 0):+.1f} mm/year"],
        ["Catchment area", f"{wr.get('catchment_area_km2', 0):.2f} km²"],
        ["3-year projection (Y1 / Y2 / Y3)",
         f"{proj.get('year_1', 0):,.0f} / {proj.get('year_2', 0):,.0f} / {proj.get('year_3', 0):,.0f} m³"],
    ]
    table = _make_table(rows, styles)
    return [
        Paragraph("Water Reserve Estimate", styles["section"]),
        Paragraph(wr.get("recommendation", ""), styles["body"]),
        Spacer(1, 0.2 * cm),
        table,
        Spacer(1, 0.4 * cm),
    ]


def _route_section(result: dict, styles: dict) -> list:
    route = result.get("route", {})
    rows = [
        ["Parameter", "Value"],
        ["Straight-line distance", f"{route.get('straight_line_distance_m', 0) / 1000:.2f} km"],
        ["Terrain-adjusted distance", f"{route.get('terrain_adjusted_distance_km', 0):.2f} km"],
        ["Elevation difference", f"{route.get('elevation_difference_m', 0):+.0f} m"],
        ["Feed type", route.get("feed_type", "unknown").capitalize()],
        ["Recommended pipe diameter", f"{route.get('pipe_diameter_mm', 0)} mm"],
        ["Pressure class", route.get("pressure_class", "PN10")],
    ]
    table = _make_table(rows, styles)
    return [
        Paragraph("Pipeline Route", styles["section"]),
        Paragraph(route.get("recommendation", ""), styles["body"]),
        Spacer(1, 0.2 * cm),
        table,
        Spacer(1, 0.4 * cm),
    ]


def _cost_section(result: dict, styles: dict) -> list:
    cost = result.get("cost", {})
    breakdown = cost.get("breakdown_eur", {})

    rows = [["Cost Component", "EUR", "RON"]]
    labels = {
        "pipeline_eur": "Pipeline",
        "pumping_eur": "Pumping station",
        "treatment_plant_eur": "Treatment plant",
        "reservoir_eur": "Reservoir",
        "household_connections_eur": "Household connections",
    }
    for key, label in labels.items():
        eur = breakdown.get(key, 0)
        if eur > 0:
            rows.append([label, f"{eur:,.0f}", f"{eur * 5:,.0f}"])

    rows.append(["TOTAL", f"{cost.get('total_cost_eur', 0):,.0f}", f"{cost.get('total_cost_ron', 0):,.0f}"])
    rows.append(["PNRR grant (85%)", f"-{cost.get('pnrr_grant_eur', 0):,.0f}", ""])
    rows.append([
        "Village contribution",
        f"{cost.get('village_contribution_eur', 0):,.0f}",
        f"{cost.get('village_contribution_ron', 0):,.0f}",
    ])
    rows.append([
        f"Cost per household ({cost.get('households', 0)} HH)",
        f"{cost.get('cost_per_household_eur', 0):,.0f}",
        f"{cost.get('cost_per_household_eur', 0) * 5:,.0f}",
    ])

    table = _make_table(rows, styles, bold_last=True)
    return [
        Paragraph("Infrastructure Cost Estimate", styles["section"]),
        Paragraph(cost.get("recommendation", ""), styles["body"]),
        Spacer(1, 0.2 * cm),
        table,
        Paragraph(
            "<i>Cost basis: Romanian PNRR/ANRSC public data. 1 EUR ≈ 5 RON.</i>",
            styles["note"],
        ),
        Spacer(1, 0.4 * cm),
    ]


def _alternatives_section(result: dict, styles: dict) -> list:
    springs = result.get("known_springs_nearby", [])
    if not springs:
        return [
            Paragraph("Nearby Known Springs (OpenStreetMap)", styles["section"]),
            Paragraph("No mapped springs found within 5 km radius.", styles["body"]),
            Spacer(1, 0.4 * cm),
        ]

    rows = [["Name", "Distance", "Drinking Water", "OSM ID"]]
    for s in springs[:5]:
        rows.append([
            s.get("name", "Unnamed"),
            f"{s.get('distance_m', 0) / 1000:.2f} km",
            s.get("drinking_water", "unknown"),
            str(s.get("id", "")),
        ])
    table = _make_table(rows, styles)
    return [
        Paragraph("Nearby Known Springs (OpenStreetMap)", styles["section"]),
        table,
        Spacer(1, 0.4 * cm),
    ]


def _footer_section(styles: dict) -> list:
    return [
        HRFlowable(width="100%", thickness=1, color=colors.grey),
        Spacer(1, 0.2 * cm),
        Paragraph(
            "Generated by H2Oolkit · CASSINI Hackathon — Space for Water · "
            "Satellite data: Copernicus Sentinel-1/2 via Google Earth Engine · "
            "Field survey guidance: Galileo GNSS",
            styles["note"],
        ),
    ]


# ---------------------------------------------------------------------------
# Style helpers
# ---------------------------------------------------------------------------

def _build_styles() -> dict:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("title", parent=base["Title"], fontSize=16, textColor=_BLUE, spaceAfter=4),
        "subtitle": ParagraphStyle("subtitle", parent=base["Normal"], fontSize=9, textColor=colors.grey, spaceAfter=6),
        "section": ParagraphStyle("section", parent=base["Heading2"], fontSize=12, textColor=_BLUE, spaceBefore=8, spaceAfter=4),
        "body": ParagraphStyle("body", parent=base["Normal"], fontSize=9, leading=13),
        "recommendation": ParagraphStyle("rec", parent=base["Normal"], fontSize=9, leading=13,
                                          backColor=_LIGHT_BLUE, borderPad=6, leftIndent=6),
        "summary_value": ParagraphStyle("sv", parent=base["Normal"], fontSize=11, alignment=1,
                                         fontName="Helvetica-Bold"),
        "note": ParagraphStyle("note", parent=base["Normal"], fontSize=7, textColor=colors.grey),
    }


def _make_table(rows: list, styles: dict, bold_last: bool = False) -> Table:
    col_count = len(rows[0])
    col_width = 17.0 / col_count * cm
    table = Table(rows, colWidths=[col_width] * col_count)
    ts = [
        ("BACKGROUND", (0, 0), (-1, 0), _BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _LIGHT_BLUE]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if bold_last:
        ts += [
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), _LIGHT_BLUE),
        ]
    table.setStyle(TableStyle(ts))
    return table
