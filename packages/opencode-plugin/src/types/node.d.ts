// Minimal Node.js type stub for the OpenCode plugin build

declare var process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  on(event: string, listener: (...args: any[]) => void): void;
  exit(code?: number): never;
};

declare var globalThis: typeof global;
