const SECRET_TOKEN = process.env.SECRET_TOKEN || 'Livermore';
const DATA_KEY = 'journal_data';

async function kvGet(key) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    console.error('KV get error:', e);
    return null;
  }
}

async function kvSet(key, value) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    await fetch(`${url}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch (e) {
    console.error('KV set error:', e);
  }
}

function emptyData() {
  return { stocks: [], nextSid: 1, nextEid: 1, deletedAt: {} };
}

function mergeByTimestamp(a, b) {
  const deletedAt = {};
  [a.deletedAt || {}, b.deletedAt || {}].forEach(d => {
    Object.keys(d).forEach(k => {
      deletedAt[k] = Math.max(deletedAt[k] || 0, d[k]);
    });
  });

  const stockMap = {};
  function ingest(stockList) {
    (stockList || []).forEach(s => {
      const key = s.market + ':' + s.ticker;
      if (!stockMap[key]) stockMap[key] = { ...s, entries: [] };
      const target = stockMap[key];
      if (s.name && s.name !== s.ticker) target.name = s.name;
      (s.entries || []).forEach(e => {
        if (!target.entries.find(x => x.id === e.id)) target.entries.push(e);
      });
    });
  }
  ingest(a.stocks);
  ingest(b.stocks);

  const result = [];
  Object.values(stockMap).forEach(s => {
    if (deletedAt['stock_' + s.market + ':' + s.ticker]) return;
    s.entries = s.entries.filter(e => !deletedAt['entry_' + e.id]);
    s.entries.sort((x, y) => y.date.localeCompare(x.date));
    result.push(s);
  });

  return { stocks: result, deletedAt };
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

  if (action === 'replace') {
    const incoming = req.body?.payload;
    if (!incoming) return res.status(400).json({ status: 'error', message: 'No payload' });
    await kvSet(DATA_KEY, {
      stocks: incoming.stocks || [],
      nextSid: incoming.nextSid || 1,
      nextEid: incoming.nextEid || 1,
      deletedAt: incoming.deletedAt || {}
    });
    return res.status(200).json({ status: 'ok' });
  }

  if (action === 'push') {
    const incoming = req.body?.payload;
    if (!incoming) return res.status(400).json({ status: 'error', message: 'No payload' });
    const current = await kvGet(DATA_KEY) || emptyData();
    const merged = mergeByTimestamp(current, incoming);
    const result = {
      stocks: merged.stocks,
      deletedAt: merged.deletedAt,
      nextSid: Math.max(current.nextSid || 0, incoming.nextSid || 0) + 1,
      nextEid: Math.max(current.nextEid || 0, incoming.nextEid || 0) + 1
    };
    await kvSet(DATA_KEY, result);
    return res.status(200).json({ status: 'ok' });
  }

  return res.status(400).json({ status: 'error', message: 'Unknown action' });
}
