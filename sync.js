// Stock Journal — Vercel API
// Handles push, pull, and image upload for two-way sync

const SECRET_TOKEN = process.env.SECRET_TOKEN || 'Livermore';
const DATA_KEY = 'journal_data';

// In-memory fallback (for local dev). On Vercel, KV is used.
let memStore = {};

async function kvGet(key) {
  try {
    const { kv } = await import('@vercel/kv');
    return await kv.get(key);
  } catch (e) {
    return memStore[key] || null;
  }
}

async function kvSet(key, value) {
  try {
    const { kv } = await import('@vercel/kv');
    await kv.set(key, value);
  } catch (e) {
    memStore[key] = value;
  }
}

function emptyData() {
  return { stocks: [], nextSid: 1, nextEid: 1, deletedIds: [] };
}

function mergeData(server, incoming) {
  const allDeletedIds = [...new Set([...(server.deletedIds || []), ...(incoming.deletedIds || [])])];
  const mergedStocks = [...(server.stocks || [])];

  (incoming.stocks || []).forEach(iStock => {
    if (allDeletedIds.includes('stock_' + iStock.id)) return;
    const sStock = mergedStocks.find(s => s.ticker === iStock.ticker && s.market === iStock.market);
    if (!sStock) {
      iStock.entries = (iStock.entries || []).filter(e => !allDeletedIds.includes(e.id));
      mergedStocks.push(iStock);
    } else {
      const entryMap = {};
      sStock.entries.forEach(e => { entryMap[e.id] = e; });
      (iStock.entries || []).forEach(e => {
        if (!allDeletedIds.includes(e.id) && !entryMap[e.id]) entryMap[e.id] = e;
      });
      sStock.entries = Object.values(entryMap).sort((a, b) => b.date.localeCompare(a.date));
      if (iStock.name && iStock.name !== iStock.ticker) sStock.name = iStock.name;
    }
  });

  mergedStocks.forEach(s => {
    s.entries = (s.entries || []).filter(e => !allDeletedIds.includes(e.id));
  });

  return {
    stocks: mergedStocks.filter(s => !allDeletedIds.includes('stock_' + s.id)),
    nextSid: Math.max(server.nextSid || 0, incoming.nextSid || 0) + 1,
    nextEid: Math.max(server.nextEid || 0, incoming.nextEid || 0) + 1,
    deletedIds: allDeletedIds
  };
}

export default async function handler(req, res) {
  // CORS headers — allow requests from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Auth check
  const token = req.method === 'POST'
    ? req.body?.token
    : req.query?.token;

  if (!token || token !== SECRET_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const action = req.method === 'POST' ? req.body?.action : req.query?.action;

  // PULL — return all data
  if (action === 'pull') {
    const data = await kvGet(DATA_KEY) || emptyData();
    return res.status(200).json({ status: 'ok', data: JSON.stringify(data) });
  }

  // PUSH — merge incoming data and save (POST only, no size limit)
  if (action === 'push' && req.method === 'POST') {
    const incoming = req.body?.payload;
    if (!incoming) return res.status(400).json({ status: 'error', message: 'No payload' });
    const current = await kvGet(DATA_KEY) || emptyData();
    const merged = mergeData(current, incoming);
    await kvSet(DATA_KEY, merged);
    return res.status(200).json({ status: 'ok' });
  }

  return res.status(400).json({ status: 'error', message: 'Unknown action' });
}
