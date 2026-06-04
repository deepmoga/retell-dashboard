const express = require('express');
const { callQueries, userQueries } = require('../database/db');
const { normalizeCallData } = require('../services/retell');
const { downloadRecording } = require('../services/sync');

const router = express.Router();

let ioInstance = null;

function setSocketIO(io) {
  ioInstance = io;
}

// Find user by their retell API key or by agent ownership
function findUserForCall(callData) {
  const users = userQueries.getApiKeys.all();
  // Try to match by agent_id or phone number ownership
  // Default: check if call already exists in DB with a user_id
  const existing = callData.call_id ? callQueries.findByCallId.get(callData.call_id) : null;
  if (existing?.user_id) return existing.user_id;
  // Return first user with retell key as fallback (single-tenant fallback)
  return users[0]?.id || 1;
}

router.post('/', async (req, res) => {
  // Acknowledge immediately
  res.status(200).json({ received: true });

  try {
    const event = req.body;
    const eventType = event.event;
    const callData = event.call || event.data || event;

    console.log(`[Webhook] Received event: ${eventType}, call_id: ${callData.call_id}`);

    if (eventType === 'call_started' || callData.call_status === 'ongoing') {
      const userId = findUserForCall(callData);
      const normalized = normalizeCallData({ ...callData, call_status: 'ongoing' }, userId);
      callQueries.upsert.run(normalized);

      if (ioInstance) {
        ioInstance.emit('call_started', {
          callId: callData.call_id,
          fromNumber: callData.from_number,
          toNumber: callData.to_number,
          agentName: callData.agent_name || '',
          startTime: callData.start_timestamp || Date.now(),
        });
        ioInstance.emit('calls_updated', {
          totalActive: callQueries.getActiveCalls.all().length,
        });
      }
    }

    if (eventType === 'call_ended' || eventType === 'call_analyzed' || callData.call_status === 'ended') {
      const userId = findUserForCall(callData);
      const normalized = normalizeCallData({ ...callData, call_status: 'ended' }, userId);
      callQueries.upsert.run(normalized);

      // Download recording
      if (normalized.recording_url) {
        downloadRecording(normalized.call_id, normalized.recording_url).then(localPath => {
          if (localPath) callQueries.updateRecordingPath.run(localPath, normalized.call_id);
        }).catch(err => console.error('[Webhook] Recording download error:', err.message));
      }

      if (ioInstance) {
        ioInstance.emit('call_ended', {
          callId: callData.call_id,
          duration: normalized.duration_seconds,
          cost: normalized.total_cost,
        });
        ioInstance.emit('calls_updated', {
          totalActive: callQueries.getActiveCalls.all().length,
        });
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

module.exports = { router, setSocketIO };
