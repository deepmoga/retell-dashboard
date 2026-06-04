const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { userQueries, callQueries, upsertDailyCost } = require('../database/db');
const { listCalls, normalizeCallData } = require('./retell');

let ioInstance = null;

function setSocketIO(io) {
  ioInstance = io;
}

async function downloadRecording(callId, recordingUrl) {
  try {
    const dir = path.join(__dirname, '../public/recordings');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${callId}.mp3`);
    if (fs.existsSync(filePath)) return `/recordings/${callId}.mp3`;

    const response = await axios.get(recordingUrl, {
      responseType: 'stream',
      timeout: 60000,
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    return `/recordings/${callId}.mp3`;
  } catch (err) {
    console.error(`[Sync] Failed to download recording for ${callId}:`, err.message);
    return null;
  }
}

async function syncUserCalls(user) {
  if (!user.retell_api_key) return;

  try {
    console.log(`[Sync] Syncing calls for user ${user.id}...`);
    const data = await listCalls(user.retell_api_key, { limit: 100 });
    const calls = Array.isArray(data) ? data : (data.call_list || data.calls || []);

    for (const rawCall of calls) {
      const normalized = normalizeCallData(rawCall, user.id);
      callQueries.upsert.run(normalized);

      // Download recording if not saved locally
      if (normalized.recording_url && normalized.status === 'ended') {
        const existing = callQueries.findByCallId.get(normalized.call_id);
        if (existing && !existing.recording_local_path) {
          const localPath = await downloadRecording(normalized.call_id, normalized.recording_url);
          if (localPath) {
            callQueries.updateRecordingPath.run(localPath, normalized.call_id);
          }
        }
      }

      // Update daily cost aggregates
      if (normalized.status === 'ended' && normalized.start_timestamp) {
        const dateStr = new Date(normalized.start_timestamp).toISOString().slice(0, 10);
        upsertDailyCost(user.id, dateStr, {
          calls: 0, // avoid double counting — handled separately
          minutes: normalized.duration_seconds / 60,
          retell: 0,
          twilio: 0,
          llm: 0,
          total: 0,
        });
      }
    }

    console.log(`[Sync] Processed ${calls.length} calls for user ${user.id}`);
  } catch (err) {
    console.error(`[Sync] Error syncing user ${user.id}:`, err.message);
  }
}

async function syncAllCalls() {
  console.log('[Sync] Starting full sync...');
  const users = userQueries.getApiKeys.all();

  for (const user of users) {
    await syncUserCalls(user);
  }

  if (ioInstance) {
    const activeCalls = callQueries.getActiveCalls.all();
    ioInstance.emit('calls_updated', { totalActive: activeCalls.length });
  }

  console.log('[Sync] Full sync complete.');
}

function startSyncJob() {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    syncAllCalls().catch(err => console.error('[Sync] Cron error:', err.message));
  });

  // Run immediately on startup after a short delay
  setTimeout(() => {
    syncAllCalls().catch(err => console.error('[Sync] Initial sync error:', err.message));
  }, 5000);

  console.log('[Sync] Background sync job started (every 5 minutes)');
}

module.exports = { startSyncJob, syncAllCalls, syncUserCalls, downloadRecording, setSocketIO };
