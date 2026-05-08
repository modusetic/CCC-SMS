const { kv } = require('@vercel/kv');

const THREAD_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function getThread(phone) {
  return await kv.get(phone);
}

async function saveThread(phone, thread) {
  await kv.set(phone, thread, { ex: THREAD_TTL_SECONDS });
}

async function deleteThread(phone) {
  await kv.del(phone);
}

module.exports = { getThread, saveThread, deleteThread };
