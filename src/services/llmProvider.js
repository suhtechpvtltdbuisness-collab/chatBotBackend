import { config } from "../config/env.js";

class LLMProvider {
  constructor() {
    this.apiKey = (config.llm.apiKey || "").trim();
    this.baseUrl = config.llm.baseUrl;
    this.defaultModel = config.llm.model;
    this.allowStubFallback = Boolean(config.llm.allowStubFallback);
  }

  buildStubResponse(messages, model = this.defaultModel) {
    return {
      content:
        "[stubbed LLM response] " +
        (messages[messages.length - 1]?.content || ""),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model,
      finishReason: "stop",
    };
  }

  async generateResponse(messages, options = {}) {
    try {
      const {
        model = this.defaultModel,
        temperature = 0.7,
        maxTokens = 500,
        systemPrompt = null,
      } = options;

      // Prepare messages array
      const formattedMessages = [];

      if (systemPrompt) {
        formattedMessages.push({
          role: "system",
          content: systemPrompt,
        });
      }

      // Add conversation history
      formattedMessages.push(...messages);

      if (typeof fetch !== "function") {
        throw new Error(
          "Global fetch is unavailable in this runtime. Use Node.js 18+ to call the LLM API.",
        );
      }

      if (!this.apiKey) {
        if (this.allowStubFallback) {
          console.warn(
            "LLM API key missing. Returning stubbed response because ALLOW_LLM_STUB_FALLBACK=true.",
          );
          return this.buildStubResponse(messages, model);
        }
        throw new Error(
          "Missing LLM API key. Set SAMBANOVA_API_KEY (or LLM_API_KEY) in your environment.",
        );
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: formattedMessages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401) {
          throw new Error(
            `LLM authentication failed (401). Verify SAMBANOVA_API_KEY and LLM_BASE_URL. Provider said: ${errorText}`,
          );
        }
        throw new Error(`LLM API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      return {
        content: data.choices[0].message.content,
        usage: data.usage,
        model: data.model,
        finishReason: data.choices[0].finish_reason,
      };
    } catch (error) {
      if (this.allowStubFallback) {
        console.warn(
          "LLM Provider error, falling back to stub:",
          error.message,
        );
        return this.buildStubResponse(messages);
      }

      throw error;
    }
  }

  async generateEmbedding(text) {
    try {
      // For now, return a simple hash-based embedding
      // In production, use a proper embedding model
      const hash = this.simpleHash(text);
      const embedding = new Array(384)
        .fill(0)
        .map((_, i) => Math.sin(hash + i) * 0.1);

      return embedding;
    } catch (error) {
      console.error("Embedding generation error:", error);
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  async testConnection() {
    try {
      const response = await this.generateResponse(
        [{ role: "user", content: "Hello, this is a test message." }],
        { maxTokens: 50 },
      );

      return {
        success: true,
        model: response.model,
        responseLength: response.content.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

export default new LLMProvider();
