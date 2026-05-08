const { kv } = require('@vercel/kv');

async function getThread(phone) {
  return await kv.get(phone);
}

async function saveThread(phone, thread) {
  await kv.set(phone, thread);
}

async function deleteThread(phone) {
  await kv.del(phone);
}

module.exports = { getThread, saveThread, deleteThread };
