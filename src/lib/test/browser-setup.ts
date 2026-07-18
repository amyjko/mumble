/**
 * Browser-mode test setup: pull the design tokens into the test page.
 *
 * Components take every size, color, and radius from app.css. Without it,
 * `var(--control-height)` and friends resolve to nothing, sizing rules become
 * invalid, and elements collapse to content width — a component test would
 * then be asserting against a component that cannot exist in the app. Loading
 * the real stylesheet keeps layout assertions (target sizes, ring widths)
 * meaningful.
 */
import '../../app.css';
