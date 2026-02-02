import mongoose from 'mongoose';

const tenantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  domain: {
    type: String,
    trim: true
  },
  industry: {
    type: String,
    enum: ['ecommerce', 'saas', 'healthcare', 'education', 'finance', 'real-estate', 'other'],
    default: 'other'
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'starter', 'professional', 'enterprise'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'canceled', 'past_due'],
      default: 'active'
    },
    currentPeriodEnd: Date,
    stripeCustomerId: String,
    stripeSubscriptionId: String
  },
  limits: {
    conversations: { type: Number, default: 100 },
    apiCalls: { type: Number, default: 1000 },
    knowledgeItems: { type: Number, default: 50 },
    agents: { type: Number, default: 2 }
  },
  usage: {
    conversations: { type: Number, default: 0 },
    apiCalls: { type: Number, default: 0 },
    knowledgeItems: { type: Number, default: 0 },
    agents: { type: Number, default: 0 }
  },
  settings: {
    chatWidget: {
      primaryColor: { type: String, default: '#3B82F6' },
      position: { type: String, default: 'bottom-right' },
      welcomeMessage: { type: String, default: 'Hi! How can I help you today?' },
      placeholder: { type: String, default: 'Type your message...' },
      showBranding: { type: Boolean, default: true }
    },
    ai: {
      systemPrompt: {
        type: String,
        default: 'You are a helpful customer support assistant. Be friendly, professional, and helpful.'
      },
      temperature: { type: Number, default: 0.7 },
      maxTokens: { type: Number, default: 500 },
      model: { type: String, default: 'Meta-Llama-3.1-8B-Instruct' }
    },
    data: {
      // Optional external context webhook to fetch tenant-specific data (e.g., website DB)
      externalContextUrl: { type: String, default: '' },
      externalContextAuthHeader: { type: String, default: '' },
      externalContextEnabled: { type: Boolean, default: false },
      externalContextTimeoutMs: { type: Number, default: 2500 },
      // Optional specialized endpoints for common support actions (all industries)
      orderStatusUrl: { type: String, default: '' },
      billingUrl: { type: String, default: '' },
      accountLookupUrl: { type: String, default: '' },
      ticketCreateUrl: { type: String, default: '' },
    },
    handoff: {
      enabled: { type: Boolean, default: true },
      triggerKeywords: [{ type: String }],
      autoEscalate: { type: Boolean, default: false },
      escalationThreshold: { type: Number, default: 3 }
    }
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Generate slug from name before validation so 'required' passes
tenantSchema.pre('validate', function(next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
  next();
});

// Methods
tenantSchema.methods.canUseFeature = function(feature) {
  const usage = this.usage[feature] || 0;
  const limit = this.limits[feature] || 0;
  return usage < limit;
};

tenantSchema.methods.incrementUsage = function(feature, amount = 1) {
  if (this.usage[feature] !== undefined) {
    this.usage[feature] += amount;
  }
  return this.save();
};

// Indexes
// Avoid duplicating the unique index on slug defined above
tenantSchema.index({ 'subscription.status': 1 });

export default mongoose.model('Tenant', tenantSchema);
