const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const router = express.Router();

// Very small proxy to allow "in-app" navigation for a single trusted host.
// WARNING: Use carefully and only for trusted sites. We allow only citypopulation.de by default.
const ALLOWED_HOSTS = ['citypopulation.de', 'www.citypopulation.de'];

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url');

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return res.status(400).send('Invalid url');
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).send('Host not allowed');
  }

  try {
    const resp = await axios.get(parsed.href, {
      responseType: 'text',
      headers: {
        'User-Agent': req.get('User-Agent') || 'Comercial360-proxy',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    // --- START OF SIMPLIFICATION ---
    // For debugging, just pass through the original HTML.
    // This will confirm if the proxy fetch is working.
    // The navigation inside the iframe will be broken.
    res.set('Content-Type', resp.headers['content-type'] || 'text/html');
    res.send(resp.data);
    // --- END OF SIMPLIFICATION ---

    /* --- ORIGINAL CODE ---
    const html = resp.data;
    const $ = cheerio.load(html, { decodeEntities: false });

    // Rewrite all anchor tags so navigation goes through the proxy
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      // ignore mailto/tel/javascript
      if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
      try {
        const resolved = new URL(href, parsed.origin + parsed.pathname).href;
        $(el).attr('href', `/proxy?url=${encodeURIComponent(resolved)}`);
        $(el).removeAttr('target');
      } catch (e) {
        // skip invalid
      }
    });

    // Rewrite forms to submit through proxy
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      try {
        const resolved = action ? new URL(action, parsed.origin + parsed.pathname).href : parsed.href;
        $(el).attr('action', `/proxy?url=${encodeURIComponent(resolved)}`);
        $(el).removeAttr('target');
      } catch (e) {}
    });

    // Inject a small banner so users know they're viewing proxied content (optional)
    $('body').prepend(`\n<!-- Proxied by Comercial360 -->\n<div style="position:fixed;left:0;right:0;top:0;background:#111;color:#fff;padding:6px 10px;z-index:9999;font-size:12px;opacity:0.9">Viendo: ${parsed.hostname} — Navegación a través del proxy</div><div style="height:34px"></div>\n`);

    // Respond with rewritten HTML
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());
    */
  } catch (err) {
    console.error('Proxy fetch error', err.message);
    res.status(500).send('Error fetching remote page');
  }
});

module.exports = router;
