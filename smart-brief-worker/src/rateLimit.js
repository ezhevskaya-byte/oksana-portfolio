import { LIMITS } from "./config.js";

/**
 * Best-effort in-memory rate limit for a single Worker isolate.
 * NOT durable across isolates/regions/restarts. Document this limitation.
 * Designed so KV/Turnstile can replace the store later without changing the route.
 */
const chatBuckets = new Map();
const sttBuckets = new Map();

function getClientKey(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

function checkBucket(buckets, request, maxPerWindow) {
  const key = getClientKey(request);
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= LIMITS.rateLimitWindowMs) {
    bucket = { windowStart: now, count: 0 };
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  // Soft cleanup to avoid unbounded growth in long-lived isolates.
  if (buckets.size > 2000) {
    for (const [k, v] of buckets) {
      if (now - v.windowStart >= LIMITS.rateLimitWindowMs) buckets.delete(k);
    }
  }

  if (bucket.count > maxPerWindow) {
    return { ok: false, error: "rate_limited" };
  }

  return { ok: true };
}

/** Rate limit for POST /api/chat (unchanged policy). */
export function checkRateLimit(request) {
  return checkBucket(chatBuckets, request, LIMITS.rateLimitMaxPerWindow);
}

/** Separate stricter rate limit for POST /api/transcribe. */
export function checkSttRateLimit(request) {
  return checkBucket(sttBuckets, request, LIMITS.sttRateLimitMaxPerWindow);
}
