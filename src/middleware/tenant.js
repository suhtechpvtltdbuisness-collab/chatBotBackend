import ApiKey from '../models/ApiKey.js';

export const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');

    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    const keyDoc = await ApiKey.findOne({
      key: apiKey,
      isActive: true
    }).populate('tenantId');

    if (!keyDoc) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (keyDoc.isExpired()) {
      return res.status(401).json({ error: 'API key expired' });
    }

    if (!keyDoc.tenantId || !keyDoc.tenantId.isActive) {
      return res.status(401).json({ error: 'Tenant not found or inactive' });
    }

    // Check rate limiting
    const now = new Date();
    const windowStart = new Date(now.getTime() - (keyDoc.rateLimit.window * 1000));

    // Simple in-memory rate limiting (use Redis in production)
    if (!req.app.locals.rateLimitStore) {
      req.app.locals.rateLimitStore = new Map();
    }

    const store = req.app.locals.rateLimitStore;
    const keyRequests = store.get(apiKey) || [];
    const recentRequests = keyRequests.filter(time => time > windowStart);

    if (recentRequests.length >= keyDoc.rateLimit.requests) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: keyDoc.rateLimit.requests,
        window: keyDoc.rateLimit.window
      });
    }

    recentRequests.push(now);
    store.set(apiKey, recentRequests);

    // Update usage
    await keyDoc.incrementUsage();

    req.apiKey = keyDoc;
    req.tenant = keyDoc.tenantId;
    next();
  } catch (error) {
    console.error('API key authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

export const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.apiKey) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    if (!req.apiKey.hasPermission(permission)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: permission,
        current: req.apiKey.permissions
      });
    }

    next();
  };
};

export const checkUsageLimit = (feature) => {
  return async (req, res, next) => {
    try {
      if (!req.tenant) {
        return res.status(401).json({ error: 'Tenant context required' });
      }

      if (!req.tenant.canUseFeature(feature)) {
        return res.status(403).json({
          error: `${feature} limit exceeded`,
          current: req.tenant.usage[feature],
          limit: req.tenant.limits[feature]
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: 'Usage check failed' });
    }
  };
};

export const trackUsage = (feature) => {
  return async (req, res, next) => {
    const originalSend = res.json;

    res.json = function(data) {
      // Track usage after successful response
      if (res.statusCode >= 200 && res.statusCode < 300 && req.tenant) {
        req.tenant.incrementUsage(feature).catch(err => {
          console.error('Usage tracking error:', err);
        });
      }

      return originalSend.call(this, data);
    };

    next();
  };
};

export const requireActiveSubscription = () => {
  return (req, res, next) => {
    try {
      const tenant = req.tenant;
      if (!tenant) {
        return res.status(401).json({ error: 'Tenant context required' });
      }

      const status = tenant.subscription?.status || 'active';
      const currentPeriodEnd = tenant.subscription?.currentPeriodEnd;

      // Consider dev/no-DB mode as active
      if (!tenant._id) return next();

      if (status !== 'active') {
        return res.status(402).json({ error: 'Subscription inactive', status });
      }

      if (currentPeriodEnd && new Date(currentPeriodEnd) < new Date()) {
        return res.status(402).json({ error: 'Subscription expired' });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: 'Subscription check failed' });
    }
  };
};
