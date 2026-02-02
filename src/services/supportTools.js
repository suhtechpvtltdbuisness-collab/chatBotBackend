// Generic support tools executor. Uses tenant settings to route to webhooks or fallbacks.

import externalContextService from './externalContext.js';

async function callWebhook(url, payload, authHeader, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (authHeader) {
    if (authHeader.includes(':')) {
      const [name, ...rest] = authHeader.split(':');
      headers[name.trim()] = rest.join(':').trim();
    } else {
      headers['Authorization'] = authHeader;
    }
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

class SupportToolsService {
  async execute(intent, { tenant, message, sessionId, visitor }) {
    const cfg = tenant?.settings?.data || {};
    const basePayload = { tenantId: tenant?._id, query: message, sessionId, visitor };

    switch (intent?.type) {
      case 'order_status': {
        const url = cfg?.orderStatusUrl || cfg?.externalContextUrl; // fallback to general
        if (!url) return null;
        const data = await callWebhook(url, { action: 'order_status', ...basePayload }, cfg?.externalContextAuthHeader, cfg?.externalContextTimeoutMs);
        return this.normalize('order_status', data);
      }
      case 'billing': {
        const url = cfg?.billingUrl || cfg?.externalContextUrl;
        if (!url) return null;
        const data = await callWebhook(url, { action: 'billing', ...basePayload }, cfg?.externalContextAuthHeader, cfg?.externalContextTimeoutMs);
        return this.normalize('billing', data);
      }
      case 'account': {
        const url = cfg?.accountLookupUrl || cfg?.externalContextUrl;
        if (!url) return null;
        const data = await callWebhook(url, { action: 'account_lookup', ...basePayload }, cfg?.externalContextAuthHeader, cfg?.externalContextTimeoutMs);
        return this.normalize('account', data);
      }
      case 'tech_support': {
        const url = cfg?.ticketCreateUrl || cfg?.externalContextUrl;
        if (!url) return null;
        const data = await callWebhook(url, { action: 'triage', ...basePayload }, cfg?.externalContextAuthHeader, cfg?.externalContextTimeoutMs);
        return this.normalize('tech_support', data);
      }
      default: {
        // Generic external context
        const external = await externalContextService.fetchContextForMessage(tenant, { query: message, sessionId, visitor });
        if (!external) return null;
        return { type: 'context', context: external.context, snippets: external.snippets, raw: external.raw };
      }
    }
  }

  normalize(type, data) {
    if (!data) return null;
    // Attempt to map common response shapes
    if (type === 'order_status') {
      const order = data.order || data.result || data;
      const text = order?.summary || order?.statusText;
      const snippets = [];
      if (order?.number) snippets.push(`Order ${order.number}`);
      if (order?.status) snippets.push(`Status: ${order.status}`);
      if (order?.tracking) snippets.push(`Tracking: ${order.tracking}`);
      if (order?.eta) snippets.push(`ETA: ${order.eta}`);
      return { type, context: text || snippets.join('\n'), snippets, raw: data };
    }

    if (type === 'billing') {
      const invoice = data.invoice || data.subscription || data.result || data;
      const snippets = [];
      if (invoice?.status) snippets.push(`Billing status: ${invoice.status}`);
      if (invoice?.plan) snippets.push(`Plan: ${invoice.plan}`);
      if (invoice?.renewal) snippets.push(`Renews: ${invoice.renewal}`);
      return { type, context: snippets.join('\n'), snippets, raw: data };
    }

    if (type === 'account') {
      const acct = data.account || data.user || data.result || data;
      const snippets = [];
      if (acct?.email) snippets.push(`Email: ${acct.email}`);
      if (acct?.status) snippets.push(`Account status: ${acct.status}`);
      return { type, context: snippets.join('\n'), snippets, raw: data };
    }

    if (type === 'tech_support') {
      const ticket = data.ticket || data.result || data;
      const snippets = [];
      if (ticket?.id) snippets.push(`Ticket: ${ticket.id}`);
      if (ticket?.status) snippets.push(`Status: ${ticket.status}`);
      if (ticket?.priority) snippets.push(`Priority: ${ticket.priority}`);
      return { type, context: ticket?.summary || snippets.join('\n'), snippets, raw: data };
    }

    // Fallback
    return { type, context: data.context || '', snippets: data.snippets || [], raw: data };
  }
}

export default new SupportToolsService();


