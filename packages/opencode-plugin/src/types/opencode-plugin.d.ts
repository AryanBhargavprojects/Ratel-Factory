// Stub type declarations for @opencode-ai/plugin
// This is a minimal facade so the Ratel plugin builds without the full package installed.

declare module "@opencode-ai/plugin" {
  export interface PluginContext {
    client: any;
    directory: string;
  }

  export interface Plugin {
    (ctx: PluginContext, rawOptions?: unknown): Promise<any>;
  }

  export interface ToolDefinition {
    description: string;
    args: Record<string, any>;
    execute(args: any, context?: any): Promise<any>;
  }

  export const tool: any;
  export const schema: any;
}
