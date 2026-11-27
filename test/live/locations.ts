// OpenCode keeps every folder it was asked about loaded (a "location", with its config,
// file watchers and services) until it is evicted or the service restarts. Each live test
// file uses fresh temporary folders, so without this the service collects hundreds of them
// for deleted folders over repeated runs and slows down until requests stall for seconds
// (seen: 279 locations, 4 GB and a busy core while idle), which made the live tests flaky.

import * as path from "node:path";
import type { Endpoint } from "../../src/opencode/client";

const inside = (dir: string, root: string): boolean => {
  const rel = path.relative(root.toLowerCase(), dir.toLowerCase());
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Unloads the locations OpenCode has for `roots` and the folders inside them. */
export async function forgetLocations(endpoint: Endpoint | undefined, roots: string[]): Promise<void> {
  if (!endpoint || !roots.length) return;
  const headers: Record<string, string> = endpoint.authorization
    ? { authorization: endpoint.authorization }
    : {};
  try {
    const res = await fetch(new URL("/api/debug/location", endpoint.url), { headers });
    if (!res.ok) return;
    const loaded = (await res.json()) as Array<{ directory?: string | null }>;
    for (const { directory } of loaded) {
      if (!directory || !roots.some((r) => inside(directory, r))) continue;
      const url = new URL("/api/debug/location", endpoint.url);
      url.searchParams.set("location[directory]", directory);
      await fetch(url, { method: "DELETE", headers }).catch(() => undefined);
    }
  } catch {
    // Cleanup only: a service that went away has nothing loaded.
  }
}
