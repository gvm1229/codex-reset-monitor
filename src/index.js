import { classifyPost } from "./classifier.js";
import { formatKst } from "./time.js";
export {
  analyzeResetAnnouncement,
  classifyPost,
  determineResetTime,
  isRelevantLimitAnnouncement,
} from "./classifier.js";
export { formatKst } from "./time.js";
import { deduplicatePosts } from "./post-utils.js";

const X_USERNAME = "thsottiaux";
const ONE_HOUR_MS = 60 * 60 * 1000;
const PENDING_CONTEXT_TTL_MS = 36 * ONE_HOUR_MS;
const PENDING_USAGE_CONTEXT_KEY = "pending_usage_reset_context";
const PENDING_BANKED_CONTEXT_KEY = "pending_banked_reset_context";
const NOTIFICATION_TTL_SECONDS = 60 * 60 * 24 * 90;
const MAX_TIMELINE_PAGES = 100;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      monitor(env)
        .then(async (result) => {
          console.log("Scheduled monitor completed", JSON.stringify(result));
        })
        .catch(async (error) => {
          await recordRunState(env, "error", { error: safeErrorMessage(error) });
          console.error("Scheduled monitor failed", error);
          controller.noRetry();
          throw error;
        }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method !== "POST" ||
      url.pathname !== "/run"
    ) {
      return new Response("Not found", { status: 404 });
    }

    if (
      !env.SMOKE_TEST_TOKEN ||
      request.headers.get("Authorization") !== `Bearer ${env.SMOKE_TEST_TOKEN}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const result = await monitor(env, { smokeTest: true });
      return Response.json(result);
    } catch (error) {
      console.error("Smoke test failed", error);
      return Response.json({ ok: false, error: String(error) }, { status: 500 });
    }
  },
};

export async function monitor(env, { smokeTest = false, now = Date.now() } = {}) {
  assertSecrets(env);

  const userId = await getUserId(env);
  const lastSeenId = await env.STATE.get("last_seen_id");
  const posts = await getPosts(env, userId, lastSeenId, now);

  if (smokeTest) {
    await sendDiscord(
      env,
      [
        "🧪 **Codex 리셋 감시 스모크 테스트** 🧪",
        "",
        "**X API 상태**: 정상",
        `**새 게시물 수**: ${posts.length}`,
        "⚠️ **테스트 메시지이며 실제 리셋 알림이 아닙니다.**",
      ].join("\n"),
    );

    return { ok: true, smokeTest: true, posts: posts.length };
  }

  const ordered = [...posts].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const pendingContexts = {
    usage: await loadPendingContext(env, PENDING_USAGE_CONTEXT_KEY, now),
    banked: await loadPendingContext(env, PENDING_BANKED_CONTEXT_KEY, now),
  };
  const changedContexts = new Set();
  let notifications = 0;

  for (const post of ordered) {
    const postTime = Date.parse(post.created_at);
    if (!Number.isFinite(postTime) || postTime > now + 60_000) continue;

    const classification = await classifyPost(env, post, pendingContexts);
    const analysis = classification.analysis;
    if (!analysis) continue;

    const previousContext = pendingContexts[analysis.resetType];
    if (!previousContext || Date.parse(previousContext.createdAt) <= postTime) {
      pendingContexts[analysis.resetType] = createEventContext(post, postTime, analysis.resetType, analysis);
      changedContexts.add(analysis.resetType);
    }

    if (analysis.kind === "context") continue;
    if (now - postTime > ONE_HOUR_MS) continue;

    const notificationKey = `notified:${post.id}`;
    if (await env.STATE.get(notificationKey)) continue;

    const content = buildDiscordContent(analysis, post.id, now);

    await sendDiscord(env, content);
    await env.STATE.put(notificationKey, "1", { expirationTtl: NOTIFICATION_TTL_SECONDS });
    notifications += 1;
  }

  for (const resetType of changedContexts) {
    const key = resetType === "banked"
      ? PENDING_BANKED_CONTEXT_KEY
      : PENDING_USAGE_CONTEXT_KEY;
    const context = pendingContexts[resetType];
    if (context) {
      await env.STATE.put(key, JSON.stringify(context), {
        expirationTtl: Math.ceil(PENDING_CONTEXT_TTL_MS / 1000),
      });
    } else {
      await env.STATE.delete(key);
    }
  }

  if (posts.length > 0) {
    await env.STATE.put("last_seen_id", newestId(posts));
  }

  return {
    ok: true,
    posts: posts.length,
    notifications,
    classifier: "javascript",
  };
}

function assertSecrets(env) {
  for (const key of ["X_BEARER_TOKEN", "DISCORD_WEBHOOK_URL"]) {
    if (!env[key]) throw new Error(`Missing Worker secret: ${key}`);
  }
}

async function getUserId(env) {
  const cached = await env.STATE.get("tibo_user_id");
  if (cached) return cached;

  const response = await xFetch(env, `https://api.x.com/2/users/by/username/${X_USERNAME}`);
  const payload = await response.json();
  const userId = payload.data?.id;
  if (!userId) throw new Error("X user lookup did not return a user ID");

  await env.STATE.put("tibo_user_id", userId);
  return userId;
}

