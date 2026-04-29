export const maxDuration = 300;

const TWELVE_KEY = process.env.TWELVE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET;

const CURRENCIES = {
  EUR: { symbol: 'EUR/USD', inverted: false },
  GBP: { symbol: 'GBP/USD', inverted: false },
  AUD: { symbol: 'AUD/USD', inverted: false },
  NZD: { symbol: 'NZD/USD', inverted: false },
  JPY: { symbol: 'USD/JPY', inverted: true  },
  CAD: { symbol: 'USD/CAD', inverted: true  },
  CHF: { symbol: 'USD/CHF', inverted: true  },
  XAU: { symbol: 'XAU/USD', inverted: false },
  BTC: { symbol: 'BTC/USD', inverted: false },
};

const TIMEFRAMES = ['M30','H1','H2'];
const TD_INTERVAL = { M30:'30min', H1:'1h', H2:'2h' };
const TF_WEIGHTS  = { M30:0.35, H1:0.50, H2:0.15 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function calcMM50(candles) {
  if (candles.length < 50) return null;
  return candles.slice(-50).reduce((a, c) => a + parseFloat(c.close), 0) / 50;
}

function calcScore(tfData) {
  let score = 0;
  TIMEFRAMES.forEach(tf => {
    if (!tfData[tf]) return;
    score += Math.max(-100, Math.min(100, tfData[tf].distPct * 40)) * TF_WEIGHTS[tf];
  });
  return parseFloat(score.toFixed(1));
}

function getBias(score) {
  if (score >= 50)  return 'Haussier +++';
  if (score >= 20)  return 'Haussier ++';
  if (score >= 0)   return 'Haussier +';
  if (score <= -50) return 'Baissier ---';
  if (score <= -20) return 'Baissier --';
  return                   'Baissier -';
}

function getConfluence(tfData) {
  const sum = TIMEFRAMES.map(tf => (tfData[tf]?.distPct ?? 0) >= 0 ? 1 : -1).reduce((a,b)=>a+b,0);
  if (Math.abs(sum) === 3) return 'Confluent';
  if (Math.abs(sum) === 1) return 'Mixte';
  return 'Divisé';
}

async function fetchTF(symbol, interval) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=60&apikey=${TWELVE_KEY}&format=JSON`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json || json.status === 'error' || !json.values) throw new Error(json?.message || 'API error');
  return [...json.values].reverse();
}

async function upsertCurrency(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bias_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SECRET}`,
      'apikey': SUPABASE_SECRET,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  });
  return res.ok;
}

export default async function handler(req, res) {
  const results = [];
  let reqCount = 0;

  for (const [cur, meta] of Object.entries(CURRENCIES)) {
    try {
      const tfData = {};
      for (const tf of TIMEFRAMES) {
        if (reqCount > 0 && reqCount % 7 === 0) {
          await sleep(62000);
        }
        const candles = await fetchTF(meta.symbol, TD_INTERVAL[tf]);
        reqCount++;
        const price = parseFloat(candles[candles.length-1].close);
        const mm50 = calcMM50(candles);
        if (!mm50) throw new Error('Pas assez de données');
        let distPct = parseFloat((((price-mm50)/mm50)*100).toFixed(4));
        if (meta.inverted) distPct = -distPct;
        tfData[tf] = { price: parseFloat(price.toFixed(5)), mm50: parseFloat(mm50.toFixed(5)), distPct };
      }

      const score = calcScore(tfData);
      const row = {
        currency: cur,
        score,
        tf_m30: tfData['M30'],
        tf_h1:  tfData['H1'],
        tf_h2:  tfData['H2'],
        bias: getBias(score),
        confluence: getConfluence(tfData),
        momentum: '→',
        updated_at: new Date().toISOString()
      };

      await upsertCurrency(row);
      results.push(cur);
    } catch(e) {
      results.push(`ERROR_${cur}: ${e.message}`);
    }
  }

  res.json({ ok: true, updated: results.filter(r => !r.startsWith('ERROR')).length, currencies: results });
}
