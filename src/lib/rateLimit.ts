export class RateLimiter {
  private cache: Map<string, { count: number; resetTime: number }>;
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.cache = new Map();
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(ip: string): { success: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    let record = this.cache.get(ip);

    // Clean up old records periodically or on access
    if (record && now > record.resetTime) {
      this.cache.delete(ip);
      record = undefined;
    }

    if (!record) {
      record = { count: 0, resetTime: now + this.windowMs };
      this.cache.set(ip, record);
    }

    record.count++;

    // Random cleanup to prevent memory leak (1% chance on access)
    if (Math.random() < 0.01) {
      for (const [key, val] of this.cache.entries()) {
        if (now > val.resetTime) {
          this.cache.delete(key);
        }
      }
    }

    return {
      success: record.count <= this.limit,
      remaining: Math.max(0, this.limit - record.count),
      resetTime: record.resetTime,
    };
  }
}

// Auth limits: 10 requests per 15 minutes
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

// Signup-time discount preview: unauthenticated, so it gets its own bucket.
// Sharing authRateLimiter would let a few Apply presses burn the caller's
// registration budget and lock them out of signing up.
export const discountPreviewRateLimiter = new RateLimiter(15, 15 * 60 * 1000);