async function getPosts(env, userId, sinceId, now) {
  const posts = [];
  let paginationToken;
  const contextCutoff = now - PENDING_CONTEXT_TTL_MS;

  for (let page = 0; page < MAX_TIMELINE_PAGES; page += 1) {
    const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
    url.searchParams.set("max_results", "5");
    url.searchParams.set(
      "tweet.fields",
      "created_at,note_tweet,conversation_id,referenced_tweets,author_id",
    );
    url.searchParams.set("expansions", "referenced_tweets.id");
    url.searchParams.set("exclude", "retweets");
    if (sinceId) url.searchParams.set("since_id", sinceId);
    if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

    const response = await xFetch(env, url);
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(`X API timeline returned errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    }

    const expandedPosts = new Map(
      (payload.includes?.tweets ?? []).map((post) => [post.id, post]),
    );
    const pagePosts = (payload.data ?? []).map((post) => ({
      ...post,
      text: post.note_tweet?.text ?? post.text ?? "",
      referenced_contexts: (post.referenced_tweets ?? [])
        .map((reference) => {
          const referenced = expandedPosts.get(reference.id);
          if (!referenced || referenced.author_id !== userId) return null;
          return {
            id: referenced.id,
            type: reference.type,
            text: referenced.note_tweet?.text ?? referenced.text ?? "",
          };
        })
        .filter(Boolean),
    }));
    posts.push(...pagePosts);

    paginationToken = payload.meta?.next_token;
    const coveredContextWindow = pagePosts.some((post) => {
      const createdAt = Date.parse(post.created_at);
      return Number.isFinite(createdAt) && createdAt <= contextCutoff;
    });
    if (!paginationToken || coveredContextWindow) return deduplicatePosts(posts);
  }

  throw new Error(
    `X timeline exceeded ${MAX_TIMELINE_PAGES * 5} unread posts; cursor was not advanced`,
  );
}

async function xFetch(env, url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`X API request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  return response;
}

export function buildDiscordContent(analysis, postId, now = Date.now()) {
  if (analysis.kind === "banked-announcement") {
    return [
      "🏦 **Tibo로부터 Codex BANKED 리셋 지급 예정 감지!** 🏦",
      "**지급 시각(KST)**: 미정 (추후 안내 예정)",
      `https://fixupx.com/${X_USERNAME}/status/${postId}`,
    ].join("\n");
  }

  const completed = analysis.announcedAs === "completed";
  const banked = analysis.resetType === "banked";
  const headline = banked
    ? analysis.clarificationOf
      ? "🏦 **앞서 안내된 Codex BANKED 리셋 지급 시각 확인!** 🏦"
      : completed
      ? "🏦 **Tibo로부터 Codex BANKED 리셋 지급 완료 감지!** 🏦"
      : "🏦 **Tibo로부터 Codex BANKED 리셋 지급 예정 감지!** 🏦"
    : completed
      ? "🚨 **Tibo로부터 Codex 리셋 완료 감지!** 🚨"
      : "🚨 **Tibo로부터 Codex 리셋 예정 감지!** 🚨";
  const timeLabel = banked ? "지급 시각(KST)" : "리셋 시각(KST)";

  return [
    headline,
    `**${timeLabel}**: ${formatKst(analysis.resetAt)}`,
    `https://fixupx.com/${X_USERNAME}/status/${postId}`,
  ].join("\n");
}

function createEventContext(post, postTime, resetType, analysis) {
  return {
    sourcePostId: post.id,
    createdAt: post.created_at,
    expiresAt: postTime + PENDING_CONTEXT_TTL_MS,
    resetType,
    conversationId: post.conversation_id ?? post.id,
    status: analysis.announcedAs ?? "unknown",
  };
}

async function loadPendingContext(env, key, now) {
  const raw = await env.STATE.get(key);
  if (!raw) return null;

  try {
    const value = JSON.parse(raw);
    return Number.isFinite(value.expiresAt) && value.expiresAt > now ? value : null;
  } catch {
    return null;
  }
}

async function recordRunState(env, status, detail) {
  try {
    await env.STATE.put(
      "monitor_run_state",
      JSON.stringify({ status, at: new Date().toISOString(), ...detail }),
    );
  } catch (error) {
    console.error("Could not persist monitor run state", error);
  }
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}

function newestId(posts) {
  return posts.reduce((newest, post) => (BigInt(post.id) > BigInt(newest) ? post.id : newest), posts[0].id);
}

async function sendDiscord(env, content) {
  const response = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status}`);
  }
}
