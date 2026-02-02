import mongoose from 'mongoose';

const kbItemSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  question: {
    type: String,
    required: true,
    trim: true
  },
  answer: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    trim: true,
    default: 'general'
  },
  tags: [{
    type: String,
    trim: true
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  priority: {
    type: Number,
    default: 0,
    min: 0,
    max: 10
  },
  embedding: [{
    type: Number
  }],
  metadata: {
    source: String,
    lastUpdated: Date,
    version: { type: Number, default: 1 }
  },
  usage: {
    timesUsed: { type: Number, default: 0 },
    lastUsed: Date,
    avgRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 }
  }
}, {
  timestamps: true
});

// Methods
kbItemSchema.methods.updateUsage = function(rating = null) {
  this.usage.timesUsed += 1;
  this.usage.lastUsed = new Date();
  
  if (rating !== null && rating >= 1 && rating <= 5) {
    const totalRatings = this.usage.totalRatings;
    const currentAvg = this.usage.avgRating;
    
    this.usage.avgRating = ((currentAvg * totalRatings) + rating) / (totalRatings + 1);
    this.usage.totalRatings += 1;
  }
  
  return this.save();
};

kbItemSchema.methods.calculateSimilarity = function(queryEmbedding) {
  if (!this.embedding || !queryEmbedding) return 0;
  
  // Cosine similarity calculation
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < Math.min(this.embedding.length, queryEmbedding.length); i++) {
    dotProduct += this.embedding[i] * queryEmbedding[i];
    normA += this.embedding[i] * this.embedding[i];
    normB += queryEmbedding[i] * queryEmbedding[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Static methods
kbItemSchema.statics.findSimilar = function(tenantId, queryEmbedding, limit = 5, threshold = 0.7) {
  return this.find({ 
    tenantId, 
    isActive: true,
    embedding: { $exists: true, $ne: [] }
  })
  .then(items => {
    const scored = items.map(item => ({
      item,
      similarity: item.calculateSimilarity(queryEmbedding)
    }))
    .filter(scored => scored.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
    
    return scored;
  });
};

// Indexes
kbItemSchema.index({ tenantId: 1 });
kbItemSchema.index({ tenantId: 1, category: 1 });
kbItemSchema.index({ tenantId: 1, isActive: 1 });
kbItemSchema.index({ tenantId: 1, tags: 1 });

export default mongoose.model('KBItem', kbItemSchema);