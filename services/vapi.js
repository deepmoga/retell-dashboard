const axios = require('axios');

const BASE_URL = 'https://api.vapi.ai';

function vapiClient(apiKey) {
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
  const client = vapiClient(apiKey);
  const params = { limit: filters.limit || 100 };
  if (filters.createdAtGt) params.createdAtGt = filters.createdAtGt;
  const response = await client.get('/call', { params });
  return Array.isArray(response.data) ? response.data : (response.data?.results || []);
}

async function getCall(apiKey, callId) {
  const client = vapiClient(apiKey);
  const response = await client.get(`/call/${callId}`);
  return response.data;
}

async function createOutboundCall(apiKey, phoneNumberId, customerId, assistantId, variables = {}) {
  const client = vapiClient(apiKey);
  const body = {
    phoneNumberId,
    customer: { number: customerId },
    assistantId,
  };
  if (Object.keys(variables).length > 0) {
    body.assistantOverrides = { variableValues: variables };
  }
  const response = await client.post('/call/phone', body);
  return response.data;
}

async function listAssistants(apiKey) {
  const client = vapiClient(apiKey);
  const response = await client.get('/assistant');
  return Array.isArray(response.data) ? response.data : [];
}

async function listPhoneNumbers(apiKey) {
  const client = vapiClient(apiKey);
  const response = await client.get('/phone-number');
  return Array.isArray(response.data) ? response.data : [];
}

function normalizeCallData(raw, userId) {
  // VAPI call status mapping
  const statusMap = {
    ended: 'ended', queued: 'ongoing', ringing: 'ongoing',
    'in-progress': 'ongoing', forwarding: 'ongoing',
  };

  const startTs = raw.startedAt ? new Date(raw.startedAt).getTime() : null;
  const endTs = raw.endedAt ? new Date(raw.endedAt).getTime() : null;
  const durationSeconds = (startTs && endTs) ? Math.round((endTs - startTs) / 1000) : 0;

  const minutes = durationSeconds / 60;
  const retellCost = 0; // VAPI handles its own cost
  const vapiCost = raw.cost ? parseFloat(raw.cost) : parseFloat((minutes * 0.05).toFixed(4));
  const llmCost = parseFloat((minutes * parseFloat(process.env.LLM_COST_PER_MIN || 0.01)).toFixed(4));
  const totalCost = parseFloat((vapiCost + llmCost).toFixed(4));

  return {
    user_id: userId,
    call_id: `vapi_${raw.id}`,
    call_type: raw.type === 'inboundPhoneCall' ? 'inbound' : 'outbound',
    from_number: raw.customer?.number || raw.phoneNumber?.number || '',
    to_number: raw.customer?.number || '',
    agent_id: raw.assistantId || '',
    agent_name: raw.assistant?.name || 'VAPI Agent',
    status: statusMap[raw.status] || 'ended',
    start_timestamp: startTs,
    end_timestamp: endTs,
    duration_seconds: durationSeconds,
    recording_url: raw.recordingUrl || null,
    transcript: raw.transcript || null,
    call_summary: raw.analysis?.summary || raw.summary || null,
    call_outcome: raw.analysis?.successEvaluation === 'true' ? 'qualified' : null,
    retell_cost: retellCost,
    twilio_cost: vapiCost,   // reuse twilio_cost field for VAPI cost
    llm_cost: llmCost,
    total_cost: totalCost,
    raw_data: JSON.stringify({ ...raw, _provider: 'vapi' }),
  };
}

module.exports = { listCalls, getCall, createOutboundCall, listAssistants, listPhoneNumbers, normalizeCallData };
