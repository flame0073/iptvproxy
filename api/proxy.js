// api/proxy.js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const app = express();

// Enhanced CORS settings for Shaka Player compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  
  // Handle OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Debug middleware
app.use((req, res, next) => {
  const debug = req.query.debug === 'true';
  if (debug) {
    console.log(`[DEBUG] Request: ${req.method} ${req.url}`);
    console.log(`[DEBUG] Query params:`, req.query);
    console.log(`[DEBUG] Headers:`, req.headers);
  }
  next();
});

// Proxy for m3u8 playlists with better Shaka compatibility
app.get('/api/hls', async (req, res) => {
  const url = req.query.url;
  const debug = req.query.debug === 'true';
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  try {
    // Fetch the m3u8 playlist with proper headers
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://iptvproxy-five.vercel.app',
        'Referer': 'https://iptvproxy-five.vercel.app/'
      },
      responseType: 'text'
    });
    
    let content = response.data;
    
    if (debug) {
      console.log(`[DEBUG] Playlist content type: ${response.headers['content-type']}`);
      console.log(`[DEBUG] Playlist size: ${content.length} bytes`);
      console.log(`[DEBUG] First 100 chars: ${content.substring(0, 100)}`);
    }
    
    // Set the proper content type for m3u8 files
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Copy important headers
    ['cache-control', 'expires', 'date', 'etag'].forEach(header => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });
    
    // Parse the baseUrl for relative URL resolution
    const parsedUrl = new URL(url);
    const baseUrl = parsedUrl.protocol + '//' + parsedUrl.host;
    const pathParts = parsedUrl.pathname.split('/');
    pathParts.pop(); // Remove the filename
    const basePath = pathParts.join('/');
    const basePathUrl = baseUrl + basePath;
    
    // Detect if this is a master playlist or a media playlist
    const isMasterPlaylist = content.includes('#EXT-X-STREAM-INF');
    
    if (isMasterPlaylist) {
      if (debug) console.log('[DEBUG] Processing master playlist');
      
      // Process each line to rewrite URLs
      let lines = content.split('\n');
      let processedLines = [];
      let isNextLineUrl = false;
      
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        // Process stream info lines
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          isNextLineUrl = true;
          processedLines.push(line);
        } 
        // Check if this is a URL line (after a #EXT-X-STREAM-INF line)
        else if (isNextLineUrl && line && !line.startsWith('#')) {
          isNextLineUrl = false;
          
          // Resolve the URL (handle both absolute and relative URLs)
          let fullUrl;
          if (line.startsWith('http')) {
            fullUrl = line;
          } else if (line.startsWith('/')) {
            fullUrl = baseUrl + line;
          } else {
            fullUrl = basePathUrl + '/' + line;
          }
          
          // Replace with our proxy URL
          processedLines.push(`/api/hls?url=${encodeURIComponent(fullUrl)}`);
          
          if (debug) console.log(`[DEBUG] Rewrote stream URL: ${line} -> ${fullUrl}`);
        } else {
          processedLines.push(line);
        }
      }
      
      content = processedLines.join('\n');
    } 
    // Process media playlist (contains segments)
    else if (content.includes('#EXTINF')) {
      if (debug) console.log('[DEBUG] Processing media playlist');
      
      // Process each line to rewrite segment URLs
      let lines = content.split('\n');
      let processedLines = [];
      
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        // Check if this is a segment URL (not starting with #)
        if (line && !line.startsWith('#') && 
            (line.includes('.ts') || line.includes('.aac') || line.includes('.m4s') || 
             line.includes('.mp4') || line.includes('.vtt'))) {
          
          // Resolve the URL (handle both absolute and relative URLs)
          let fullUrl;
          if (line.startsWith('http')) {
            fullUrl = line;
          } else if (line.startsWith('/')) {
            fullUrl = baseUrl + line;
          } else {
            fullUrl = basePathUrl + '/' + line;
          }
          
          // Replace with our proxy URL
          processedLines.push(`/api/segment?url=${encodeURIComponent(fullUrl)}`);
          
          if (debug) console.log(`[DEBUG] Rewrote segment URL: ${line} -> ${fullUrl}`);
        } 
        // Handle encryption key URLs
        else if (line.startsWith('#EXT-X-KEY') && line.includes('URI=')) {
          const keyPattern = /(URI=["'])([^"']+)(["'])/;
          const match = line.match(keyPattern);
          
          if (match) {
            const keyUrl = match[2];
            let fullKeyUrl;
            
            if (keyUrl.startsWith('http')) {
              fullKeyUrl = keyUrl;
            } else if (keyUrl.startsWith('/')) {
              fullKeyUrl = baseUrl + keyUrl;
            } else {
              fullKeyUrl = basePathUrl + '/' + keyUrl;
            }
            
            const replacedLine = line.replace(
              keyPattern, 
              `$1/api/segment?url=${encodeURIComponent(fullKeyUrl)}$3`
            );
            
            processedLines.push(replacedLine);
            
            if (debug) console.log(`[DEBUG] Rewrote key URL: ${keyUrl} -> ${fullKeyUrl}`);
          } else {
            processedLines.push(line);
          }
        } else {
          processedLines.push(line);
        }
      }
      
      content = processedLines.join('\n');
    }
    
    // Add a debug comment if requested
    if (debug) {
      content = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n# Proxied by iptvproxy-five.vercel.app\n${content}`;
    }
    
    res.send(content);
  } catch (error) {
    console.error('Error proxying m3u8:', error.message);
    if (debug) {
      console.error('[DEBUG] Full error:', error);
    }
    res.status(500).send(`Error proxying HLS content: ${error.message}`);
  }
});

