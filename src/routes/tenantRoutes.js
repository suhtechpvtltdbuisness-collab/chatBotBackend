import express from 'express';
import { body, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { config } from '../config/env.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/tenant.js';
import User from '../models/User.js';

const router = express.Router();

// Get tenant settings
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const tenant = req.tenant;

    res.json({
      tenant: {
        id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        domain: tenant.domain,
        industry: tenant.industry,
        subscription: tenant.subscription,
        limits: tenant.limits,
        usage: tenant.usage,
        settings: tenant.settings
      }
    });

  } catch (error) {
    console.error('Get tenant settings error:', error);
    res.status(500).json({ error: 'Failed to get tenant settings' });
  }
});

// Update tenant settings
router.put('/settings', authenticateToken, requireRole(['owner', 'admin']), [
  body('name').optional().trim().isLength({ min: 1 }),
  body('domain').optional().isURL(),
  body('industry').optional().isIn(['ecommerce', 'saas', 'healthcare', 'education', 'finance', 'real-estate', 'other']),
  body('settings').optional().isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { name, domain, industry, settings } = req.body;
    const tenant = req.tenant;

    if (name) tenant.name = name;
    if (domain) tenant.domain = domain;
    if (industry) tenant.industry = industry;
    if (settings) {
      tenant.settings = {
        ...tenant.settings,
        ...settings
      };
    }

    await tenant.save();

    res.json({
      message: 'Tenant settings updated successfully',
      tenant: {
        id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        domain: tenant.domain,
        industry: tenant.industry,
        settings: tenant.settings
      }
    });

  } catch (error) {
    console.error('Update tenant settings error:', error);
    res.status(500).json({ error: 'Failed to update tenant settings' });
  }
});

// Get tenant analytics
router.get('/analytics', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const tenantId = req.tenant._id;

    const Conversation = (await import('../models/Conversation.js')).default;
    const Message = (await import('../models/Message.js')).default;
    const KBItem = (await import('../models/KBItem.js')).default;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Get conversation analytics
    const conversationStats = await Conversation.getAnalytics(tenantId, days);

    // Get message volume
    const messageStats = await Message.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          byRole: { $push: '$role' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get knowledge base usage
    const kbStats = await KBItem.aggregate([
      {
        $match: { tenantId: new mongoose.Types.ObjectId(tenantId) }
      },
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          avgUsage: { $avg: '$usage.timesUsed' },
          topCategories: { $push: '$category' }
        }
      }
    ]);

    res.json({
      period: `${days} days`,
      conversations: conversationStats[0] || {},
      messages: {
        daily: messageStats,
        total: messageStats.reduce((sum, day) => sum + day.count, 0)
      },
      knowledgeBase: kbStats[0] || {},
      usage: req.tenant.usage,
      limits: req.tenant.limits
    });

  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Get team members
router.get('/team', authenticateToken, async (req, res) => {
  try {
    const tenantId = req.tenant._id;

    const team = await User.find({ tenantId, isActive: true })
      .select('name email role lastLogin createdAt')
      .sort({ createdAt: -1 });

    res.json({
      team,
      count: team.length
    });

  } catch (error) {
    console.error('Get team error:', error);
    res.status(500).json({ error: 'Failed to get team members' });
  }
});

