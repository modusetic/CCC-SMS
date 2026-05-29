const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const THREAD_TTL_SECONDS = 60 * 60 * 24 * 7;

async function getThreadById(threadId) {
  return await redis.get(`thread:${threadId}`);
}

async function saveThreadById(threadId, thread) {
  await redis.set(`thread:${threadId}`, thread, { ex: THREAD_TTL_SECONDS });
}

async function getPhoneIndex(phone) {
  const ids = await redis.get(`phone:${phone}`);
  return Array.isArray(ids) ? ids : [];
}

async function setPhoneIndex(phone, ids) {
  if (ids.length === 0) {
    await redis.del(`phone:${phone}`);
  } else {
    await redis.set(`phone:${phone}`, ids);
  }
}

async function addToPhoneIndex(phone, threadId) {
  const ids = await getPhoneIndex(phone);
  if (!ids.includes(threadId)) {
    await setPhoneIndex(phone, [...ids, threadId]);
  }
}

async function removeFromPhoneIndex(phone, threadId) {
  const ids = await getPhoneIndex(phone);
  await setPhoneIndex(phone, ids.filter(id => id !== threadId));
}

async function getPendingMessage(phone) {
  return await redis.get(`pending:${phone}`);
}

async function setPendingMessage(phone, message) {
  await redis.set(`pending:${phone}`, message);
}

async function deletePendingMessage(phone) {
  await redis.del(`pending:${phone}`);
}

module.exports = {
  getThreadById, saveThreadById,
  getPhoneIndex, setPhoneIndex, addToPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage
};
