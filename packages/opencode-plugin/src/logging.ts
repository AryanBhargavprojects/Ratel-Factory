/**
 * Safe logging helper for the Ratel OpenCode Plugin.
 *
 * Routes log messages through ctx.client.app.log when available,
 * falling back to console.log only when the OpenCode app log channel
 * is absent. This prevents raw stdout from leaking into the OpenCode
 * composer/input bar during normal use.
 *
 * Extracted into its own module so plugin.ts has only a default
 * export — named runtime exports from plugin entry modules cause
 * OpenCode to treat them as provider plugins, breaking provider
 * listing (e.g. `opencode models opencode`).
 */

/**
 * Route a log message through ctx.client.app.log when available,
 * falling back to console.log only when the OpenCode app log channel
 * is absent. This prevents raw stdout from leaking into the OpenCode
 * composer/input bar during normal use.
 */
export async function safeLog(
  ctx: any,
  level: "info" | "warning" | "error",
  message: string,
): Promise<void> {
  try {
    if (ctx?.client?.app?.log) {
      await ctx.client.app.log({ level, message });
    } else {
      const prefix =
        level === "error"
          ? "[Ratel ERROR]"
          : level === "warning"
            ? "[Ratel WARN]"
            : "[Ratel]";
      console.log(`${prefix} ${message}`);
    }
  } catch {
    // Never let logging errors propagate
  }
}
