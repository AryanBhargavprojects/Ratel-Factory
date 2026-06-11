/**
 * ratel-observatory.ts — Pi extension entry point
 *
 * Re-exports the `view_observatory` extension from src/observability/dashboard.ts
 * so Pi's auto-discovery (which scans .pi/extensions/*.ts) picks it up.
 *
 * Implementation lives in src/observability/dashboard.ts so it ships with the
 * rest of the source code and stays testable.
 */

export { default } from "../../src/observatory/dashboard.js";
