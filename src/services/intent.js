// Lightweight intent detection for support scenarios

export function detectSupportIntent(message) {
  if (!message) return { type: 'unknown', entities: {} };
  const text = String(message).toLowerCase();

  // Order status / shipping
  if (/order|tracking|shipment|shipping|deliver|package/.test(text)) {
    const orderMatch = text.match(/order\s*(#|number)?\s*([a-z0-9-]{4,})/i);
    return { type: 'order_status', entities: { orderId: orderMatch?.[2] } };
  }

  // Billing / invoices / subscriptions
  if (/bill|invoice|refund|charge|subscription|plan|upgrade|downgrade|cancel/.test(text)) {
    return { type: 'billing', entities: {} };
  }

  // Account / login / password / profile
  if (/account|login|signin|password|username|profile|email change/.test(text)) {
    return { type: 'account', entities: {} };
  }

  // Technical support keywords
  if (/error|bug|issue|not\s*working|broken|crash|fail/.test(text)) {
    return { type: 'tech_support', entities: {} };
  }

  // Human handoff cues are already handled elsewhere
  return { type: 'unknown', entities: {} };
}


