const twilio = require('twilio');

async function getTwilioCalls(accountSid, authToken, filters = {}) {
  const client = twilio(accountSid, authToken);
  const params = { limit: filters.limit || 50 };
  if (filters.startTime) params.startTimeAfter = new Date(filters.startTime);
  if (filters.endTime) params.startTimeBefore = new Date(filters.endTime);
  const calls = await client.calls.list(params);
  return calls;
}

async function getCallCost(accountSid, authToken, callSid) {
  const client = twilio(accountSid, authToken);
  try {
    const call = await client.calls(callSid).fetch();
    return {
      price: call.price ? Math.abs(parseFloat(call.price)) : null,
      priceUnit: call.priceUnit || 'USD',
      duration: parseInt(call.duration) || 0,
    };
  } catch {
    return { price: null, priceUnit: 'USD', duration: 0 };
  }
}

async function getBalance(accountSid, authToken) {
  const client = twilio(accountSid, authToken);
  try {
    const balance = await client.balance.fetch();
    return {
      balance: parseFloat(balance.balance),
      currency: balance.currency,
    };
  } catch {
    return { balance: null, currency: 'USD' };
  }
}

module.exports = { getTwilioCalls, getCallCost, getBalance };
