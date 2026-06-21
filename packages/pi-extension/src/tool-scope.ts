/**
 * Ratel Pi Extension — Tool Scope
 *
 * The Ratel core service owns lifecycle/phase state. The extension does not
 * maintain a local phase copy. This module is retained as a placeholder for
 * any future service-driven tool-gating helpers (e.g. querying the service
 * for allowed tools). It currently exports nothing.
 */

// No local phase state. Use service health and mission status for gating.
export {};