// Add team member
router.post('/team', authenticateToken, requireRole(['owner', 'admin']), [
  body('email').isEmail().normalizeEmail(),
  body('name').trim().isLength({ min: 1 }),
  body('role').isIn(['admin', 'agent']),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, name, role, password } = req.body;
    const tenantId = req.tenant._id;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Check agent limit
    if (role === 'agent' && !req.tenant.canUseFeature('agents')) {
      return res.status(403).json({
        error: 'Agent limit reached',
        current: req.tenant.usage.agents,
        limit: req.tenant.limits.agents
      });
    }

    // Create user
    const user = new User({
      email,
      name,
      role,
      password,
      tenantId
    });

    await user.save();

    // Update tenant usage
    if (role === 'agent') {
      await req.tenant.incrementUsage('agents');
    }

    res.status(201).json({
      message: 'Team member added successfully',
      user: user.toJSON()
    });

  } catch (error) {
    console.error('Add team member error:', error);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

export default router;

// Billing: create checkout session (Stripe)
router.post('/billing/create-checkout-session', authenticateToken, requireRole(['owner']), async (req, res) => {
  try {
    const { plan = 'starter', successUrl, cancelUrl } = req.body;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.json({ url: `${config.server.frontendUrl}/dashboard?checkout=stub&plan=${plan}` });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let customerId = req.tenant.subscription?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: req.tenant.name,
        metadata: { tenantId: String(req.tenant._id) }
      });
      customerId = customer.id;
      req.tenant.subscription = req.tenant.subscription || {};
      req.tenant.subscription.stripeCustomerId = customerId;
      await req.tenant.save();
    }

    const priceMap = {
      starter: process.env.STRIPE_PRICE_STARTER,
      professional: process.env.STRIPE_PRICE_PROFESSIONAL,
      enterprise: process.env.STRIPE_PRICE_ENTERPRISE
    };
    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: 'Invalid plan' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl || `${config.server.frontendUrl}/dashboard?checkout=success`,
      cancel_url: cancelUrl || `${config.server.frontendUrl}/dashboard?checkout=cancel`,
      metadata: { tenantId: String(req.tenant._id), plan }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Create checkout session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Billing: get subscription status
router.get('/billing/subscription', authenticateToken, requireRole(['owner', 'admin']), async (req, res) => {
  const sub = req.tenant.subscription || { plan: 'free', status: 'active' };
  res.json({ subscription: sub });
});

// Example protected route requiring active subscription
router.get('/protected/usage', authenticateToken, requireActiveSubscription(), async (req, res) => {
  res.json({ usage: req.tenant.usage, limits: req.tenant.limits });
});

router.post('/seed/premium-sample', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Not allowed in production' });
    }

    const Tenant = (await import('../models/Tenant.js')).default;
    const ApiKey = (await import('../models/ApiKey.js')).default;
    const KBItem = (await import('../models/KBItem.js')).default;

    // Reuse if already exists
    let tenant = await Tenant.findOne({ slug: 'acme-support' });
    if (!tenant) {
      tenant = new Tenant({
        name: 'Acme Support',
        slug: 'acme-support',
        industry: 'saas',
        subscription: { plan: 'enterprise', status: 'active' },
        limits: { conversations: 100000, apiCalls: 1000000, knowledgeItems: 10000, agents: 1000 },
        settings: {
          chatWidget: {
            primaryColor: '#10B981',
            position: 'bottom-right',
            welcomeMessage: 'Hi! I\'m your Acme AI assistant. How can I help?',
            placeholder: 'Type your message...',
            showBranding: true
          },
          ai: {
            systemPrompt: 'You are Acme Corp\'s support AI. Be concise, friendly, and helpful. Escalate to human agent when needed.',
            temperature: 0.4,
            maxTokens: 400,
            model: 'Meta-Llama-3.1-8B-Instruct'
          },
          handoff: {
            enabled: true,
            triggerKeywords: ['human', 'agent', 'person', 'representative', 'support', 'help'],
            autoEscalate: true,
            escalationThreshold: 2
          }
        }
      });
      await tenant.save();
    }

    // Create users
    let owner = await User.findOne({ email: 'owner@acme.test' });
    if (!owner) {
      owner = new User({
        email: 'owner@acme.test',
        name: 'Acme Owner',
        role: 'owner',
        password: 'Password123!',
        tenantId: tenant._id
      });
      await owner.save();
    }

    let admin = await User.findOne({ email: 'admin@acme.test' });
    if (!admin) {
      admin = new User({
        email: 'admin@acme.test',
        name: 'Acme Admin',
        role: 'admin',
        password: 'Password123!',
        tenantId: tenant._id
      });
      await admin.save();
    }

    let agent = await User.findOne({ email: 'agent@acme.test' });
    if (!agent) {
      agent = new User({
        email: 'agent@acme.test',
        name: 'Alex Agent',
        role: 'agent',
        password: 'Password123!',
        tenantId: tenant._id
      });
      await agent.save();
      await tenant.incrementUsage('agents');
    }

    // Create API key
    let apiKey = await ApiKey.findOne({ tenantId: tenant._id, name: 'Default Widget Key' });
    if (!apiKey) {
      apiKey = new ApiKey({
        tenantId: tenant._id,
        name: 'Default Widget Key',
        permissions: ['chat:read', 'chat:write', 'kb:read', 'analytics:read'],
        allowedOrigins: ['*']
      });
      await apiKey.save();
    }

    // Create KB items
    const kbCount = await KBItem.countDocuments({ tenantId: tenant._id });
    if (kbCount === 0) {
      const items = [
        {
          question: 'What is Acme SaaS pricing?',
          answer: 'We offer Starter ($19), Pro ($49), and Enterprise (custom).',
          category: 'pricing',
          tags: ['pricing', 'plans']
        },
        {
          question: 'How do I reset my password?',
          answer: 'Click “Forgot password” on the login page and follow the email link.',
          category: 'account',
          tags: ['account', 'password']
        },
        {
          question: 'How to contact human support?',
          answer: 'Ask for a human agent here or email support@acme.test for urgent issues.',
          category: 'support',
          tags: ['support', 'handoff']
        }
      ];

      await KBItem.insertMany(items.map(i => ({ ...i, tenantId: tenant._id })));
    }

    res.json({
      message: 'Premium sample tenant ready',
      tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug },
      users: [owner.toJSON(), admin.toJSON(), agent.toJSON()],
      apiKey: apiKey.key
    });
  } catch (error) {
    console.error('Seed premium sample error:', error);
    res.status(500).json({ error: 'Failed to seed premium tenant' });
  }
});
