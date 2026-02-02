import llmProvider from './llmProvider.js';

class EmbeddingService {
  constructor() {
    this.cache = new Map();
    this.maxCacheSize = 1000;
  }

  async generateEmbedding(text) {

    const cacheKey = this.hashText(text);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const embedding = await llmProvider.generateEmbedding(text);

      // Cache the result
      if (this.cache.size >= this.maxCacheSize) {
        // Remove oldest entry
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      this.cache.set(cacheKey, embedding);
      return embedding;
    } catch (error) {
      console.error('Embedding service error:', error);
      throw error;
    }
  }

  async findSimilarKnowledge(tenantId, query, limit = 5) {
    try {
      const KBItem = (await import('../models/KBItem.js')).default;

      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbedding(query);

      // Find similar knowledge items
      const similarItems = await KBItem.findSimilar(
        tenantId,
        queryEmbedding,
        limit,
        0.5 // Lower threshold for better results
      );

      return similarItems;
    } catch (error) {
      console.error('Knowledge search error:', error);
      return [];
    }
  }

  async updateKnowledgeEmbedding(kbItem) {
    try {
      const text = `${kbItem.question} ${kbItem.answer}`;
      const embedding = await this.generateEmbedding(text);

      kbItem.embedding = embedding;
      await kbItem.save();

      return embedding;
    } catch (error) {
      console.error('Knowledge embedding update error:', error);
      throw error;
    }
  }

  hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hitRate: this.hitCount / (this.hitCount + this.missCount) || 0
    };
  }
}

export default new EmbeddingService();
