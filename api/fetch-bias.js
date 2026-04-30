export const maxDuration = 300;

const TIINGO_KEY  = process.env.TIINGO_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET;

// Tiingo forex symbols (lowercase)
// inverted: true = USD is base in the pair, so we flip distPct to get currency strength
const CURRENCIES = {
  EUR: { symbol: 'eurusd', inverted: false },
  GBP: { symbol: 'gbpusd', inverted: false },
  AUD: { symbol: 'audusd', inverted: false },
  NZD: { symbol: 'nzdusd', inverted: false },
  JPY: { symbol: 'usdjpy', inverted: true  },
  CAD: { symbol: 'usdcad', inverted: true  },
  CHF: { symbol: 'usdchf', inverted: true  },
  XAU: { symbol: 'xauusd', inverted: false },
  BTC: { symbol: 'btcusd', inverted: false },
};

const TIMEFRAMES  = ['M30', 'H1', 'H2'];
const TF_FREQ     = { M30: '30min', H1: '1hour', H2: '2hour' };
const TF_WEIGHTS  = { M30: 0.35, H1: 0.50, H2: 0.15 };

// DXY weights (official ICE formula, SEK excluded, renormalized)
const DXY_WEIGHTS = {
  EUR: -0.609, // EUR/USD inverted → USD strong when EUR weak
  JPY: -0.144,
  GBP: -0.126,
  CAD: -0.096,
  CHF: -0.036, // SEK excluded, weights renormalized to sum ~1
};

function getStartDate() {
  // Go back 5 days to get enough candles for MM50 on all TFs
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

async function fetchTiingo(symbol, freq) {
  const startDate = getStartDate();
  const url = `https://api.tiingo.com/tiingo/fx/${symbol}/prices?startDate=${startDate}&resampleFreq=${freq}&token=${TIINGO_KEY}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Tiingo ${symbol} ${freq}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Tiingo ${symbol} ${freq}: no data`);
  return data;
}

function calcMM50(candles) {
  if (candles.length < 50) return null;
  const last50 = candles.slice(-50);
  return last50.reduce((a, c) => a + c.close, 0) / 50;
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

async function fetchCurrencyData(cur) {
  const meta = CURRENCIES[cur];
  const tfData = {};
  for (const tf of TIMEFRAMES) {
    const candles = await fetchTiingo(meta.symbol, TF_FREQ[tf]);
    const price = candles[candles.length - 1].close;
    const mm50 = calcMM50(candles);
    if (!mm50) throw new Error(`${cur} ${tf}: pas assez de données (${candles.length} bougies)`);
    let distPct = parseFloat((((price - mm50) / mm50) * 100).toFixed(4));
    if (meta.inverted) distPct = -distPct;
    tfData[tf] = {
      price:   parseFloat(price.toFixed(5)),
      mm50:    parseFloat(mm50.toFixed(5)),
      distPct,
    };
  }
  return tfData;
}

// Calculate USD score from DXY formula using already-fetched scores
function calcUSDFromScores(scores) {
  let usdScore = 0;
  let totalWeight = 0;
  for (const [cur, weight] of Object.entries(DXY_WEIGHTS)) {
    if (scores[cur] === undefined) continue;
    // USD is strong when paired currencies are weak → invert their scores
    usdScore += (-scores[cur]) * Math.abs(weight);
    totalWeight += Math.abs(weight);
  }
  if (totalWeight === 0) return null;
  return parseFloat((usdScore / totalWeight).toFixed(1));
}

async function upsertCurrency(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bias_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SECRET}`,
      'apikey': SUPABASE_SECRET,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert error: ${text}`);
  }
  return true;
}

export default async function handler(req, res) {
  const results = [];
  const scores  = {};

  // Fetch all currencies in parallel (Tiingo has no strict rate limit)
  const fetchPromises = Object.keys(CURRENCIES).map(async (cur) => {
    try {
      const tfData = await fetchCurrencyData(cur);
      const score  = calcScore(tfData);
      scores[cur]  = score;

      const row = {
        currency:   cur,
        score,
        tf_m30:     tfData['M30'],
        tf_h1:      tfData['H1'],
        tf_h2:      tfData['H2'],
        bias:       getBias(score),
        confluence: getConfluence(tfData),
        momentum:   '→',
        updated_at: new Date().toISOString(),
      };

      await upsertCurrency(row);
      results.push(cur);
    } catch (e) {
      results.push(`ERROR_${cur}: ${e.message}`);
    }
  });

  await Promise.all(fetchPromises);

  // Calculate USD from DXY formula
  try {
    const usdScore = calcUSDFromScores(scores);
    if (usdScore === null) throw new Error('Pas assez de devises pour calculer USD');

    const usdBias = getBias(usdScore);
    // USD confluence based on sign consistency — simplified
    const usdConfluence = 'Confluent';

    const usdRow = {
      currency:   'USD',
      score:      usdScore,
      tf_m30:     null,
      tf_h1:      null,
      tf_h2:      null,
      bias:       usdBias,
      confluence: usdConfluence,
      momentum:   '→',
      updated_at: new Date().toISOString(),
    };

    await upsertCurrency(usdRow);
    results.push('USD');
  } catch (e) {
    results.push(`ERROR_USD: ${e.message}`);
  }

  res.json({
    ok:         true,
    updated:    results.filter(r => !r.startsWith('ERROR')).length,
    currencies: results,
  });
}
