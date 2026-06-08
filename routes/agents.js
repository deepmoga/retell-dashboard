const express = require('express');
const authMiddleware = require('../middleware/auth');
const vapi = require('../services/vapi');
const { userQueries } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

const BASE_URL = process.env.BASE_URL || 'https://calling.officialdigitalmarketing.in';

function getVapiKey(req) {
  const user = userQueries.findById.get(req.user.userId);
  return user?.vapi_api_key || '';
}

function getModelProvider(modelChoice) {
  return (modelChoice.startsWith('llama') || modelChoice.startsWith('mixtral') || modelChoice.startsWith('gemma'))
    ? 'groq' : 'openai';
}

// Dynamic — current date injected every time agent is saved
// so VAPI's analysis LLM always knows the correct year
function getAnalysisPlan() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const year  = new Date().getFullYear();
  return {
    structuredDataPrompt: `TODAY'S DATE IS ${today}. CURRENT YEAR IS ${year}.

Extract booking details from this call transcript. Return a JSON object:

- booking_confirmed: boolean.
  Set TRUE if the customer said YES or confirmed the appointment at any point (even "yeah", "sure", "that's fine", "sounds good", "correct", "yes please").
  Set FALSE only if customer said NO, not interested, or call ended with no confirmation at all.

- customer_name: name given by customer (null if not given)

- customer_phone: phone number given by customer (null if not given — this is optional, don't require it)

- appointment_date: YYYY-MM-DD format. CRITICAL RULES:
  * CURRENT YEAR IS ${year}. NEVER output a year before ${year}.
  * "this Friday" = next Friday from ${today}
  * "coming Friday" = next Friday from ${today}
  * "next Monday" = Monday of next week
  * "12th of June" or "June 12" = ${year}-06-12
  * "tomorrow" = ${new Date(new Date(today).getTime() + 86400000).toISOString().slice(0,10)}
  * Calculate day names (Monday/Tuesday etc) from today=${today}
  * If genuinely unclear, set null

- appointment_time: HH:MM 24-hour.
  * "10 AM" / "10 in the morning" = "10:00"
  * "2 PM" / "2 in the afternoon" = "14:00"
  * "3:30 PM" / "half past 3" = "15:30"
  * "11 o'clock" = "11:00"
  * If not given, set null

- service_type: service mentioned (null if not mentioned)

IMPORTANT: Set booking_confirmed=true as long as customer agreed to the appointment, even if phone number was not collected. Phone is optional.`,
    structuredDataSchema: {
      type: 'object',
      properties: {
        booking_confirmed:  { type: 'boolean' },
        customer_name:      { type: 'string' },
        customer_phone:     { type: 'string' },
        appointment_date:   { type: 'string' },
        appointment_time:   { type: 'string' },
        service_type:       { type: 'string' },
      },
    },
  };
}

// Create/ensure VAPI tools exist, return their IDs
async function ensureBookingTools(apiKey, userId) {
  try {
    const serverBase = `${BASE_URL}/api/vapi-tools/${userId}`;
    const existing = await vapi.listTools(apiKey);

    const upsertTool = async (name, description, parameters, url) => {
      const found = existing.find(t => t.function?.name === name);
      if (found) return found.id;
      const created = await vapi.createTool(apiKey, {
        type: 'function',
        function: { name, description, parameters },
        server: { url },
      });
      return created.id;
    };

    const checkId = await upsertTool(
      'checkAvailability',
      'Check if a date and time slot is available for booking an appointment. Call this BEFORE confirming any slot.',
      {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          time: { type: 'string', description: 'Time in HH:MM 24-hour format' },
        },
        required: ['date', 'time'],
      },
      `${serverBase}/check-availability`
    );

    const bookId = await upsertTool(
      'bookAppointment',
      'Save the confirmed appointment to the system. Call this ONLY after customer confirms.',
      {
        type: 'object',
        properties: {
          date:           { type: 'string', description: 'Date YYYY-MM-DD' },
          time:           { type: 'string', description: 'Time HH:MM 24h' },
          customer_name:  { type: 'string', description: 'Customer full name' },
          customer_phone: { type: 'string', description: 'Customer phone number' },
          service_type:   { type: 'string', description: 'Service type' },
        },
        required: ['date', 'time', 'customer_name', 'customer_phone'],
      },
      `${serverBase}/book-appointment`
    );

    console.log(`[Tools] checkAvailability: ${checkId}, bookAppointment: ${bookId}`);
    return [checkId, bookId];
  } catch (err) {
    console.error('[ensureBookingTools]', err.response?.data || err.message);
    return [];
  }
}

