const express = require('express');
const { callQueries, userQueries } = require('../database/db');
const { normalizeCallData } = require('../services/vapi');
const { downloadRecording } = require('../services/sync');

const router = express.Router();
let ioInstance = null;

function setSocketIO(io) { ioInstance = io; }

function findUserForCall(callData) {
  const vapiCallId = `vapi_${callData.call?.id || callData.id}`;
  const existing = callQueries.findByCallId.get(vapiCallId);
  if (existing?.user_id) return existing.user_id;
  // Find user with VAPI key
  const users = userQueries.getApiKeys.all();
  const vapiUser = users.find(u => u.vapi_api_key);
  return vapiUser?.id || 1;
}

router.post('/', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const event = req.body;
    const msg = event.message || event;
    const type = msg.type || event.type;
    const callData = msg.call || event.call || msg;

    console.log(`[VAPI Webhook] Event: ${type}, call: ${callData?.id}`);

    const userId = findUserForCall(callData);

    if (type === 'call-started' || type === 'status-update' && callData.status === 'in-progress') {
      const normalized = normalizeCallData({ ...callData, status: 'in-progress' }, userId);
      callQueries.upsert.run(normalized);
      if (ioInstance) {
        ioInstance.emit('call_started', {
          callId: normalized.call_id,
          fromNumber: normalized.from_number,
          toNumber: normalized.to_number,
          agentName: normalized.agent_name,
          startTime: normalized.start_timestamp || Date.now(),
        });
        ioInstance.emit('calls_updated', { totalActive: callQueries.getActiveCalls.all().length });
      }
    }

    if (type === 'end-of-call-report' || type === 'call-ended') {
      const reportData = msg.call || callData;
      const normalized = normalizeCallData({ ...reportData, status: 'ended' }, userId);
      callQueries.upsert.run(normalized);

      if (normalized.recording_url) {
        downloadRecording(normalized.call_id, normalized.recording_url).then(p => {
          if (p) callQueries.updateRecordingPath.run(p, normalized.call_id);
        }).catch(() => {});
      }

      if (ioInstance) {
        ioInstance.emit('call_ended', { callId: normalized.call_id, duration: normalized.duration_seconds, cost: normalized.total_cost });
        ioInstance.emit('calls_updated', { totalActive: callQueries.getActiveCalls.all().length });
      }
    }
  } catch (err) {
    console.error('[VAPI Webhook] Error:', err.message);
  }
});

module.exports = { router, setSocketIO };
