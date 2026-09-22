// Context chat — discuss any scraped item (hackathon / internship / website) with Ek Sathi.
// Stateless: the client owns the conversation history and sends the relevant extracted
// facts as `subject.contextText`. The LLM answers strictly from those facts.

const TYPE_META = {
  hackathon: { icon: '🏆', label: 'Hackathon' },
  internship: { icon: '💼', label: 'Internship' },
  website: { icon: '🌐', label: 'Website deep-scan' },
  repo: { icon: '📦', label: 'GitHub Repo' },
};

function buildSystem(subject) {
  const meta = TYPE_META[subject && subject.type] || TYPE_META.website;
  const title = String((subject && subject.title) || 'this thing').trim();
  const context = String((subject && subject.contextText) || '').trim();
  return [
    'You are Ek Sathi — a friendly, curious AI companion. Think like a smart, caring best friend, NOT a servant.',
    `Right now you are discussing "${title}" (${meta.label}) with the user.`,
    context
      ? `REAL EXTRACTED FACTS about it — answer ONLY from these, kabhi invent mat karo:\n${context}`
      : 'No scraped facts were attached — so answer honestly about the limits of what you know.',
    'Rules: markdown answers, concise but genuinely useful (roughly 150-350 words). Thoda casual Hinglish natural lage to theek hai.',
    'Agar scraped context me answer nahi milta, clearly bolo: "Scraped data me iska jawab nahi mila" aur aise sawaal suggest karo jo is context se pooche ja sakte hain.',
    'Kabhi bhi guess ko pakka fact ki tarah mat present karo. Evidence se hi baat karo.',
  ].filter(Boolean).join('\n\n');
}

async function discuss(subject, messages) {
  const safe = (Array.isArray(messages) ? messages : [])
    .slice(-12)
    .map((m) => ({
      role: m && m.role === 'user' ? 'user' : 'assistant',
      content: String((m && m.content) || '').slice(0, 3000),
    }))
    .filter((m) => m.content.trim());
  if (!safe.length) return { status: 'error', message: 'Koi chat history nahi mili.' };

  const llm = require('./llmService');
  const res = await llm.callLLM({
    role: 'chat',
    messages: [{ role: 'system', content: buildSystem(subject) }, ...safe],
    temperature: 0.4,
    max_tokens: 900,
  });
  return { status: 'ok', answer: res.text };
}

module.exports = { discuss };