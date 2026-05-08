const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const THREAD_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function getThread(phone) {
  return await redis.get(phone);
}

async function saveThread(phone, thread) {
  await redis.set(phone, thread, { ex: THREAD_TTL_SECONDS });
}

async function deleteThread(phone) {
  await redis.del(phone);
}

module.exports = { getThread, saveThread, deleteThread };
