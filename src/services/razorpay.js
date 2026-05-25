import Razorpay from 'razorpay';
import crypto from 'crypto';
import { config } from '../config/env.js';

// Initialize Razorpay Client
let razorpayInstance = null;

export const getRazorpayClient = () => {
  if (!razorpayInstance) {
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      console.warn('⚠️ Razorpay credentials are missing! Payments will operate in stub mode.');
      return null;
    }
    razorpayInstance = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return razorpayInstance;
};

/**
 * Creates a Razorpay Order for one-time checkout
 * @param {number} amount - Amount in INR (will be converted to Paise automatically)
 * @param {string} currency - Currency code (default: INR)
 * @param {string} receiptId - Unique local reference ID
 * @returns {Promise<Object>} Razorpay Order Object
 */
export const createRazorpayOrder = async (amount, currency = 'INR', receiptId) => {
  const client = getRazorpayClient();
  if (!client) {
    throw new Error('Razorpay client not initialized. Check your credentials.');
  }

  const options = {
    amount: Math.round(amount * 100), // Amount in lowest currency denomination (Paise for INR)
    currency,
    receipt: receiptId,
    payment_capture: 1 // Auto-capture payments
  };

  return await client.orders.create(options);
};

/**
 * Verifies Razorpay payment signature locally
 * @param {string} orderId - Razorpay Order ID
 * @param {string} paymentId - Razorpay Payment ID
 * @param {string} signature - Razorpay Signature sent from frontend
 * @returns {boolean} True if signature is valid, false otherwise
 */
export const verifyPaymentSignature = (orderId, paymentId, signature) => {
  const secret = config.razorpay.keySecret;
  if (!secret) return false;

  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return generatedSignature === signature;
};

/**
 * Verifies Razorpay Webhook signature
 * @param {string} rawBody - Raw text/string body of the request
 * @param {string} signature - Signature from 'x-razorpay-signature' header
 * @returns {boolean}
 */
export const verifyWebhookSignature = (rawBody, signature) => {
  const secret = config.razorpay.webhookSecret;
  if (!secret || !signature) return false;

  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return generatedSignature === signature;
};
