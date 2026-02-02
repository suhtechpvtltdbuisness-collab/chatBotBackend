class ExternalContextService {
  async fetchContextForMessage(tenant, { query, sessionId, visitor }) {
    try {
      const enabled = tenant?.settings?.data?.externalContextEnabled;
      const url = tenant?.settings?.data?.externalContextUrl;
      if (!enabled || !url) return null;

      const timeoutMs = tenant?.settings?.data?.externalContextTimeoutMs || 2500;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const headers = {
        'Content-Type': 'application/json',
      };
      const authHeader = tenant?.settings?.data?.externalContextAuthHeader;
      if (authHeader) {
        // Expected format: "Header-Name: value" or just a Bearer token string
        if (authHeader.includes(':')) {
          const [name, ...rest] = authHeader.split(':');
          headers[name.trim()] = rest.join(':').trim();
        } else {
          headers['Authorization'] = authHeader;
        }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          sessionId,
          visitor,
          tenantId: tenant?._id,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn('External context fetch failed:', res.status, text);
        return null;
      }

      const data = await res.json().catch(() => null);
      if (!data) return null;

      // Expected shape: { snippets: string[] } or { context: string }
      const snippets = Array.isArray(data?.snippets) ? data.snippets : [];
      const context = typeof data?.context === 'string' ? data.context : '';

      return { snippets, context, raw: data };
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.warn('External context request timed out');
        return null;
      }
      console.warn('External context error:', err.message);
      return null;
    }
  }
}

export default new ExternalContextService();