// Improved proxy for segments with better header handling
app.get('/api/segment', async (req, res) => {
  const url = req.query.url;
  const debug = req.query.debug === 'true';
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  try {
    // Support range requests which are essential for Shaka Player
    const rangeHeader = req.headers.range;
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://iptvproxy-five.vercel.app',
      'Referer': 'https://iptvproxy-five.vercel.app/'
    };
    
    if (rangeHeader) {
      requestHeaders['Range'] = rangeHeader;
      if (debug) console.log(`[DEBUG] Forwarding range request: ${rangeHeader}`);
    }
    
    const response = await axios.get(url, {
      headers: requestHeaders,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: status => status < 400
    });
    
    // Set content type based on URL or response headers
    let contentType = response.headers['content-type'];
    if (!contentType) {
      if (url.includes('.ts')) contentType = 'video/MP2T';
      else if (url.includes('.m4s')) contentType = 'video/iso.segment';
      else if (url.includes('.mp4')) contentType = 'video/mp4';
      else if (url.includes('.aac')) contentType = 'audio/aac';
      else if (url.includes('.vtt')) contentType = 'text/vtt';
      else contentType = 'application/octet-stream';
    }
    
    res.setHeader('Content-Type', contentType);
    
    // Copy all relevant headers
    const headersToForward = [
      'content-length', 'content-range', 'accept-ranges', 
      'cache-control', 'expires', 'date', 'etag', 'last-modified'
    ];
    
    headersToForward.forEach(header => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });
    
    // Always set accept-ranges header for Shaka Player compatibility
    if (!response.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    
    // Forward the status code, especially for range requests
    res.status(response.status);
    
    // Send the data
    res.send(Buffer.from(response.data));
    
  } catch (error) {
    console.error('Error proxying segment:', error.message);
    if (debug) {
      console.error('[DEBUG] Full error:', error);
    }
    res.status(500).send(`Error proxying segment: ${error.message}`);
  }
});

// DRM License Proxy
app.post('/api/license', (req, res) => {
  const { key, url } = req.query;
  const debug = req.query.debug === 'true';
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  if (debug) {
    console.log(`[DEBUG] License request for URL: ${url}`);
    console.log(`[DEBUG] License key: ${key}`);
  }
  
  // Create a proxy for license requests
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    selfHandleResponse: true,
    onProxyReq: (proxyReq, req) => {
      // Add key to the request if provided
      if (key) {
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Authorization', `Bearer ${key}`);
      }
      
      // Copy the body data
      if (req.body) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    },
    onProxyRes: (proxyRes, req, res) => {
      // Copy all headers from the proxied response
      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });
      
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      // Pipe the response
      proxyRes.pipe(res);
    }
  });
  
  proxy(req, res);
});

// Original stream proxy for DASH content
app.get('/api/stream', (req, res) => {
  const url = req.query.url;
  const debug = req.query.debug === 'true';
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }
  
  // Create a proxy for DASH/MPD content
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    selfHandleResponse: true,
    onProxyReq: (proxyReq) => {
      // Add standard headers for better compatibility
      proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      proxyReq.setHeader('Accept', '*/*');
      proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9');
      proxyReq.setHeader('Origin', 'https://iptvproxy-five.vercel.app');
      proxyReq.setHeader('Referer', 'https://iptvproxy-five.vercel.app/');
      
      // Forward range headers which are critical for video streaming
      if (req.headers.range) {
        proxyReq.setHeader('Range', req.headers.range);
      }
    },
    onProxyRes: (proxyRes, req, res) => {
      // Copy all headers from the proxied response
      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });
      
      // Set proper content type for DASH manifests
      if (url.endsWith('.mpd')) {
        res.setHeader('Content-Type', 'application/dash+xml');
      }
      
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      
      // Log debug info if requested
      if (debug) {
        console.log(`[DEBUG] Stream response status: ${proxyRes.statusCode}`);
        console.log(`[DEBUG] Stream response headers:`, proxyRes.headers);
      }
      
      // Pipe the response
      proxyRes.pipe(res);
    }
  });
  
  proxy(req, res);
});

// Basic health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'IPTV proxy is running' });
});

// Export for Vercel serverless functions
module.exports = app;
