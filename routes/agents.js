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

// Create or reuse VAPI tools for a user, return their IDs
async function ensureBookingTools(apiKey, userId) {
  try {
    const serverBase = `${BASE_URL}/api/vapi-tools/${userId}`;
    const existing = await vapi.listTools(apiKey);

    const findOrCreate = async (name, description, parameters, url) => {
      const found = existing.find(t => t.function?.name === name);
      if (found) {
        // update URL in case domain changed
        try {
          const client = require('axios').create({
            baseURL: 'https://api.vapi.ai',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          });
          await client.patch(`/tool/${found.id}`, { server: { url } });
        } catch (_) {}
        return found.id;
      }
      const created = await vapi.createTool(apiKey, {
        type: 'function',
        function: { name, description, parameters },
        server: { url },
      });
      return created.id;
    };

    const checkId = await findOrCreate(
      'checkAvailability',
      'Check if a date and time slot is available for booking an appointment',
      {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format e.g. 2024-12-25' },
          time: { type: 'string', description: 'Time in HH:MM 24-hour format e.g. 10:00 or 14:30' },
        },
        required: ['date', 'time'],
      },
      `${serverBase}/check-availability`
    );

    const bookId = await findOrCreate(
      'bookAppointment',
      'Save a confirmed appointment booking into the system',
      {
        type: 'object',
        properties: {
          date:           { type: 'string', description: 'Date in YYYY-MM-DD format' },
          time:           { type: 'string', description: 'Time in HH:MM 24-hour format' },
          customer_name:  { type: 'string', description: 'Full name of the customer' },
          customer_phone: { type: 'string', description: 'Customer phone number' },
          service_type:   { type: 'string', description: 'Type of service being booked' },
        },
        required: ['date', 'time', 'customer_name', 'customer_phone'],
      },
      `${serverBase}/book-appointment`
    );

    return [checkId, bookId];
  } catch (err) {
    console.error('[ensureBookingTools] Error:', err.response?.data || err.message);
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
    if (!apiKey) return res.status(400).json({ error: 'No VAPI API key configured. Add it in Settings.' });

    const { agent_name, voice_provider, voice_id, language, first_message, system_prompt } = req.body;
    const modelChoice = req.body.model_id || 'gpt-4o-mini';

    // Create booking tools and get their IDs
    const toolIds = await ensureBookingTools(apiKey, req.user.userId);

    const payload = {
      name: agent_name || 'New Agent',
      model: {
        provider: getModelProvider(modelChoice),
        model: modelChoice,
        systemPrompt: system_prompt || '',
        temperature: 0.7,
      },
      ...(toolIds.length > 0 ? { toolIds } : {}),
      voice: {
        provider: voice_provider || '11labs',
        voiceId: voice_id || 'paula',
      },
      firstMessage: first_message || '',
      language: language || 'en-US',
      responseDelaySeconds: 0,
      firstMessageMode: 'assistant-speaks-first',
    };

    const agent = await vapi.createAssistant(apiKey, payload);
    res.json({ agent });
  } catch (err) {
    const vapiError = err.response?.data;
    console.error('[Agents POST] Error:', JSON.stringify(vapiError || err.message));
    const msg = vapiError?.message || (Array.isArray(vapiError) ? JSON.stringify(vapiError) : null) || err.message;
    res.status(500).json({ error: msg });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    const { agent_name, voice_provider, voice_id, language, first_message, system_prompt } = req.body;
    const modelChoice = req.body.model_id || 'gpt-4o-mini';

    // Ensure booking tools exist and get IDs
    const toolIds = await ensureBookingTools(apiKey, req.user.userId);

    const payload = {
      responseDelaySeconds: 0,
      ...(toolIds.length > 0 ? { toolIds } : {}),
    };

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
      payload.voice = {
        provider: voice_provider || '11labs',
        voiceId: voice_id || 'paula',
      };
    }

    await vapi.updateAssistant(apiKey, req.params.id, payload);
    res.json({ success: true });
  } catch (err) {
    const vapiError = err.response?.data;
    console.error('[Agents PUT] Error:', JSON.stringify(vapiError || err.message));
    const msg = vapiError?.message || (Array.isArray(vapiError) ? JSON.stringify(vapiError) : null) || err.message;
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

module.exports = router;
