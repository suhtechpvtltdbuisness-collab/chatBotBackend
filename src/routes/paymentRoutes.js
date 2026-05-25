import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticateToken } from '../middleware/auth.js';
import { createRazorpayOrder, verifyPaymentSignature } from '../services/razorpay.js';
import Tenant from '../models/Tenant.js';
import { config } from '../config/env.js';

const router = express.Router();

const planPricing = {
  starter: 1999,      // ₹1,999 INR (199900 paise)
  professional: 4999, // ₹4,999 INR (499900 paise)
  enterprise: 15000   // ₹15,000 INR (1500000 paise)
};

const getPlanLimits = (planName) => {
  const plans = {
    starter: { conversations: 1000, apiCalls: 10000, knowledgeItems: 200, agents: 5 },
    professional: { conversations: 5000, apiCalls: 50000, knowledgeItems: 1000, agents: 15 },
    enterprise: { conversations: 25000, apiCalls: 250000, knowledgeItems: 5000, agents: 50 }
  };
  return plans[planName.toLowerCase()] || null;
};

/**
 * Endpoint: POST /api/create-order
 * Description: Initiates checkout by creating a Razorpay Order based on a secure plan identifier
 * Input: { plan }
 */
router.post(
  '/create-order',
  [
    body('plan').isIn(['starter', 'professional', 'enterprise']).withMessage('Invalid plan selected')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', details: errors.array() });
      }

      const { plan } = req.body;

      // Secure lookup of price on the backend
      const price = planPricing[plan];
      if (!price) {
        return res.status(400).json({ error: 'Invalid plan price mapping.' });
      }

      // 1. Identify Tenant
      // In production, req.tenant is populated by authenticateToken.
      // For the checkout-test route, we look for a fallback tenant or seed database if empty.
      let tenant = req.tenant;
      if (!tenant) {
        // Fallback for development checkout-test page
        tenant = await Tenant.findOne() || new Tenant({ name: 'Development Demo Tenant', slug: 'demo-tenant' });
        if (tenant.isNew) await tenant.save();
      }

      const receiptId = `rcpt_${tenant._id.toString().slice(-6)}_${Date.now()}`;

      // 2. Call Razorpay API
      const order = await createRazorpayOrder(price, 'INR', receiptId);

      // 3. Save draft Order reference
      tenant.subscription = tenant.subscription || {};
      tenant.subscription.razorpayOrderId = order.id;
      tenant.subscription.plan = plan; // Draft plan
      await tenant.save();

      return res.status(201).json({
        order_id: order.id,
        amount: order.amount, // in paise
        currency: order.currency,
        plan: plan
      });

    } catch (error) {
      console.error('❌ Razorpay Plan Order Creation Error:', error);
      return res.status(500).json({
        error: 'Razorpay Order Error',
        message: 'Failed to create payment order with Razorpay.',
        details: error.message
      });
    }
  }
);

/**
 * Endpoint: POST /api/verify-payment
 * Description: Cryptographically verifies signature and updates Mongoose DB subscription/limits
 * Input: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
router.post(
  '/verify-payment',
  [
    body('razorpay_order_id').notEmpty().withMessage('razorpay_order_id is required'),
    body('razorpay_payment_id').notEmpty().withMessage('razorpay_payment_id is required'),
    body('razorpay_signature').notEmpty().withMessage('razorpay_signature is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Missing fields', details: errors.array() });
      }

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      // 1. Verify signatures locally using Webhook Secret
      const isValid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

      if (!isValid) {
        console.warn('❌ Razorpay signature validation failed (mismatch).');
        return res.status(400).json({
          status: 'failure',
          message: 'Payment verification failed. Signature mismatch.'
        });
      }

      // 2. Locate and Upgrade Tenant
      let tenant = req.tenant;
      if (!tenant) {
        tenant = await Tenant.findOne({ 'subscription.razorpayOrderId': razorpay_order_id });
      }

      if (!tenant) {
        console.warn(`❌ No tenant found matching Razorpay Order ID: ${razorpay_order_id}`);
        // Fallback for development checkout-test page
        tenant = await Tenant.findOne();
      }

      if (tenant) {
        const plan = tenant.subscription.plan || 'starter';
        tenant.subscription.status = 'active';
        
        // Calculate period end: 30 days from now
        const currentPeriodEnd = new Date();
        currentPeriodEnd.setDate(currentPeriodEnd.getDate() + 30);
        tenant.subscription.currentPeriodEnd = currentPeriodEnd;
        
        tenant.subscription.razorpaySubscriptionId = razorpay_payment_id;
        tenant.subscription.razorpayOrderId = razorpay_order_id;

        // Apply active plan limits
        const limits = getPlanLimits(plan);
        if (limits) {
          tenant.limits = limits;
        }

        await tenant.save();
        console.log(`✅ Subscription plan upgraded to [${plan}] and limits updated for Tenant: ${tenant.name}`);
      }

      return res.status(200).json({
        status: 'success',
        message: 'Payment verified successfully and database upgraded.'
      });

    } catch (error) {
      console.error('❌ Razorpay Plan Verification Error:', error);
      return res.status(500).json({
        error: 'Verification Error',
        message: 'Internal server error while verifying payment.'
      });
    }
  }
);

/**
 * Endpoint: GET /checkout-test
 * Description: Interactive web client styled checkout page configured to test starter/professional/enterprise plans
 */
