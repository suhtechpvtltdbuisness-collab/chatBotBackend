import express from 'express';

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

export default router;