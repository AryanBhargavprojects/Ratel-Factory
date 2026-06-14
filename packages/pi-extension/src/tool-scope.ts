/**
 * Ratel Pi Extension — Tool Scope
 *
 * Service owns lifecycle state. The extension does not maintain local phase.
 * This module is retained for compatibility with any future service-driven
 * tool-gating helpers (e.g., querying the service for allowed tools).
 */

// No local phase state. Use service health and mission status for gating.
