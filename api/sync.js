const SECRET_TOKEN = process.env.SECRET_TOKEN || 'Livermore';
const DATA_KEY = 'journal_data';

async function kvGet(key) {
  try {
    const { Redis } = await import('@upstash/redis');
    const redis = Redis.fromEnv();
    return await redis.get(key);
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value) {
  try {
    const { Redis } = await import('@upstash/redis');
    const redis = Redis.fromEnv();
    await redis.set(key, value);
  } catch (e) {
    console.error('KV set error:', e);
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.body?.token;
  if (!token || token !== SECRET_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const action = req.body?.action;

  if (action === 'pull') {
    const data = await kvGet(DATA_KEY) || emptyData();
    return res.status(200).json({ status: 'ok', data: JSON.stringify(data) });
  }

  if (action === 'push') {
    const incoming = req.body?.payload;
    if (!incoming) return res.status(400).json({ status: 'error', message: 'No payload' });
    const current = await kvGet(DATA_KEY) || emptyData();
    const merged = mergeData(current, incoming);
    await kvSet(DATA_KEY, merged);
    return res.status(200).json({ status: 'ok' });
  }

  return res.status(400).json({ status: 'error', message: 'Unknown action' });
}
