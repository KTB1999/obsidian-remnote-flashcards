import { PluginSettings } from "./types";

// Strip qwen3/DeepSeek thinking-mode blocks from response (no-op for other models)
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Returns true for Ollama-hosted qwen models that support /no_think.
 * Any other provider (NIM, OpenAI, Anthropic, custom) gets the prompt as-is.
 */
function isQwenOllama(settings: PluginSettings): boolean {
  const model = settings.aiModel.toLowerCase();
  const url   = settings.aiBaseUrl.toLowerCase();
  // Only apply if running against localhost/127 (Ollama) AND model is qwen/deepseek
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const isQwen  = model.includes("qwen") || model.includes("deepseek");
  return isLocal && isQwen;
}

async function callAI(prompt: string, settings: PluginSettings, maxTokens = 300): Promise<string> {
  // /no_think disables qwen3 reasoning mode — only safe to send to local Ollama qwen models
  const finalPrompt = isQwenOllama(settings) ? `/no_think ${prompt}` : prompt;

  const response = await fetch(`${settings.aiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.aiApiKey}`,
    },
    body: JSON.stringify({
      model:       settings.aiModel,
      messages:    [{ role: "user", content: finalPrompt }],
      temperature: 0.3,
      max_tokens:  maxTokens,
      stream:      false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`AI ${response.status}: ${errText.slice(0, 200)}`);
  }

  const json = await response.json();
  let content: string =
    json.choices?.[0]?.message?.content ??
    json.choices?.[0]?.text ??   // some Ollama versions
    "";

  // Strip thinking tags in case model ignored /no_think (safe no-op for other providers)
  content = stripThinking(content);

  if (!content) {
    throw new Error(
      "Keine Antwort vom Modell.\n" +
      "Prüfe Modellname, API Key und Base URL.\n" +
      "(Rohinhalt: " + JSON.stringify(json).slice(0, 150) + ")"
    );
  }

  return content;
}

/** Used while writing a note: generate a concise answer for a flashcard question. */
export async function aiGenerateAnswer(
  question: string,
  context: string,
  settings: PluginSettings
): Promise<string> {
  if (!settings.aiEnabled) return "";

  const prompt = context
    ? `You are a study assistant. Based on these notes:\n\n${context}\n\nAnswer this question concisely (max 2 sentences):\n${question}`
    : `You are a study assistant. Answer this question concisely in 1-2 sentences. Give only the answer, no preamble:\n${question}`;

  return callAI(prompt, settings, 150);
}

/** Used during review: explain why the answer is correct. */
export async function aiExplainAnswer(
  question: string,
  answer: string,
  settings: PluginSettings
): Promise<string> {
  if (!settings.aiEnabled) return "";

  const prompt =
    `You are a study assistant. Briefly explain (2-3 sentences) why this answer is correct:\n\n` +
    `Question: ${question}\n` +
    `Answer: ${answer}\n\n` +
    `Reply in the same language as the question. Use an example if it helps.`;

  return callAI(prompt, settings, 250);
}
