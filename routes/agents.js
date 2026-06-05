const express = require('express');
const authMiddleware = require('../middleware/auth');
const retell = require('../services/retell');
const { userQueries } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

function getRetellKey(req) {
  const user = userQueries.findById.get(req.user.userId);
  return user?.retell_api_key || '';
}

router.get('/', async (req, res) => {
  try {
    const apiKey = getRetellKey(req);
    if (!apiKey) return res.json({ agents: [], no_key: true });
    const agents = await retell.listAgents(apiKey);
    res.json({ agents: agents || [] });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.get('/voices', async (req, res) => {
  try {
    const apiKey = getRetellKey(req);
    if (!apiKey) return res.json({ voices: [] });
    const voices = await retell.listVoices(apiKey);
    res.json({ voices: voices || [] });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const apiKey = getRetellKey(req);
    const agent = await retell.getAgent(apiKey, req.params.id);
    if (agent.response_engine?.type === 'retell-llm' && agent.response_engine.llm_id) {
      try {
        agent.llm = await retell.getRetellLLM(apiKey, agent.response_engine.llm_id);
      } catch (_) {}
    }
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const apiKey = getRetellKey(req);
    if (!apiKey) return res.status(400).json({ error: 'No Retell API key configured. Add it in Settings.' });

    const { agent_name, voice_id, language, begin_message, system_prompt, responsiveness, interruption_sensitivity } = req.body;

    const llmPayload = { model: 'gpt-4o-mini', system_prompt: system_prompt || '' };
    if (begin_message) llmPayload.begin_message = begin_message;
    const llm = await retell.createRetellLLM(apiKey, llmPayload);

    const agentPayload = {
      agent_name: agent_name || 'New Agent',
      voice_id: voice_id || '11labs-Adrian',
      language: language || 'en-US',
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      responsiveness: responsiveness !== undefined ? parseFloat(responsiveness) : 1.0,
      interruption_sensitivity: interruption_sensitivity !== undefined ? parseFloat(interruption_sensitivity) : 1.0,
    };

    const agent = await retell.createAgent(apiKey, agentPayload);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const apiKey = getRetellKey(req);
    const { agent_name, voice_id, language, begin_message, system_prompt, responsiveness, interruption_sensitivity, llm_id } = req.body;

    const agentUpdate = {};
    if (agent_name !== undefined) agentUpdate.agent_name = agent_name;
    if (voice_id !== undefined) agentUpdate.voice_id = voice_id;
    if (language !== undefined) agentUpdate.language = language;
    if (responsiveness !== undefined) agentUpdate.responsiveness = parseFloat(responsiveness);
    if (interruption_sensitivity !== undefined) agentUpdate.interruption_sensitivity = parseFloat(interruption_sensitivity);

    if (Object.keys(agentUpdate).length > 0) {
      await retell.updateAgent(apiKey, req.params.id, agentUpdate);
    }

    if (llm_id && (system_prompt !== undefined || begin_message !== undefined)) {
      const llmUpdate = {};
      if (system_prompt !== undefined) llmUpdate.system_prompt = system_prompt;
      if (begin_message !== undefined) llmUpdate.begin_message = begin_message;
      await retell.updateRetellLLM(apiKey, llm_id, llmUpdate);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const apiKey = getRetellKey(req);
    await retell.deleteAgent(apiKey, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
