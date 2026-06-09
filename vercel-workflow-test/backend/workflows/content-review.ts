import { createHook, sleep } from "workflow";

async function stepValidate(content: string) {
  "use step";
  if (!content || content.trim().length < 5) {
    throw new Error("Content too short (min 5 chars)");
  }
  if (content.length > 1000) {
    throw new Error("Content too long (max 1000 chars)");
  }
  const wordCount = content.trim().split(/\s+/).length;
  return { wordCount, charCount: content.length };
}

async function stepAutoModerate(content: string) {
  "use step";
  const banned = ["spam", "hate", "abuse", "scam", "violence"];
  const found = banned.filter((w) => content.toLowerCase().includes(w));
  const score = parseFloat((0.70 + Math.floor(Math.random() * 31) / 100).toFixed(2));
  return {
    passed: found.length === 0,
    flaggedWords: found,
    confidenceScore: score,
  };
}

async function stepPublish(content: string, approved: boolean, note: string) {
  "use step";
  if (!approved) {
    return { published: false, reason: note || "Rejected by reviewer" };
  }
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return {
    published: true,
    slug,
    url: `/posts/${slug}`,
    publishedAt: new Date().toISOString(),
  };
}

export async function contentReviewWorkflow(
  jobId: string,
  content: string,
  author: string
) {
  "use workflow";

  // Step 1: Validate
  const validation = await stepValidate(content);

  await sleep("1s");

  // Step 2: Auto-moderation
  const moderation = await stepAutoModerate(content);

  if (!moderation.passed) {
    return {
      status: "rejected",
      reason: `Auto-rejected: flagged [${moderation.flaggedWords.join(", ")}]`,
      moderation,
    };
  }

  // Step 3: Human-in-the-Loop — workflow suspends here
  using hook = createHook<{ approved: boolean; note: string }>({
    token: `review:${jobId}`,
  });

  const decision = await hook;

  await sleep("500ms");

  // Step 4: Publish / reject
  const publish = await stepPublish(content, decision.approved, decision.note);

  return {
    status: decision.approved ? "published" : "rejected",
    validation,
    moderation,
    decision,
    publish,
  };
}