router.get('/', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    if (!apiKey) return res.json({ agents: [], no_key: true });
    const agents = await vapi.listAssistants(apiKey);
    res.json({ agents: agents || [] });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    const agent = await vapi.getAssistant(apiKey, req.params.id);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    if (!apiKey) return res.status(400).json({ error: 'No VAPI API key configured.' });

    const { agent_name, voice_provider, voice_id, language, first_message, system_prompt } = req.body;
    const modelChoice = req.body.model_id || 'gpt-4o-mini';

    // Step 1: Create agent WITHOUT toolIds
    const payload = {
      name: agent_name || 'New Agent',
      model: {
        provider: getModelProvider(modelChoice),
        model: modelChoice,
        systemPrompt: system_prompt || '',
        temperature: 0.7,
      },
      analysisPlan: getAnalysisPlan(),
      voice: { provider: voice_provider || '11labs', voiceId: voice_id || 'paula' },
      firstMessage: first_message || '',
      language: language || 'en-US',
      responseDelaySeconds: 0,
      firstMessageMode: 'assistant-speaks-first',
    };

    const agent = await vapi.createAssistant(apiKey, payload);

    // Step 2: Try to attach toolIds SEPARATELY (isolation avoids conflict errors)
    try {
      const toolIds = await ensureBookingTools(apiKey, req.user.userId);
      if (toolIds.length > 0) {
        await vapi.updateAssistant(apiKey, agent.id, { toolIds });
        console.log(`[Agents] Tools attached to new agent ${agent.id}`);
      }
    } catch (toolErr) {
      console.error('[Agents] Tool attach failed (non-fatal):', toolErr.response?.data || toolErr.message);
    }

    res.json({ agent });
  } catch (err) {
    const msg = err.response?.data?.message || (Array.isArray(err.response?.data) ? JSON.stringify(err.response.data) : null) || err.message;
    console.error('[Agents POST]', msg);
    res.status(500).json({ error: msg });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    const { agent_name, voice_provider, voice_id, language, first_message, system_prompt } = req.body;
    const modelChoice = req.body.model_id || 'gpt-4o-mini';

    // Step 1: Update agent settings WITHOUT toolIds
    const payload = { analysisPlan: getAnalysisPlan(), responseDelaySeconds: 0 };
    if (agent_name !== undefined) payload.name = agent_name;
    if (first_message !== undefined) payload.firstMessage = first_message;
    if (language !== undefined) payload.language = language;
    if (system_prompt !== undefined) {
      payload.model = {
        provider: getModelProvider(modelChoice),
        model: modelChoice,
        systemPrompt: system_prompt,
        temperature: 0.7,
      };
    }
    if (voice_provider !== undefined || voice_id !== undefined) {
      payload.voice = { provider: voice_provider || '11labs', voiceId: voice_id || 'paula' };
    }

    await vapi.updateAssistant(apiKey, req.params.id, payload);

    // Step 2: Attach toolIds SEPARATELY
    try {
      const toolIds = await ensureBookingTools(apiKey, req.user.userId);
      if (toolIds.length > 0) {
        await vapi.updateAssistant(apiKey, req.params.id, { toolIds });
        console.log(`[Agents] Tools re-attached to ${req.params.id}:`, toolIds);
      }
    } catch (toolErr) {
      console.error('[Agents] Tool attach failed (non-fatal):', toolErr.response?.data || toolErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.message || (Array.isArray(err.response?.data) ? JSON.stringify(err.response.data) : null) || err.message;
    console.error('[Agents PUT]', msg);
    res.status(500).json({ error: msg });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    await vapi.deleteAssistant(apiKey, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Fix ALL agents: update analysisPlan + re-attach booking tools ─────────────
router.post('/fix-analysis', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    if (!apiKey) return res.status(400).json({ error: 'No VAPI API key configured.' });

    const agents = await vapi.listAssistants(apiKey);
    if (!agents.length) return res.json({ updated: 0, message: 'No agents found' });

    const plan = getAnalysisPlan();
    // Get booking tool IDs (create if not exist)
    const toolIds = await ensureBookingTools(apiKey, req.user.userId);

    let updated = 0;
    const errors = [];

    for (const agent of agents) {
      try {
        // Step 1: update analysisPlan
        await vapi.updateAssistant(apiKey, agent.id, { analysisPlan: plan });
        // Step 2: attach booking tools
        if (toolIds.length > 0) {
          await vapi.updateAssistant(apiKey, agent.id, { toolIds });
        }
        updated++;
        console.log(`[Fix] Updated agent: ${agent.name} (${agent.id}) — plan + tools`);
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        errors.push(`${agent.name}: ${msg}`);
        console.error(`[Fix] Failed for ${agent.name}:`, msg);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    res.json({
      updated,
      total: agents.length,
      tools_attached: toolIds.length,
      errors,
      message: `✅ ${updated}/${agents.length} agents updated — today's date (${today}) injected + booking tools attached`,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
