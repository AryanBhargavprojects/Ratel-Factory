/**
 * ratel-observatory.ts — Pi extension entry point
 *
 * Re-exports the `view_observatory` extension from @ratel/core so Pi's
 * auto-discovery (which scans .pi/extensions/*.ts) picks it up.
 */

import { registerObservatoryDashboard } from "@ratel/core";
export default registerObservatoryDashboard;
