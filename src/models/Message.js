import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  role: {
    type: String,
    enum: ['user', 'assistant', 'agent', 'system'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  metadata: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    messageType: {
      type: String,
      enum: ['text', 'image', 'file', 'system'],
      default: 'text'
    },
    confidence: Number,
    processingTime: Number,
    usedKnowledge: [{
      kbItemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'KBItem'
      },
      similarity: Number
    }],
    llmResponse: {
      model: String,
      tokens: Number,
      cost: Number
    }
  },
  isVisible: {
    type: Boolean,
    default: true
  },
  editedAt: Date,
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Methods
messageSchema.methods.edit = function(newContent, userId) {
  this.content = newContent;
  this.editedAt = new Date();
  this.editedBy = userId;
  return this.save();
};

messageSchema.methods.hide = function() {
  this.isVisible = false;
  return this.save();
};

// Static methods
messageSchema.statics.getConversationHistory = function(conversationId, limit = 50) {
  return this.find({ 
    conversationId, 
    isVisible: true 
  })
  .sort({ createdAt: 1 })
  .limit(limit)
  .populate('metadata.userId', 'name email')
  .populate('metadata.usedKnowledge.kbItemId', 'question category');
};

messageSchema.statics.getRecentByTenant = function(tenantId, limit = 100) {
  return this.find({ tenantId })
  .sort({ createdAt: -1 })
  .limit(limit)
  .populate('conversationId', 'sessionId visitor.name')
  .populate('metadata.userId', 'name');
};

// Indexes
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ tenantId: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, role: 1 });

export default mongoose.model('Message', messageSchema);