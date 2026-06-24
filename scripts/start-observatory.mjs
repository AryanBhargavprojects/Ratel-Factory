import { startDashboardServerOnAvailablePort } from "../packages/core/dist/observatory/server.js";

const cwd = process.cwd();
startDashboardServerOnAvailablePort({ cwd, port: 8765 })
  .then((h) => console.log(`Observatory: ${h.url}`))
  .catch((e) => console.error("Failed:", e.message));
