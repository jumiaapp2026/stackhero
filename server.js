const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Stack Hero credentials loaded from Render Environment Variables
const ACCOUNT_ID = process.env.STACKHERO_ACCOUNT_ID;
const SECRET_KEY = process.env.STACKHERO_SECRET_KEY;
const CALLBACK_URL = process.env.CALLBACK_URL || ''; // Optional: e.g. https://your-app.onrender.com/mpesa/result

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory state for queue & logs
let queue = [];
let isProcessing = false;
let shouldStop = false;
const recentLogs = [];

function logEvent(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, data };

  // Print clearly to Render Logs (stdout)
  const formatted = data
    ? `[${timestamp}] [${level}] ${message} | ${JSON.stringify(data)}`
    : `[${timestamp}] [${level}] ${message}`;
  console.log(formatted);

  // Keep last 150 logs in memory for the web dashboard
  recentLogs.unshift(entry);
  if (recentLogs.length > 150) recentLogs.pop();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalize Kenyan numbers (07..., 01..., +254..., 7..., 1...)
function normalizePhone(raw) {
  let cleaned = raw.replace(/[\s\-()+]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '254' + cleaned.slice(1);
  } else if ((cleaned.startsWith('7') || cleaned.startsWith('1')) && cleaned.length === 9) {
    cleaned = '254' + cleaned;
  }
  return /^254(7|1)\d{8}$/.test(cleaned) ? cleaned : null;
}

async function sendStkPush(item) {
  const payload = {
    account_id: ACCOUNT_ID,
    secret_key: SECRET_KEY,
    phone: item.phone,
    amount: Number(item.amount),
    reference: item.reference
  };

  if (CALLBACK_URL) {
    payload.callback_url = CALLBACK_URL;
  }

  logEvent('INFO', `Sending STK Push to ${item.phone} (KES ${item.amount})`, {
    reference: item.reference
  });

  try {
    const response = await fetch('https://stackhero.co.ke/v1/stkpush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (response.ok && result.success) {
      logEvent('SUCCESS', `STK Prompt sent to ${item.phone}`, {
        transaction_request_id: result.data?.transaction_request_id,
        checkout_request_id: result.data?.checkout_request_id,
        status: result.data?.status
      });
    } else {
      logEvent('ERROR', `Stack Hero rejected ${item.phone}`, {
        http_status: response.status,
        response: result
      });
    }
  } catch (err) {
    logEvent('ERROR', `Network error sending to ${item.phone}: ${err.message}`);
  }
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  shouldStop = false;

  logEvent('SYSTEM', `Queue started. Total items: ${queue.length}`);

  while (queue.length > 0) {
    if (shouldStop) {
      logEvent('WARN', `Queue manually stopped. ${queue.length} items remaining cleared.`);
      queue = [];
      break;
    }

    const current = queue.shift();
    await sendStkPush(current);

    if (queue.length > 0 && !shouldStop) {
      logEvent('WAIT', `Waiting 5 seconds before next request (${queue.length} left)...`);
      await sleep(5000);
    }
  }

  isProcessing = false;
  logEvent('SYSTEM', 'Queue finished.');
}

// Health check endpoint (useful for UptimeRobot)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Enqueue phone numbers from the web UI
app.post('/api/enqueue', (req, res) => {
  if (!ACCOUNT_ID || !SECRET_KEY) {
    logEvent('ERROR', 'Missing STACKHERO_ACCOUNT_ID or STACKHERO_SECRET_KEY in environment variables.');
    return res.status(500).json({
      success: false,
      message: 'Server missing STACKHERO_ACCOUNT_ID or STACKHERO_SECRET_KEY environment variables.'
    });
  }

  const { phonesText, amount, referencePrefix } = req.body;
  const parsedAmount = Number(amount);

  if (!phonesText || !parsedAmount || parsedAmount < 1 || parsedAmount > 250000) {
    return res.status(400).json({
      success: false,
      message: 'Provide valid phone numbers and an amount between 1 and 250,000 KES.'
    });
  }

  const rawLines = phonesText
    .split(/[\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const validItems = [];
  const invalidEntries = [];

  rawLines.forEach((raw, index) => {
    const normalized = normalizePhone(raw);
    if (normalized) {
      const ref = `${referencePrefix || 'INV'}-${Date.now().toString().slice(-5)}-${index + 1}`;
      validItems.push({ phone: normalized, amount: parsedAmount, reference: ref });
    } else {
      invalidEntries.push(raw);
    }
  });

  if (invalidEntries.length > 0) {
    logEvent('WARN', 'Skipped invalid phone numbers', { invalidEntries });
  }

  if (validItems.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No valid Kenyan phone numbers found.'
    });
  }

  queue.push(...validItems);
  logEvent('QUEUE', `Added ${validItems.length} number(s) to queue.`);
  processQueue();

  res.json({
    success: true,
    queued: validItems.length,
    skipped: invalidEntries.length
  });
});

// Stop active queue
app.post('/api/stop', (req, res) => {
  shouldStop = true;
  queue = [];
  logEvent('WARN', 'Stop signal received from dashboard.');
  res.json({ success: true });
});

// Status & live logs endpoint for the UI
app.get('/api/status', (req, res) => {
  res.json({
    isProcessing,
    queueLength: queue.length,
    logs: recentLogs
  });
});

// Webhook endpoint for Stack Hero callbacks
app.post('/mpesa/result', (req, res) => {
  logEvent('CALLBACK', 'Received Stack Hero payment callback', req.body);
  res.status(200).json({ received: true });
});

app.listen(PORT, () => {
  logEvent('SYSTEM', `Stack Hero STK Bot listening on port ${PORT}`);
});
