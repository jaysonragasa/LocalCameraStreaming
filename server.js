/**
 * AuraCam - Web-Based Camera & Audio Streaming Server
 * Ultra-lightweight signaling & static file server for browser-to-browser WebRTC streaming.
 * Supports both HTTP (port 8080) and HTTPS (port 8443) with auto-generated SSL.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const selfsigned = require('selfsigned');

const HTTP_PORT = process.env.PORT || 8080;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const app = express();

// =========================================================================
// SSL Certificate Helper
// =========================================================================

async function getOrCreateSslOptions() {
  try {
    const certDir = path.join(__dirname, '.cert');
    const certPath = path.join(certDir, 'cert.pem');
    const keyPath = path.join(certDir, 'key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
    }

    fs.mkdirSync(certDir, { recursive: true });
    const pems = await selfsigned.generate([
      { name: 'commonName', value: 'localhost' },
      { name: 'organizationName', value: 'AuraCam Local Stream' }
    ], { days: 365 });

    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(keyPath, pems.private);
    return { key: pems.private, cert: pems.cert };
  } catch (err) {
    console.warn('[SSL] Could not initialize SSL certificate:', err.message);
    return null;
  }
}

// =========================================================================
// Network Utilities
// =========================================================================

function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ interface: name, address: iface.address });
      }
    }
  }

  // Prioritize Wi-Fi, WLAN, en0 (Mac), eth0 first; virtual switches last
  addresses.sort((a, b) => {
    const score = (str) => {
      const s = str.toLowerCase();
      if (s.includes('wi-fi') || s.includes('wlan') || s === 'en0') return 100;
      if (s.includes('ethernet') && !s.includes('vethernet') && !s.includes('virtual')) return 80;
      if (s.startsWith('en') || s.startsWith('eth')) return 70;
      if (s.includes('vethernet') || s.includes('virtual') || s.includes('emulator') || s.includes('loopback')) return -10;
      return 10;
    };
    return score(b.interface) - score(a.interface);
  });

  return addresses;
}

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/static', express.static(path.join(__dirname, 'public')));

// State
let hostSocket = null;
const viewerSockets = new Map(); // id -> ws
let nextViewerId = 1;
let currentRoomPin = process.env.ROOM_PIN || '1234'; // Default 4-digit security PIN

// API endpoint for status
app.get('/api/info', (req, res) => {
  const networks = getLocalNetworkAddresses();
  const primaryIp = networks.length > 0 ? networks[0].address : '127.0.0.1';
  res.json({
    status: 'online',
    isHostConnected: hostSocket !== null && hostSocket.readyState === WebSocket.OPEN,
    viewersCount: viewerSockets.size,
    localIp: primaryIp,
    httpPort: HTTP_PORT,
    httpsPort: HTTPS_PORT,
    hasRoomPin: Boolean(currentRoomPin),
    accessUrlHttp: `http://${primaryIp}:${HTTP_PORT}`,
    accessUrlHttps: `https://${primaryIp}:${HTTPS_PORT}`,
    allNetworks: networks,
  });
});

// =========================================================================
// WebSocket Signaling Engine
// =========================================================================

function handleWebSocketConnection(ws) {
  let role = null; // 'host' or 'viewer'
  let currentViewerId = null;

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw);

      if (msg.type === 'register-host') {
        role = 'host';
        hostSocket = ws;
        if (msg.pin) {
          currentRoomPin = String(msg.pin).trim();
        }
        console.log(`[Signaling] Camera Host connected & registered. Active PIN: ${currentRoomPin || 'None'}`);
        
        ws.send(JSON.stringify({
          type: 'host-registered',
          pin: currentRoomPin
        }));

        broadcastToViewers({
          type: 'host-status',
          online: true,
          details: msg.details || {}
        });

        for (const [id, vWs] of viewerSockets.entries()) {
          if (vWs.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'viewer-joined', viewerId: id }));
          }
        }
      }

      else if (msg.type === 'set-room-pin') {
        currentRoomPin = String(msg.pin || '').trim();
        console.log(`[Security] Room PIN updated to: ${currentRoomPin || 'DISABLED'}`);
        ws.send(JSON.stringify({ type: 'room-pin-updated', pin: currentRoomPin }));
      }

      else if (msg.type === 'register-viewer') {
        // Enforce Room PIN validation
        if (currentRoomPin) {
          const providedPin = String(msg.pin || '').trim();
          if (providedPin !== currentRoomPin) {
            console.log(`[Security] Viewer PIN rejected. Got: "${providedPin}", Expected: "${currentRoomPin}"`);
            ws.send(JSON.stringify({
              type: 'auth-failed',
              reason: 'Incorrect Room PIN. Please enter the valid 4-digit PIN.'
            }));
            return;
          }
        }

        role = 'viewer';
        currentViewerId = `viewer-${nextViewerId++}`;
        viewerSockets.set(currentViewerId, ws);
        console.log(`[Signaling] Viewer authenticated: ${currentViewerId} (Total: ${viewerSockets.size})`);

        ws.send(JSON.stringify({
          type: 'registered',
          viewerId: currentViewerId,
          hostOnline: hostSocket !== null && hostSocket.readyState === WebSocket.OPEN
        }));

        if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
          hostSocket.send(JSON.stringify({
            type: 'viewer-joined',
            viewerId: currentViewerId
          }));
        }

        notifyHostViewerCount();
      }

      else if (msg.type === 'offer') {
        const targetViewer = viewerSockets.get(msg.viewerId);
        if (targetViewer && targetViewer.readyState === WebSocket.OPEN) {
          targetViewer.send(JSON.stringify({
            type: 'offer',
            sdp: msg.sdp,
            viewerId: msg.viewerId
          }));
        }
      }

      else if (msg.type === 'answer') {
        if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
          hostSocket.send(JSON.stringify({
            type: 'answer',
            sdp: msg.sdp,
            viewerId: currentViewerId
          }));
        }
      }

      else if (msg.type === 'candidate') {
        if (role === 'host') {
          const targetViewer = viewerSockets.get(msg.viewerId);
          if (targetViewer && targetViewer.readyState === WebSocket.OPEN) {
            targetViewer.send(JSON.stringify({
              type: 'candidate',
              candidate: msg.candidate
            }));
          }
        } else if (role === 'viewer') {
          if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
            hostSocket.send(JSON.stringify({
              type: 'candidate',
              candidate: msg.candidate,
              viewerId: currentViewerId
            }));
          }
        }
      }

      else if (msg.type === 'motion-alert') {
        broadcastToViewers({
          type: 'motion-alert',
          timestamp: Date.now(),
          score: msg.score
        });
      }

      else if (msg.type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          clientTime: msg.clientTime
        }));
      }

    } catch (err) {
      console.error('[Signaling] Message error:', err);
    }
  });

  ws.on('close', () => {
    if (role === 'host') {
      console.log('[Signaling] Camera Host disconnected');
      hostSocket = null;
      broadcastToViewers({ type: 'host-status', online: false });
    } else if (role === 'viewer' && currentViewerId) {
      console.log(`[Signaling] Viewer disconnected: ${currentViewerId}`);
      viewerSockets.delete(currentViewerId);
      if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
        hostSocket.send(JSON.stringify({
          type: 'viewer-left',
          viewerId: currentViewerId
        }));
        notifyHostViewerCount();
      }
    }
  });
}

function broadcastToViewers(payload) {
  const jsonStr = JSON.stringify(payload);
  for (const [, ws] of viewerSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(jsonStr);
    }
  }
}

function notifyHostViewerCount() {
  if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
    hostSocket.send(JSON.stringify({
      type: 'viewer-count',
      count: viewerSockets.size
    }));
  }
}

// =========================================================================
// Start Listening (HTTP and HTTPS)
// =========================================================================

async function startServer() {
  const sslOptions = await getOrCreateSslOptions();

  const httpServer = http.createServer(app);
  const wssHttp = new WebSocket.Server({ server: httpServer, path: '/ws' });
  wssHttp.on('connection', handleWebSocketConnection);

  let httpsServer = null;
  if (sslOptions) {
    try {
      httpsServer = https.createServer(sslOptions, app);
      const wssHttps = new WebSocket.Server({ server: httpsServer, path: '/ws' });
      wssHttps.on('connection', handleWebSocketConnection);
    } catch (e) {
      console.warn('[HTTPS] Could not start HTTPS server:', e.message);
    }
  }

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    const networks = getLocalNetworkAddresses();
    const primaryIp = networks.length > 0 ? networks[0].address : '127.0.0.1';

    console.log('====================================================================');
    console.log('          AURACAM - BROWSER CAMERA STREAMING SERVER                 ');
    console.log('====================================================================');
    console.log(`  * Local Access (on Mac/Laptop): http://localhost:${HTTP_PORT}`);
    console.log(`  * Network HTTP (Viewers):       http://${primaryIp}:${HTTP_PORT}`);
    if (httpsServer) {
      console.log(`  * Network HTTPS (Secure):       https://${primaryIp}:${HTTPS_PORT}`);
    }
    console.log('--------------------------------------------------------------------');
    console.log('  CAMERA ACCESS TIP:');
    console.log('  -> On the Mac hosting the camera: OPEN http://localhost:' + HTTP_PORT);
    console.log('  -> On phones/other devices watching: OPEN http://' + primaryIp + ':' + HTTP_PORT);
    console.log('====================================================================');
  });

  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[HTTPS] Secure server running on https://0.0.0.0:${HTTPS_PORT}`);
    });
  }
}

startServer();
