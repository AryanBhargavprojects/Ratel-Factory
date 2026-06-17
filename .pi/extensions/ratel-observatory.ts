/**
 * ratel-observatory.ts — Pi extension entry point
 *
 * Re-exports the `view_observatory` extension from @ratel-factory/core so Pi's
 * auto-discovery (which scans .pi/extensions/*.ts) picks it up.
 */

import { registerObservatoryDashboard } from "@ratel-factory/core";
export default registerObservatoryDashboard;
