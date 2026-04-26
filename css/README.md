# Styles

Static CSS for H2Oolkit. Loaded directly from `index.html`; no preprocessor or build step.

## Files

| File | Responsibility |
| --- | --- |
| `styles.css` | All application styling — layout, navbar, map panels, results cards, charts, light/dark themes. |

## Theming

Dark mode is driven by a `dark` class on the `<html>` element (toggled in `js/app.js`). Theme-specific rules live next to their light counterparts in `styles.css` under `html.dark …` selectors.
