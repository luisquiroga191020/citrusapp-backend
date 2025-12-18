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

    // For debugging, just pass through the original HTML.
    res.set('Content-Type', resp.headers['content-type'] || 'text/html');
    res.send(resp.data);
    
  } catch (err) {
    if (err.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Proxy axios error:', err.response.status, err.response.statusText);
      // Send the original error page and status back to the iframe
      res.status(err.response.status).send(err.response.data);
    } else if (err.request) {
      // The request was made but no response was received
      console.error('Proxy no response:', err.request);
      res.status(504).send('<h1>Error 504</h1><p>No response from upstream server.</p>');
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Proxy setup error:', err.message);
      res.status(500).send('<h1>Error 500</h1><p>Error setting up request to upstream server.</p>');
    }
  }
});

module.exports = router;