router.get('/checkout-test', (req, res) => {
  const razorpayKeyId = config.razorpay.keyId || 'rzp_test_SskiM3RMLTpr4H';

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuhTech AI ChatBot Checkout</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0F172A 0%, #1E1B4B 50%, #311042 100%);
      --accent-color: #A855F7;
      --accent-glow: #c084fc;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.06);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg-gradient);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      color: #F8FAFC;
      overflow-x: hidden;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 480px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      text-align: center;
      position: relative;
    }

    .card::before {
      content: '';
      position: absolute;
      top: -2px; left: -2px; right: -2px; bottom: -2px;
      background: linear-gradient(135deg, #A855F7, #3B82F6);
      border-radius: 26px;
      z-index: -1;
      opacity: 0.15;
      pointer-events: none;
    }

    .logo-container {
      width: 72px;
      height: 72px;
      background: linear-gradient(135deg, var(--accent-color), #3B82F6);
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 0 30px rgba(168, 85, 247, 0.4);
    }

    .logo-svg {
      width: 36px;
      height: 36px;
      fill: #fff;
    }

    h1 {
      font-weight: 800;
      font-size: 28px;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #FFFFFF 60%, #E2E8F0 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p.subtitle {
      color: #94A3B8;
      font-size: 15px;
      margin-bottom: 32px;
    }

    /* Plan Selection Grid */
    .plans-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      margin-bottom: 32px;
    }

    .plan-option {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      text-align: left;
    }

    .plan-option:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .plan-option.selected {
      background: rgba(168, 85, 247, 0.1);
      border-color: var(--accent-color);
      box-shadow: 0 0 20px rgba(168, 85, 247, 0.15);
    }

    .plan-info {
      display: flex;
      flex-direction: column;
    }

    .plan-name {
      font-weight: 600;
      font-size: 16px;
      color: #FFF;
      text-transform: capitalize;
    }

    .plan-desc {
      font-size: 12px;
      color: #64748B;
      margin-top: 2px;
    }

    .plan-price {
      font-weight: 800;
      font-size: 18px;
      color: var(--accent-color);
    }

    .pay-btn {
      width: 100%;
      background: linear-gradient(135deg, var(--accent-color) 0%, #6366F1 100%);
      color: white;
      border: none;
      padding: 16px 28px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 14px;
      cursor: pointer;
      box-shadow: 0 10px 20px rgba(168, 85, 247, 0.3);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .pay-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 30px rgba(168, 85, 247, 0.5);
      background: linear-gradient(135deg, #b56bf9 0%, #4f46e5 100%);
    }

    .console-box {
      margin-top: 32px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 14px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      text-align: left;
      color: #a7f3d0;
      max-height: 150px;
      overflow-y: auto;
      display: none;
    }

    .console-header {
      font-weight: 600;
      color: #34d399;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
    }

    .log-line {
      margin-bottom: 4px;
      word-break: break-all;
    }

    .log-info {
      color: #93c5fd;
    }

    .log-error {
      color: #f87171;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo-container">
        <svg class="logo-svg" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7L15,11H13V17H11V11H9L12,7Z" />
        </svg>
      </div>
      <h1>Choose Plan</h1>
      <p class="subtitle">Select a plan to charge securely through Razorpay</p>
      
      <!-- Plans Selection Grid -->
      <div class="plans-grid">
        <div class="plan-option selected" data-plan="starter" data-price="₹1,999">
          <div class="plan-info">
            <span class="plan-name">Starter Plan</span>
            <span class="plan-desc">1,000 conversations, 5 agents</span>
          </div>
          <span class="plan-price">₹1,999</span>
        </div>

        <div class="plan-option" data-plan="professional" data-price="₹4,999">
          <div class="plan-info">
            <span class="plan-name">Professional Plan</span>
            <span class="plan-desc">5,000 conversations, 15 agents</span>
          </div>
          <span class="plan-price">₹4,999</span>
        </div>

        <div class="plan-option" data-plan="enterprise" data-price="₹15,000">
          <div class="plan-info">
            <span class="plan-name">Enterprise Plan</span>
            <span class="plan-desc">25,000 conversations, 50 agents</span>
          </div>
          <span class="plan-price">₹15,000</span>
        </div>
      </div>

      <button id="rzp-button" class="pay-btn">
        <span>Pay with Razorpay</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      </button>

      <div id="console" class="console-box">
        <div class="console-header">
          <span>Live Payment Logs</span>
          <span style="color:#64748B; cursor:pointer;" onclick="clearLogs()">clear</span>
        </div>
        <div id="log-lines"></div>
      </div>
    </div>
  </div>

  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    const consoleBox = document.getElementById('console');
    const logLines = document.getElementById('log-lines');
    let selectedPlan = 'starter';

    // Plan Selection Click Listener
    document.querySelectorAll('.plan-option').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.plan-option').forEach(p => p.classList.remove('selected'));
        item.classList.add('selected');
        selectedPlan = item.getAttribute('data-plan');
        log('Selected Plan changed to: ' + selectedPlan.toUpperCase(), 'info');
      });
    });

    function log(message, type = 'success') {
      consoleBox.style.display = 'block';
      const div = document.createElement('div');
      div.className = 'log-line ' + (type === 'error' ? 'log-error' : (type === 'info' ? 'log-info' : ''));
      div.innerText = '[' + new Date().toLocaleTimeString() + '] ' + message;
      logLines.appendChild(div);
      consoleBox.scrollTop = consoleBox.scrollHeight;
    }

    function clearLogs() {
      logLines.innerHTML = '';
      consoleBox.style.display = 'none';
    }

    document.getElementById('rzp-button').onclick = async function(e) {
      e.preventDefault();
      log('Creating checkout order for plan: ' + selectedPlan.toUpperCase() + '...', 'info');

      try {
        // Step 1: Request backend order creation passing plan identifier
        const createRes = await fetch('/api/create-order', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            plan: selectedPlan
          })
        });

        if (!createRes.ok) {
          const errData = await createRes.json();
          throw new Error(errData.message || 'Failed to create order on backend');
        }

        const orderData = await createRes.json();
        log('Order generated on backend! Order ID: ' + orderData.order_id, 'info');

        // Step 2: Open checkout SDK modal
        const options = {
          key: '${razorpayKeyId}',
          amount: orderData.amount,
          currency: orderData.currency,
          name: 'SuhTech AI',
          description: selectedPlan.toUpperCase() + ' Plan Upgrade',
          order_id: orderData.order_id,
          handler: async function(response) {
            log('Payment authorized by Customer! ID: ' + response.razorpay_payment_id, 'info');
            log('Verifying signatures with database update...', 'info');

            // Step 3: Verify and upgrade plan limits in Database
            try {
              const verifyRes = await fetch('/api/verify-payment', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature
                })
              });

              const verifyResult = await verifyRes.json();

              if (verifyRes.ok && verifyResult.status === 'success') {
                log('🎉 Verified & Mongoose Database limits upgraded successfully!', 'success');
                alert('🎉 Payment successful! Mongoose limits upgraded.');
              } else {
                log('❌ Verification failed: ' + (verifyResult.message || 'Signature mismatch'), 'error');
                alert('❌ Signature validation failed!');
              }
            } catch (err) {
              log('❌ Error verifying signature: ' + err.message, 'error');
            }
          },
          prefill: {
            name: 'John Doe',
            email: 'john.doe@suhtech.test',
            contact: '9999999999'
          },
          theme: {
            color: '#A855F7'
          },
          modal: {
            ondismiss: function() {
              log('⚠️ Modal closed. Payment cancelled.', 'error');
            }
          }
        };

        const rzp = new Razorpay(options);
        rzp.open();

      } catch (err) {
        log('Error: ' + err.message, 'error');
      }
    };
  </script>
</body>
</html>
  `);
});

export default router;
