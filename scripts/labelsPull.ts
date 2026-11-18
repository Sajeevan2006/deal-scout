import path from "node:path";
import { parseArgs } from "node:util";
import { collectedTitlesPath, projectRoot } from "../src/local/localSetup";
import { callAdminApi } from "./adminApi";
import { mergeCollectedTitles, readJsonFile, writeJsonFile, type CollectedTitle } from "./labeledPosts";

// Pulls the posts the deployed Worker has seen (title + start of the body) into
// data/collected-titles.json, so eval data builds up with no extra requests to RFD.
// Then run npm run labels:sync and review data/labeled-posts.json.

interface SeenPost {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  bodySnippet: string;
}

const { values: flags } = parseArgs({ options: { days: { type: "string", default: "30" } } });

try {
  const response = (await callAdminApi("GET", `/api/posts?days=${encodeURIComponent(flags.days)}`)) as { posts: SeenPost[] };
  const incoming: CollectedTitle[] = response.posts.map((post) => ({
    id: post.id,
    title: post.title,
    link: post.link,
    publishedAt: post.publishedAt,
    ...(post.bodySnippet ? { bodySnippet: post.bodySnippet } : {}),
  }));
  const existing = await readJsonFile<CollectedTitle[]>(collectedTitlesPath, []);
  const { merged, added } = mergeCollectedTitles(existing, incoming);
  await writeJsonFile(collectedTitlesPath, merged);
  console.log(
    `Pulled ${incoming.length} posts from the Worker. ${path.relative(projectRoot, collectedTitlesPath)} now has ` +
      `${merged.length} posts (${added} new). Next: npm run labels:sync`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
