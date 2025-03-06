// api/proxy.js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const app = express();

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Proxy for m3u8 playlists
app.get('/api/hls', async (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  try {
    // Fetch the m3u8 playlist
    const response = await axios.get(url);
    let content = response.data;
    
    // Set the proper content type for m3u8 files
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    
    // If this is a master playlist, we need to modify the URLs inside it
    if (content.includes('#EXT-X-STREAM-INF')) {
      // Replace relative URLs with our proxy URLs
      const baseUrl = new URL(url);
      baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);
      
      // Replace all URLs with our proxy
      content = content.replace(/^(?!#)(.*\.m3u8.*)$/gm, (match) => {
        const streamUrl = match.trim();
        // Handle both absolute and relative URLs
        const fullUrl = streamUrl.startsWith('http') 
          ? streamUrl 
          : new URL(streamUrl, baseUrl.toString()).toString();
        return `/api/hls?url=${encodeURIComponent(fullUrl)}`;
      });
    }
    
    // If this is a media playlist, we need to modify the segment URLs
    if (content.includes('#EXTINF')) {
      // Replace relative URLs with our proxy URLs
      const baseUrl = new URL(url);
      baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);
      
      // Replace all segment URLs with our proxy
      content = content.replace(/^(?!#)(.*\.ts.*)$/gm, (match) => {
        const segmentUrl = match.trim();
        // Handle both absolute and relative URLs
        const fullUrl = segmentUrl.startsWith('http') 
          ? segmentUrl 
          : new URL(segmentUrl, baseUrl.toString()).toString();
        return `/api/segment?url=${encodeURIComponent(fullUrl)}`;
      });
    }
    
    res.send(content);
  } catch (error) {
    console.error('Error proxying m3u8:', error.message);
    res.status(500).send('Error proxying HLS content');
  }
});

// Proxy for ts segments
app.get('/api/segment', (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  // Create a proxy for segment files
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
      // Copy headers
      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });
      
      // Set content type for TS files
      res.setHeader('Content-Type', 'video/MP2T');
      
      // Pipe the response
      proxyRes.pipe(res);
    }
  });
  
  proxy(req, res);
});

// DRM License Proxy (if needed)
app.post('/api/license', (req, res) => {
  const { key, url } = req.query;
  
  if (!key || !url) {
    return res.status(400).send('Missing key or URL parameter');
  }
  
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    onProxyReq: (proxyReq, req) => {
      if (req.body) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    }
  });
  
  proxy(req, res);
});

// Original MPD proxy for DASH content (keeping for compatibility)
app.get('/api/stream', (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });
      
      if (url.endsWith('.mpd')) {
        res.setHeader('Content-Type', 'application/dash+xml');
      }
      
      proxyRes.pipe(res);
    }
  });
  
  proxy(req, res);
});

// Export for Vercel serverless functions
module.exports = app;