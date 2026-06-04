const axios = require('axios');

const BASE_URL = 'https://api.retellai.com';

function retellClient(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

async function listCalls(apiKey, filters = {}) {
  const client = retellClient(apiKey);
  const body = {
    limit: filters.limit || 100,
    sort_order: 'descending',
  };
  if (filters.pagination_key) body.pagination_key = filters.pagination_key;
  if (filters.from_date || filters.to_date) {
    body.filter_criteria = {};
    if (filters.from_date) body.filter_criteria.start_timestamp = { lower_threshold: new Date(filters.from_date).getTime() };
    if (filters.to_date) body.filter_criteria.start_timestamp = { ...body.filter_criteria.start_timestamp, upper_threshold: new Date(filters.to_date).getTime() };
  }

  const response = await client.post('/v2/list-calls', body);
  return response.data;
}

async function getCall(apiKey, callId) {
  const client = retellClient(apiKey);
  const response = await client.get(`/v2/get-call/${callId}`);
  return response.data;
}

async function createOutboundCall(apiKey, fromNumber, toNumber, agentId, variables = {}) {
  const client = retellClient(apiKey);
  const body = {
    from_number: fromNumber,
    to_number: toNumber,
    agent_id: agentId,
  };
  if (Object.keys(variables).length > 0) {
    body.retell_llm_dynamic_variables = variables;
  }
  const response = await client.post('/v2/create-phone-call', body);
  return response.data;
}

async function listAgents(apiKey) {
  const client = retellClient(apiKey);
  const response = await client.get('/v2/list-agents');
  return response.data;
}

async function listPhoneNumbers(apiKey) {
  const client = retellClient(apiKey);
  const response = await client.get('/v2/list-phone-numbers');
  return response.data;
}

function normalizeCallData(raw, userId) {
  const durationMs = (raw.end_timestamp && raw.start_timestamp)
    ? raw.end_timestamp - raw.start_timestamp
    : 0;
  const durationSeconds = Math.round(durationMs / 1000);

  const minutes = durationSeconds / 60;
  const retellCost = parseFloat((minutes * parseFloat(process.env.RETELL_COST_PER_MIN || 0.055)).toFixed(4));
  const llmCost = parseFloat((minutes * parseFloat(process.env.LLM_COST_PER_MIN || 0.01)).toFixed(4));

  // Determine mobile vs landline for Twilio cost
  const toNum = raw.to_number || '';
  const isMobile = toNum.match(/^\+614/); // AU mobile starts with +614
  const twilioCostPerMin = isMobile
    ? parseFloat(process.env.TWILIO_AU_MOBILE_COST_PER_MIN || 0.06)
    : parseFloat(process.env.TWILIO_AU_LANDLINE_COST_PER_MIN || 0.02);
  const twilioCost = parseFloat((minutes * twilioCostPerMin).toFixed(4));
  const totalCost = parseFloat((retellCost + twilioCost + llmCost).toFixed(4));

  return {
    user_id: userId,
    call_id: raw.call_id,
    call_type: raw.call_type || 'outbound',
    from_number: raw.from_number || '',
    to_number: raw.to_number || '',
    agent_id: raw.agent_id || '',
    agent_name: raw.agent_name || '',
    status: raw.call_status || 'ended',
    start_timestamp: raw.start_timestamp || null,
    end_timestamp: raw.end_timestamp || null,
    duration_seconds: durationSeconds,
    recording_url: raw.recording_url || null,
    transcript: raw.transcript || null,
    call_summary: raw.call_analysis?.call_summary || null,
    call_outcome: raw.call_analysis?.call_successful ? 'qualified' : null,
    retell_cost: retellCost,
    twilio_cost: twilioCost,
    llm_cost: llmCost,
    total_cost: totalCost,
    raw_data: JSON.stringify(raw),
  };
}

module.exports = { listCalls, getCall, createOutboundCall, listAgents, listPhoneNumbers, normalizeCallData };
