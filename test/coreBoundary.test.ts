import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDir } from "./helpers";

const coreDir = path.join(fixturesDir, "..", "..", "src", "core");

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
    } else if (entry.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const nodeBuiltins = new Set(builtinModules);
const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
const nodeGlobalsPattern = /\b(?:process\.|Buffer\b|__dirname|__filename|require\()/;

describe("src/core stays runtime agnostic", () => {
  const coreFiles = listTypeScriptFiles(coreDir);

  it("finds the core files", () => {
    expect(coreFiles.length).toBeGreaterThan(10);
  });

  it.each(coreFiles.map((filePath) => [path.relative(coreDir, filePath), filePath]))("%s has no Node only imports", (_name, filePath) => {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      const isNodeBuiltin = specifier.startsWith("node:") || nodeBuiltins.has(specifier.split("/")[0]!);
      expect(isNodeBuiltin, `imports ${specifier}`).toBe(false);
      expect(specifier.includes("/local/"), `imports from src/local: ${specifier}`).toBe(false);
    }
    expect(nodeGlobalsPattern.test(source)).toBe(false);
  });
});
