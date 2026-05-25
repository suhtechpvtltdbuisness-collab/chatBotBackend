import express from 'express';
import { verifyWebhookSignature } from '../services/razorpay.js';

const router = express.Router();

// Generic webhook endpoint for integrations
router.post('/generic', async (req, res) => {
  try {
    const { source, event, data } = req.body;

    console.log(`Webhook received from ${source}:`, event);

    // Handle different webhook sources
    switch (source) {
      case 'stripe':
        await handleStripeWebhook(event, data);
        break;
      case 'razorpay':
        await handleRazorpayWebhook(req, res);
        return;
      case 'zapier':
        await handleZapierWebhook(event, data);
        break;
      case 'slack':
        await handleSlackWebhook(event, data);
        break;
      default:
        console.log('Unknown webhook source:', source);
    }

    res.json({ received: true, timestamp: new Date() });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

// Stripe webhook handler
async function handleStripeWebhook(event, data) {
  switch (event) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await updateSubscription(data);
      break;
    case 'customer.subscription.deleted':
      await cancelSubscription(data);
      break;
    case 'invoice.payment_succeeded':
      await handlePaymentSuccess(data);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailure(data);
      break;
  }
}

async function updateSubscription(data) {
  try {
    const Tenant = (await import('../models/Tenant.js')).default;
    
    const tenant = await Tenant.findOne({ 
      'subscription.stripeCustomerId': data.customer 
    });

    if (tenant) {
      tenant.subscription.status = data.status;
      tenant.subscription.currentPeriodEnd = new Date(data.current_period_end * 1000);
      tenant.subscription.stripeSubscriptionId = data.id;
      
      // Update limits based on plan
      const planLimits = getPlanLimits(data.items.data[0].price.nickname);
      if (planLimits) {
        tenant.limits = planLimits;
      }
      
      await tenant.save();
    }
  } catch (error) {
    console.error('Update subscription error:', error);
  }
}

async function cancelSubscription(data) {
  try {
    const Tenant = (await import('../models/Tenant.js')).default;
    
    const tenant = await Tenant.findOne({ 
      'subscription.stripeSubscriptionId': data.id 
    });

    if (tenant) {
      tenant.subscription.status = 'canceled';
      await tenant.save();
    }
  } catch (error) {
    console.error('Cancel subscription error:', error);
  }
}

async function handlePaymentSuccess(data) {
  console.log('Payment succeeded for customer:', data.customer);
}

async function handlePaymentFailure(data) {
  console.log('Payment failed for customer:', data.customer);
}

function getPlanLimits(planName) {
  const plans = {
    'starter': {
      conversations: 1000,
      apiCalls: 10000,
      knowledgeItems: 200,
      agents: 5
    },
    'professional': {
      conversations: 5000,
      apiCalls: 50000,
      knowledgeItems: 1000,
      agents: 15
    },
    'enterprise': {
      conversations: 25000,
      apiCalls: 250000,
      knowledgeItems: 5000,
      agents: 50
    }
  };

  return plans[planName?.toLowerCase()] || null;
}

// Zapier webhook handler
async function handleZapierWebhook(event, data) {
  console.log('Zapier webhook:', event, data);
  // Implement Zapier integration logic
}

// Slack webhook handler
async function handleSlackWebhook(event, data) {
  console.log('Slack webhook:', event, data);
  // Implement Slack integration logic
}

// Razorpay webhook handler
async function handleRazorpayWebhook(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      console.warn('❌ Missing x-razorpay-signature header');
      return res.status(400).json({ error: 'Missing webhook signature' });
    }

    // Stringify body to match raw payload if parsed
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.warn('❌ Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const { event, payload } = req.body;
    console.log(`Razorpay webhook event received: ${event}`);

    const Tenant = (await import('../models/Tenant.js')).default;

    switch (event) {
      case 'order.paid': {
        const orderData = payload.order.entity;
        // Locate tenant by Razorpay Order ID
        const tenant = await Tenant.findOne({ 'subscription.razorpayOrderId': orderData.id });
        if (tenant && tenant.subscription.status !== 'active') {
          tenant.subscription.plan = tenant.subscription.plan || 'starter';
          tenant.subscription.status = 'active';

          // Apply active limits based on plan
          const plans = {
            starter: { conversations: 1000, apiCalls: 10000, knowledgeItems: 200, agents: 5 },
            professional: { conversations: 5000, apiCalls: 50000, knowledgeItems: 1000, agents: 15 },
            enterprise: { conversations: 25000, apiCalls: 250000, knowledgeItems: 5000, agents: 50 }
          };

          const planName = tenant.subscription.plan || 'starter';
          const limits = plans[planName.toLowerCase()];
          if (limits) {
            tenant.limits = limits;
          }

          await tenant.save();
          console.log(`✅ Subscription activated via Razorpay webhook order.paid for Tenant ID: ${tenant._id}`);
        }
        break;
      }
      case 'payment.failed': {
        const paymentData = payload.payment.entity;
        console.error(`❌ Razorpay payment failed for Order ID: ${paymentData.order_id}`);
        break;
      }
      default:
        console.log(`Unhandled Razorpay event: ${event}`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Razorpay webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

export default router;