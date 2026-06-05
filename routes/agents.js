const express = require('express');
const authMiddleware = require('../middleware/auth');
const vapi = require('../services/vapi');
const { userQueries } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

function getVapiKey(req) {
  const user = userQueries.findById.get(req.user.userId);
  return user?.vapi_api_key || '';
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

    const { agent_name, voice_provider, voice_id, language, first_message, system_prompt, responsiveness, interruption_sensitivity } = req.body;

    const modelChoice = req.body.model_id || 'gpt-4o-mini';
    const modelProvider = modelChoice.startsWith('llama') || modelChoice.startsWith('mixtral') || modelChoice.startsWith('gemma') ? 'groq' : 'openai';

    const payload = {
      name: agent_name || 'New Agent',
      model: {
        provider: modelProvider,
        model: modelChoice,
        systemPrompt: system_prompt || '',
        temperature: 0.7,
      },
      voice: {
        provider: voice_provider || '11labs',
        voiceId: voice_id || 'paula',
        speed: 1.1,
      },
      firstMessage: first_message || '',
      language: language || 'en-US',
      responseDelaySeconds: 0,
      llmRequestDelaySeconds: 0,
      backgroundDenoisingEnabled: false,
      firstMessageMode: 'assistant-speaks-first',
    };

    const agent = await vapi.createAssistant(apiKey, payload);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const apiKey = getVapiKey(req);
    const { agent_name, voice_provider, voice_id, language, first_message, system_prompt } = req.body;

    const { model_id } = req.body;
    const modelChoice = model_id || 'gpt-4o-mini';
    const modelProvider = modelChoice.startsWith('llama') || modelChoice.startsWith('mixtral') || modelChoice.startsWith('gemma') ? 'groq' : 'openai';

    const payload = {
      responseDelaySeconds: 0,
      llmRequestDelaySeconds: 0,
    };
    if (agent_name !== undefined) payload.name = agent_name;
    if (first_message !== undefined) payload.firstMessage = first_message;
    if (language !== undefined) payload.language = language;
    if (system_prompt !== undefined) payload.model = { provider: modelProvider, model: modelChoice, systemPrompt: system_prompt, temperature: 0.7 };
    if (voice_provider !== undefined || voice_id !== undefined) {
      payload.voice = { provider: voice_provider || '11labs', voiceId: voice_id || 'paula', speed: 1.1 };
    }

    await vapi.updateAssistant(apiKey, req.params.id, payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
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
