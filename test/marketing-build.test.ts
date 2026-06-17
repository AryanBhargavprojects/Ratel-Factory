import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("marketing site builds successfully and contains expected elements", () => {
  const marketingDir = join(process.cwd(), "marketing");
  
  // 1. Run build command inside marketing
  execSync("npm run build", { cwd: marketingDir, stdio: "ignore" });
  
  // 2. Check output index.html exists
  const htmlPath = join(marketingDir, "dist", "index.html");
  assert.ok(existsSync(htmlPath), "Built index.html should exist");
  
  const html = readFileSync(htmlPath, "utf-8");
  
  // 3. Assert title is correct
  assert.ok(html.includes("<title>Ratel — AI Software Factory</title>"), "Title should match design spec");
  
  // 4. Assert JetBrains Mono font is imported
  assert.ok(html.includes("fonts.googleapis.com/css2?family=JetBrains+Mono"), "JetBrains Mono font should be imported");
  
  // 5. Assert layout components are present
  assert.ok(html.includes('id="terminal-container"'), "Terminal emulator container should be present");
  assert.ok(html.includes("02 / CORE SYSTEMS"), "Features grid section should be present");
  assert.ok(html.includes("03 / INSTALLATION & ONBOARDING") || html.includes("03 / INSTALLATION &amp; ONBOARDING"), "Onboarding section should be present");
  
  // 6. Assert footer modifications are present
  assert.ok(html.includes("Proudly open-source"), "Footer should contain Proudly open-source");
  assert.ok(html.includes("GitHub"), "Footer should contain GitHub link");
  assert.ok(html.includes("Docs"), "Footer should contain Docs link");
  assert.ok(html.includes("X"), "Footer should contain X link");
});
