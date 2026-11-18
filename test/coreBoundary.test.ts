import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDir } from "./helpers";

const srcDir = path.join(fixturesDir, "..", "..", "src");
// Everything that runs inside the Worker
const workerSideDirs = ["core", "adapters", "worker"].map((name) => path.join(srcDir, name));

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

describe("Worker side code (core, adapters, worker) stays runtime agnostic", () => {
  const workerSideFiles = workerSideDirs.flatMap(listTypeScriptFiles);

  it("finds the files", () => {
    expect(workerSideFiles.length).toBeGreaterThan(25);
  });

  it.each(workerSideFiles.map((filePath) => [path.relative(srcDir, filePath), filePath]))("%s has no Node only imports", (_name, filePath) => {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      const isNodeBuiltin = specifier.startsWith("node:") || nodeBuiltins.has(specifier.split("/")[0]!);
      expect(isNodeBuiltin, `imports ${specifier}`).toBe(false);
      expect(specifier.includes("/local/"), `imports from src/local: ${specifier}`).toBe(false);
      if (filePath.startsWith(workerSideDirs[0]!)) {
        expect(/\/(adapters|worker)\//.test(specifier), `core imports outward: ${specifier}`).toBe(false);
      }
    }
    expect(nodeGlobalsPattern.test(source)).toBe(false);
  });
});
