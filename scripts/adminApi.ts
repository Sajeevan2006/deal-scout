import "../src/local/localSetup";

// Calls the deployed Worker's admin API. Needs WORKER_URL and ADMIN_TOKEN in .env.
export async function callAdminApi(method: string, apiPath: string, body?: unknown): Promise<unknown> {
  const workerUrl = process.env.WORKER_URL?.trim();
  const adminToken = process.env.ADMIN_TOKEN?.trim();
  if (!workerUrl || !adminToken) {
    throw new Error("Set WORKER_URL (https://deal-scout.<your-subdomain>.workers.dev) and ADMIN_TOKEN in .env first (see .env.example).");
  }
  const response = await fetch(new URL(apiPath, workerUrl), {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the plain text
  }
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed ? String((parsed as { error: unknown }).error) : text;
    throw new Error(`${method} ${apiPath} failed with HTTP ${response.status}: ${message}`);
  }
  return parsed;
}

export async function runAdminCommand(run: () => Promise<unknown>): Promise<void> {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
