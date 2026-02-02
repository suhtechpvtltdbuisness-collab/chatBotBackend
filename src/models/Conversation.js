import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  visitorId: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'ended', 'transferred', 'escalated'],
    default: 'active'
  },
  channel: {
    type: String,
    enum: ['widget', 'api', 'webhook'],
    default: 'widget'
  },
  metadata: {
    userAgent: String,
    ipAddress: String,
    referrer: String,
    country: String,
    language: String,
    timezone: String
  },
  visitor: {
    name: String,
    email: String,
    phone: String,
    customFields: mongoose.Schema.Types.Mixed
  },
  assignedAgent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  handoffData: {
    requestedAt: Date,
    reason: String,
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium'
    },
    department: String,
    notes: String
  },
  satisfaction: {
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    feedback: String,
    submittedAt: Date
  },
  summary: {
    topic: String,
    resolution: String,
    tags: [String],
    duration: Number // in seconds
  },
  endedAt: Date
}, {
  timestamps: true
});

// Methods
conversationSchema.methods.end = function(summary = {}) {
  this.status = 'ended';
  this.endedAt = new Date();
  this.summary = {
    ...this.summary,
    ...summary,
    duration: Math.floor((this.endedAt - this.createdAt) / 1000)
  };
  return this.save();
};

conversationSchema.methods.assignToAgent = function(agentId, handoffData = {}) {
  this.assignedAgent = agentId;
  this.status = 'transferred';
  this.handoffData = {
    ...handoffData,
    requestedAt: new Date()
  };
  return this.save();
};

conversationSchema.methods.addSatisfactionRating = function(rating, feedback = '') {
  this.satisfaction = {
    rating,
    feedback,
    submittedAt: new Date()
  };
  return this.save();
};

// Static methods
conversationSchema.statics.getActiveByTenant = function(tenantId) {
  return this.find({
    tenantId,
    status: { $in: ['active', 'transferred'] }
  }).populate('assignedAgent', 'name email');
};

conversationSchema.statics.getAnalytics = function(tenantId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return this.aggregate([
    {
      $match: {
        tenantId: new mongoose.Types.ObjectId(tenantId),
        createdAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: null,
        totalConversations: { $sum: 1 },
        avgDuration: { $avg: '$summary.duration' },
        avgSatisfaction: { $avg: '$satisfaction.rating' },
        handoffRate: {
          $avg: { $cond: [{ $eq: ['$status', 'transferred'] }, 1, 0] }
        },
        statusBreakdown: {
          $push: '$status'
        }
      }
    }
  ]);
};

// Indexes
// Avoid duplicating the unique index on sessionId defined above
conversationSchema.index({ tenantId: 1 });
conversationSchema.index({ tenantId: 1, status: 1 });
conversationSchema.index({ tenantId: 1, createdAt: -1 });
conversationSchema.index({ assignedAgent: 1, status: 1 });

export default mongoose.model('Conversation', conversationSchema);
