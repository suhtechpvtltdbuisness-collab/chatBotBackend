import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const apiKeySchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  key: {
    type: String,
    required: true,
    unique: true
  },
  permissions: [{
    type: String,
    enum: ['chat:read', 'chat:write', 'kb:read', 'kb:write', 'analytics:read'],
    default: ['chat:read', 'chat:write']
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  lastUsed: {
    type: Date
  },
  usageCount: {
    type: Number,
    default: 0
  },
  rateLimit: {
    requests: { type: Number, default: 100 },
    window: { type: Number, default: 3600 } // 1 hour in seconds
  },
  allowedOrigins: [{
    type: String
  }],
  expiresAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Generate API key before validation so 'required' passes
apiKeySchema.pre('validate', function(next) {
  if (!this.key) {
    this.key = `sk_${this.tenantId}_${uuidv4().replace(/-/g, '')}`;
  }
  next();
});

// Methods
apiKeySchema.methods.hasPermission = function(permission) {
  return this.permissions.includes(permission);
};

apiKeySchema.methods.incrementUsage = function() {
  this.usageCount += 1;
  this.lastUsed = new Date();
  return this.save();
};

apiKeySchema.methods.isExpired = function() {
  return this.expiresAt && new Date() > this.expiresAt;
};

// Indexes
// Avoid duplicating the unique index on key defined above
apiKeySchema.index({ tenantId: 1 });
apiKeySchema.index({ tenantId: 1, isActive: 1 });

export default mongoose.model('ApiKey', apiKeySchema);
