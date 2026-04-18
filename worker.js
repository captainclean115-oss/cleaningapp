/*
  Cloudflare Worker — D-ID relay for Claire.

  Deploy (one-time, ~5 min):
    1. Go to https://dash.cloudflare.com → Workers & Pages → Create → "Hello World" Worker
    2. Name it something like "claire-did" (URL becomes claire-did.<your-subdomain>.workers.dev)
    3. Click "Edit code" and paste the entire contents of this file, replacing the starter
    4. Click "Deploy"
    5. Back on the Worker's overview page: Settings → Variables and Secrets
         - Add secret:  DID_KEY  =  <your D-ID API key, the full base64:password string D-ID gave you>
         - Add variable: ALLOWED_ORIGIN = https://captainclean115-oss.github.io
    6. Copy the Worker URL (e.g. https://claire-did.yourname.workers.dev) and paste it into
       Claire's "D-ID Proxy URL" field in the app.

  Security:
    - D-ID key stays on Cloudflare, never ships to the browser.
    - CORS is restricted to ALLOWED_ORIGIN so random sites can't burn your D-ID credits.
    - If you want stricter protection, add a SHARED_SECRET var and have the app send it
      as an `X-Claire-Auth` header.
*/

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';
    const allowOrigin = (allowed === '*' || origin === allowed) ? (origin || '*') : allowed;

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (allowed !== '*' && origin && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403, headers: corsHeaders });
    }

    if (!env.DID_KEY) {
      return new Response(JSON.stringify({ error: 'Worker missing DID_KEY secret' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    // Only allow /talks and /talks/:id to keep the surface tight.
    if (!/^\/talks(\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    const didUrl = 'https://api.d-id.com' + url.pathname + url.search;
    const init = {
      method: req.method,
      headers: {
        'Authorization': 'Basic ' + env.DID_KEY,
        'Accept': 'application/json',
      },
    };
    if (req.method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.body = await req.text();
    }

    let resp;
    try {
      resp = await fetch(didUrl, init);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + e.message }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        ...corsHeaders,
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      },
    });
  },
};
