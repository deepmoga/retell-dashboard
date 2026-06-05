const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { userQueries, callQueries, upsertDailyCost } = require('../database/db');
const { listCalls: retellListCalls, normalizeCallData: retellNormalize } = require('./retell');
const { listCalls: vapiListCalls, normalizeCallData: vapiNormalize } = require('./vapi');

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

async function syncProviderCalls(user, provider) {
  try {
    let calls = [];

    if (provider === 'retell' && user.retell_api_key) {
      const data = await retellListCalls(user.retell_api_key, { limit: 100 });
      const raw = Array.isArray(data) ? data : (data.call_list || data.calls || []);
      calls = raw.map(c => retellNormalize(c, user.id));
    } else if (provider === 'vapi' && user.vapi_api_key) {
      const raw = await vapiListCalls(user.vapi_api_key, { limit: 100 });
      calls = raw.map(c => vapiNormalize(c, user.id));
    }

    for (const normalized of calls) {
      callQueries.upsert.run(normalized);

      if (normalized.recording_url && normalized.status === 'ended') {
        const existing = callQueries.findByCallId.get(normalized.call_id);
        if (existing && !existing.recording_local_path) {
          const localPath = await downloadRecording(normalized.call_id, normalized.recording_url);
          if (localPath) callQueries.updateRecordingPath.run(localPath, normalized.call_id);
        }
      }
    }

    if (calls.length > 0) {
      console.log(`[Sync] ${provider.toUpperCase()}: ${calls.length} calls for user ${user.id}`);
    }
  } catch (err) {
    console.error(`[Sync] ${provider} error for user ${user.id}:`, err.message);
  }
}

async function syncUserCalls(user) {
  await syncProviderCalls(user, 'retell');
  await syncProviderCalls(user, 'vapi');
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
