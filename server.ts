import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { db } from './db.js';
import { Firestore } from '@google-cloud/firestore';
import pkg from 'wavefile';
const { WaveFile } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase configuration safely
let firebaseConfig: any = {};
try {
  const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('[Server] Firebase config loaded successfully');
  } else {
    console.warn('[Server] WARNING: firebase-applet-config.json not found. Using empty config.');
  }
} catch (err) {
  console.error('[Server] ERROR loading firebase-applet-config.json:', err);
}

let firestore: Firestore;
try {
  const projectId = firebaseConfig.projectId || process.env.VITE_FIREBASE_PROJECT_ID;
  const databaseId = firebaseConfig.firestoreDatabaseId || process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID;
  
  if (projectId) {
    firestore = new Firestore({
      projectId: projectId,
      databaseId: databaseId
    });
    console.log(`[Server] Firestore initialized (Project: ${projectId}, DB: ${databaseId || '(default)'})`);
  } else {
    console.warn('[Server] WARNING: No Firestore project ID found in config or env. Firestore disabled.');
    firestore = null as any;
  }
} catch (e) {
  console.error("Firestore initialization failed:", e);
  firestore = null as any;
}

const app = express();
app.set('trust proxy', true);

// In AI Studio, we MUST listen on port 3000.
// In external Cloud Run, we MUST listen on the port provided by the PORT environment variable (usually 8080).
// We detect AI Studio by the presence of the APPLET_ID environment variable.
const PORT = (process.env.APPLET_ID) ? 3000 : (Number(process.env.PORT) || 8080);

console.log(`[Server] Starting up...`);
console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
console.log(`[Server] PORT: ${PORT} (Source: ${process.env.APPLET_ID ? 'AI Studio Override' : (process.env.PORT ? 'Env Var' : 'Default')})`);

async function getSystemInstruction() {
  let companyName = "DrisaTech";
  let agentName = "Drisa";
  let defaultLanguage = "English";
  let customInstructions = "";

  if (firestore) {
    try {
      const bizDoc = await firestore.collection('settings').doc('business').get();
      if (bizDoc.exists) {
        const data = bizDoc.data();
        companyName = data?.companyName || companyName;
        agentName = data?.agentName || agentName;
        defaultLanguage = data?.defaultLanguage || defaultLanguage;
        customInstructions = data?.customInstructions || "";
      }
    } catch (e) {
      console.error('[Firestore] Error fetching business settings:', e);
    }
  }

  return {
    instruction: `You are ${agentName}, a professional Nigerian AI Sales & Support Agent for ${companyName}.
${customInstructions ? `\nCORE BUSINESS CONTEXT:\n${customInstructions}\n` : ''}
LANGUAGE & MULTILINGUAL RULES:
- You are fluent in English, Hausa, Igbo, Yoruba, and Nigerian Pidgin.
- CRITICAL: You MUST respond in the EXACT SAME language the user is speaking.
- You have a native-level understanding of Nigerian accents and dialects.
- If the user switches languages mid-conversation, you MUST switch with them immediately.
- Your goal is high language accuracy and low latency. Keep responses VERY CONCISE (1-2 sentences).

TONE & VOICE:
- Speak with a warm, respectful, and rhythmic Nigerian professional tone.
- Use polite Nigerian English honorifics like "Sir" or "Ma" when appropriate.

CONVERSATION RULES:
1. Keep responses VERY CONCISE (1-2 sentences).
2. Use 'lookupCatalog' for product inquiries.
3. Use 'sendFollowUp' to capture contact details and send real messages.
4. Use 'checkServiceStatus' to see if the system is configured correctly.
5. Use 'bookAppointment' to schedule meetings or site visits.

Goal: Provide expert advice on ${companyName} products with a rhythmic Nigerian flair.`,
    defaultLanguage
  };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Google Calendar OAuth Setup ---
const getRedirectUri = (req?: any) => {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  
  // Use APP_URL if available
  let baseUrl = process.env.APP_URL;
  
  // If no APP_URL, try to derive from request headers (more reliable for proxies)
  if (!baseUrl && req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    baseUrl = `${protocol}://${host}`;
  }
  
  if (!baseUrl) return '';
  
  return `${baseUrl.replace(/\/$/, '')}/auth/google/callback`;
};

const getOAuth2Client = (req?: any) => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(req)
  );
};

async function getGoogleCalendarTokens() {
  if (!firestore) return null;
  const doc = await firestore.collection('settings').doc('google_calendar').get();
  return doc.exists ? doc.data() : null;
}

async function saveGoogleCalendarTokens(tokens: any) {
  if (!firestore) return;
  await firestore.collection('settings').doc('google_calendar').set({
    ...tokens,
    updatedAt: new Date().toISOString()
  });
}

// --- Helpers ---
function cleanJson(text: string): string {
  // Remove markdown code blocks if present
  return text.replace(/```json\n?|```/g, '').trim();
}

function mulawToPcm16(base64Payload: string): string {
  try {
    const buffer = Buffer.from(base64Payload, 'base64');
    const wav = new WaveFile();
    wav.fromScratch(1, 8000, '8m', buffer);
    // Decompress mu-law to 16-bit PCM first, then change sample rate
    wav.toBitDepth('16');
    wav.toSampleRate(16000);
    const samples = wav.getSamples(false, Int16Array);
    // console.log(`[Audio] mulawToPcm16 success, samples: ${samples.length}`);
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
  } catch (e) {
    console.error('[Audio] mulawToPcm16 failed:', e);
    return ''; // Return empty instead of raw mu-law to avoid confusing Gemini
  }
}

function pcmToMulaw(base64Payload: string): string {
  try {
    const buffer = Buffer.from(base64Payload, 'base64');
    if (buffer.length % 2 !== 0) {
      return pcmToMulaw(Buffer.from(buffer.slice(0, -1)).toString('base64'));
    }
    
    const samples16 = new Int16Array(buffer.length / 2);
    for (let i = 0; i < samples16.length; i++) {
      // 80% gain to prevent clipping while maintaining volume
      samples16[i] = Math.floor(buffer.readInt16LE(i * 2) * 0.8);
    }
    
    const wav = new WaveFile();
    wav.fromScratch(1, 24000, '16', samples16);
    wav.toSampleRate(8000);
    wav.toBitDepth('8m');
    const samples = wav.getSamples(false, Uint8Array);
    
    return Buffer.from(samples).toString('base64');
  } catch (e) {
    console.error('[Audio] pcmToMulaw failed:', e);
    return '';
  }
}

// Initialize Database
db.init();

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    env: process.env.NODE_ENV,
    firebase: !!process.env.VITE_FIREBASE_PROJECT_ID,
    gemini: !!(process.env.GEMINI_API_KEY || process.env.API_KEY)
  });
});

// Config Route for Frontend
app.get('/api/config', (req, res) => {
  res.json({
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    appId: process.env.VITE_FIREBASE_APP_ID,
    firestoreDatabaseId: process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY
  });
});

app.get('/api/system-instruction', async (req, res) => {
  const { instruction } = await getSystemInstruction();
  res.json({ instruction });
});

// KB Processing Route
app.post('/api/kb/process', async (req, res) => {
  const { type, content, id } = req.body;
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY;
  
  const isPlaceholder = apiKey === 'MY_GEMINI_API_KEY' || !apiKey;

  if (isPlaceholder) {
    console.error('[Gemini] API Key is missing or set to placeholder');
    return res.status(500).json({ 
      error: 'Gemini API Key is missing or invalid.',
      details: 'Please go to the "Secrets" or "Environment Variables" tab in the AI Studio settings and ensure GEMINI_API_KEY is set to a valid key.'
    });
  }

  if (!firestore) {
    console.error('[Firestore] Firestore not initialized');
    return res.status(500).json({ error: 'Database connection failed' });
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    console.log(`[KB] Processing ${type} for ID: ${id}`);
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Extract product information (name, description, price, category) from this ${type === 'url' ? 'website URL' : 'article'}: ${content}. 
      Return a JSON array of objects. 
      Prices should be strings (e.g. "₦150,000"). 
      If no products are found, return an empty array [].`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              price: { type: Type.STRING },
              category: { type: Type.STRING }
            },
            required: ["name", "description"]
          }
        }
      }
    });
    
    const cleanedJson = cleanJson(response.text);
    console.log(`[KB] Gemini response:`, cleanedJson);
    const products = JSON.parse(cleanedJson);
    
    if (Array.isArray(products) && products.length > 0) {
      const batch = firestore.batch();
      products.forEach((p: any) => {
        const docRef = firestore.collection('products').doc();
        batch.set(docRef, { 
          ...p, 
          sourceId: id,
          updatedAt: new Date().toISOString() 
        });
      });
      await batch.commit();
      console.log(`[KB] Successfully added ${products.length} products to catalog`);
    } else {
      console.log(`[KB] No products extracted from source`);
    }

    // Update source status
    if (id) {
      await firestore.collection('knowledge_sources').doc(id).update({ 
        status: 'processed',
        processedAt: new Date().toISOString(),
        productCount: products.length
      });
    }

    res.json({ success: true, count: products.length });
  } catch (err) {
    console.error('[KB] Processing error:', err);
    if (id && firestore) {
      try {
        await firestore.collection('knowledge_sources').doc(id).update({ 
          status: 'failed',
          error: err instanceof Error ? err.message : String(err)
        });
      } catch (e) {
        console.error('[KB] Failed to update error status:', e);
      }
    }
    res.status(500).json({ error: 'Failed to process knowledge source', details: err instanceof Error ? err.message : String(err) });
  }
});

// --- Tool Implementations ---
async function lookupCatalog(query?: string) {
  let products: any[] = [];
  if (firestore) {
    try {
      const snapshot = await firestore.collection('products').get();
      products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (e) {
      console.error('[Firestore] Failed to fetch products:', e);
    }
  }
  if (products.length === 0 && !firestore) {
    // Only show demo products if firestore is not even initialized
    products = [
      { name: "Demo Product 1", description: "This is a sample product.", price: "₦1,000", category: "Demo" }
    ];
  }
  if (query) {
    const lowerQuery = query.toLowerCase();
    products = products.filter(p => 
      (p.name && p.name.toLowerCase().includes(lowerQuery)) || 
      (p.description && p.description.toLowerCase().includes(lowerQuery)) ||
      (p.category && p.category.toLowerCase().includes(lowerQuery))
    );
  }
  return { result: products, count: products.length };
}

async function sendFollowUp(contactType: string, contactAddress: string, message: string) {
  let whatsappResult = "Not attempted";
  let emailResult = "Not attempted";
  let realSendSuccess = false;

  // Fetch settings from Firestore
  let waSettings: any = null;
  let emailSettings: any = null;
  
  if (firestore) {
    try {
      const waDoc = await firestore.collection('settings').doc('whatsapp').get();
      if (waDoc.exists) waSettings = waDoc.data();
      
      const emailDoc = await firestore.collection('settings').doc('email').get();
      if (emailDoc.exists) emailSettings = emailDoc.data();
    } catch (e) {
      console.error('[Firestore] Error fetching settings for follow-up:', e);
    }
  }

  if (contactType === 'whatsapp') {
    const accessToken = waSettings?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = waSettings?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (accessToken && phoneNumberId) {
      try {
        let to = contactAddress.trim().replace(/\D/g, '');
        if (to.length <= 11 && !to.startsWith('234')) {
          to = '234' + (to.startsWith('0') ? to.substring(1) : to);
        }
        const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            type: "text",
            text: { preview_url: false, body: message }
          })
        });
        if (response.ok) {
          whatsappResult = "SUCCESS: Real WhatsApp message sent.";
          realSendSuccess = true;
        } else {
          const data = await response.json() as any;
          whatsappResult = `FAILED: Meta API error - ${data.error?.message || response.statusText}`;
        }
      } catch (err) {
        whatsappResult = "FAILED: Network error - " + (err instanceof Error ? err.message : String(err));
      }
    } else {
      whatsappResult = "FAILED: Meta WhatsApp credentials missing.";
    }
  }

  if (contactType === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactAddress)) {
      return { result: "FAILED: Invalid email address format." };
    }
    const smtpUser = emailSettings?.user || process.env.SMTP_USER;
    const smtpPass = emailSettings?.pass || process.env.SMTP_PASS;
    const smtpHost = emailSettings?.host || process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = emailSettings?.port || process.env.SMTP_PORT || '465';
    
    if (smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(smtpPort),
          secure: true,
          auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({
          from: `"${process.env.SMTP_FROM_NAME || 'Drisa AI Agent'}" <${smtpUser}>`,
          to: contactAddress,
          subject: "Follow-up from Drisa",
          text: message,
          html: `<p>${message.replace(/\n/g, '<br>')}</p>`,
        });
        emailResult = "SUCCESS: Real Email sent.";
        realSendSuccess = true;
      } catch (err) {
        emailResult = "FAILED: SMTP error - " + (err instanceof Error ? err.message : String(err));
      }
    } else {
      emailResult = "FAILED: Email credentials missing.";
    }
  }

  if (firestore) {
    try {
      await firestore.collection('leads').add({
        contactType,
        phone: contactType === 'whatsapp' ? contactAddress : '',
        email: contactType === 'email' ? contactAddress : '',
        notes: message,
        createdAt: new Date().toISOString(),
        status: 'new',
        realSendSuccess
      });
    } catch (e) {
      console.error('[Firestore] Failed to save lead:', e);
    }
  }
  return { result: contactType === 'whatsapp' ? whatsappResult : emailResult };
}

async function checkServiceStatus() {
  const googleCalendarTokens = await getGoogleCalendarTokens();
  return {
    result: {
      whatsapp: {
        configured: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
        details: process.env.WHATSAPP_ACCESS_TOKEN ? "Token present" : "Token missing"
      },
      email: {
        configured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
        details: process.env.SMTP_USER ? `User: ${process.env.SMTP_USER}` : "Credentials missing"
      },
      googleCalendar: {
        configured: !!googleCalendarTokens,
        details: googleCalendarTokens ? "Connected" : "Not Connected"
      }
    }
  };
}

async function bookAppointment(summary: string, description: string, startTime: string, endTime: string) {
  try {
    const tokens = await getGoogleCalendarTokens();
    if (!tokens) return { error: "Google Calendar is not connected." };
    const client = getOAuth2Client();
    client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: { summary, description, start: { dateTime: startTime }, end: { dateTime: endTime } },
    });
    return { success: true, link: response.data.htmlLink };
  } catch (err) {
    return { error: "Failed to book appointment: " + (err instanceof Error ? err.message : String(err)) };
  }
}

// --- Tool API Routes ---
app.post('/api/tools/lookupCatalog', async (req, res) => {
  const result = await lookupCatalog(req.body.query);
  res.json(result);
});

app.post('/api/tools/sendFollowUp', async (req, res) => {
  const { contactType, contactAddress, message } = req.body;
  if (!contactType || !contactAddress || !message) {
    return res.status(400).json({ error: "Missing required arguments" });
  }
  const result = await sendFollowUp(contactType, contactAddress, message);
  res.json(result);
});

app.post('/api/tools/checkServiceStatus', async (req, res) => {
  const result = await checkServiceStatus();
  res.json(result);
});

app.post('/api/tools/bookAppointment', async (req, res) => {
  const { summary, description, startTime, endTime } = req.body;
  const result = await bookAppointment(summary, description, startTime, endTime);
  res.json(result);
});

app.post('/api/sessions/log', async (req, res) => {
  const { transcript, startTime, endTime, preferredLanguage } = req.body;
  if (firestore) {
    try {
      await firestore.collection('sessions').add({
        transcript,
        startTime,
        endTime,
        preferredLanguage,
        createdAt: new Date().toISOString()
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to log session' });
    }
  } else {
    res.status(500).json({ error: 'Database not initialized' });
  }
});

// Twilio Voice Webhook
app.post('/api/twilio/voice', (req, res) => {
  console.log(`[Twilio] Webhook received: ${req.method} ${req.url}`);
  console.log(`[Twilio] Body:`, JSON.stringify(req.body));
  
  try {
    const from = req.body.From || 'Unknown';
    console.log(`[Twilio] Incoming call from: ${from}`);
    
    // Robust host detection
    let host = req.get('host');
    if (process.env.APP_URL) {
      try {
        const appUrl = new URL(process.env.APP_URL);
        host = appUrl.host;
        console.log(`[Twilio] Using host from APP_URL: ${host}`);
      } catch (e) {
        console.warn(`[Twilio] Invalid APP_URL: ${process.env.APP_URL}. Using req.get('host').`);
      }
    }

    if (!host) {
      console.error('[Twilio] Could not determine host for WebSocket stream');
      return res.status(500).send('Could not determine host');
    }

    const streamUrl = `wss://${host}/api/twilio/stream`;
    console.log(`[Twilio] Generated Stream URL: ${streamUrl}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Welcome to DrisaTech AI Support. Please wait while we connect you.</Say>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="from" value="${from}" />
    </Stream>
  </Connect>
  <Pause length="2"/>
  <Say>I'm sorry, we are having trouble maintaining the connection. Please try calling back later.</Say>
</Response>`;

    console.log(`[Twilio] Sending TwiML response...`);
    res.type('text/xml');
    res.send(twiml.trim());
  } catch (err) {
    console.error('[Twilio] Webhook error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// --- Vite Middleware for Development ---
// --- Google Calendar OAuth Routes ---
app.get('/api/auth/google/status', async (req, res) => {
  try {
    const tokens = await getGoogleCalendarTokens();
    res.json({ connected: !!tokens });
  } catch (err) {
    res.json({ connected: false });
  }
});

app.get('/api/auth/google/url', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  const redirectUri = getRedirectUri(req);
  console.log(`[OAuth] Generating Auth URL with redirect_uri: ${redirectUri}`);

  if (!clientId || !clientSecret) {
    console.error('Google OAuth Configuration Error: Missing Client ID or Secret');
    return res.status(500).json({ 
      error: 'Google OAuth is not fully configured. Please ensure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.' 
    });
  }
  const client = getOAuth2Client(req);

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    prompt: 'consent select_account',
    redirect_uri: redirectUri
  });
  res.json({ url });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const redirectUri = getRedirectUri(req);
    console.log(`[OAuth] Callback received. Using redirect_uri: ${redirectUri}`);
    const client = getOAuth2Client(req);
    const { tokens } = await client.getToken({
      code: code as string,
      redirect_uri: redirectUri
    });
    await saveGoogleCalendarTokens(tokens);
    
    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f4f4f4;">
          <div style="background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center;">
            <h1 style="color: #10b981;">Connection Successful!</h1>
            <p>Google Calendar is now connected to Drisa AI.</p>
            <p>You can close this window now.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, '*');
                setTimeout(() => window.close(), 2000);
              }
            </script>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Google Auth] Error exchanging code:', err);
    res.status(500).send('Authentication failed');
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    const publicPath = path.resolve(process.cwd(), 'public');
    console.log(`[Server] Production mode.`);
    console.log(`[Server] distPath: ${distPath}`);
    console.log(`[Server] publicPath: ${publicPath}`);
    
    if (fs.existsSync(distPath)) {
      console.log(`[Server] dist folder exists.`);
    } else {
      console.error(`[Server] ERROR: dist folder NOT FOUND at ${distPath}`);
    }
    
    app.use(express.static(distPath));
    app.use('/public', express.static(publicPath));

    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Not Found: dist/index.html missing. Ensure build completed.');
      }
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // --- WebSocket Server for Twilio Streams ---
  const twilioWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    try {
      const host = request.headers.host || 'localhost';
      const url = new URL(request.url!, `http://${host}`);
      const pathname = url.pathname;
      const ip = (request.headers['x-forwarded-for'] as string || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
      
      console.log(`[Upgrade] Request for ${pathname} from ${ip}`);
      
      if (pathname.startsWith('/api/twilio/stream')) {
        console.log('[Upgrade] Handling Twilio stream upgrade');
        twilioWss.handleUpgrade(request, socket, head, (ws) => {
          (ws as any).clientIp = ip;
          twilioWss.emit('connection', ws, request);
        });
      } else if (pathname.startsWith('/api/browser/stream')) {
        console.log('[Upgrade] Handling Browser stream upgrade');
        browserWss.handleUpgrade(request, socket, head, (ws) => {
          (ws as any).clientIp = ip;
          browserWss.emit('connection', ws, request);
        });
      } else {
        console.log(`[Upgrade] Path ${pathname} not found, destroying socket`);
        socket.destroy();
      }
    } catch (err) {
      console.error('[Upgrade] Error during upgrade:', err);
      socket.destroy();
    }
  });  // Twilio Stream Handler (Mu-law 8000Hz)
  twilioWss.on('connection', (ws: WebSocket) => {
    console.log(`[Twilio] New stream connection`);
    let streamSid: string;
    let geminiSession: any;
    let transcript: {role: string, text: string}[] = [];
    const startTime = new Date().toISOString();
    let fromNumber = 'Unknown';

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      console.error('[Twilio] Gemini API Key is missing');
      ws.close();
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    ws.on('message', async (message: any) => {
      const data = JSON.parse(message.toString());
      if (data.event === 'start') {
        streamSid = data.streamSid;
        fromNumber = data.start?.customParameters?.from || 'Unknown';
        console.log(`[Twilio] Stream started: ${streamSid} from ${fromNumber}`);
        
        const { instruction, defaultLanguage } = await getSystemInstruction();
        
        geminiSession = await ai.live.connect({
          model: "gemini-2.5-flash-native-audio-preview-09-2025",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
            systemInstruction: instruction,
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            tools: [{
              functionDeclarations: [
                { name: "lookupCatalog", parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } } } },
                { name: "sendFollowUp", parameters: { type: Type.OBJECT, properties: { contactType: { type: Type.STRING }, contactAddress: { type: Type.STRING }, message: { type: Type.STRING } }, required: ["contactType", "contactAddress", "message"] } },
                { name: "checkServiceStatus", parameters: { type: Type.OBJECT, properties: {} } },
                { name: "bookAppointment", parameters: { type: Type.OBJECT, properties: { summary: { type: Type.STRING }, description: { type: Type.STRING }, startTime: { type: Type.STRING }, endTime: { type: Type.STRING } }, required: ["summary", "startTime", "endTime"] } }
              ]
            }]
          },
          callbacks: {
            onopen: () => {
              console.log('[Twilio] Gemini session opened');
              // Initial greeting for phone call
              geminiSession.sendRealtimeInput({
                parts: [{ text: `Introduce yourself briefly as the DrisaTech AI Support Agent and ask how you can help. Please greet the user in ${defaultLanguage}.` }]
              });
            },
            onmessage: async (msg) => {
              // Handle transcriptions
              if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                  if (part.text) {
                    transcript.push({ role: 'AI', text: part.text });
                  }
                  if (part.inlineData?.data) {
                    const mulaw = pcmToMulaw(part.inlineData.data);
                    if (mulaw) ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulaw } }));
                  }
                }
              }
              
              // Handle user transcriptions
              const userTurn = (msg.serverContent as any)?.userTurn;
              if (userTurn?.parts) {
                for (const part of userTurn.parts) {
                  if (part.text) {
                    transcript.push({ role: 'User', text: part.text });
                  }
                }
              }

              // Handle tool calls
              if (msg.toolCall?.functionCalls) {
                const responses = await Promise.all(msg.toolCall.functionCalls.map(async (call) => {
                  let result;
                  const args = call.args as any;
                  if (call.name === 'lookupCatalog') result = await lookupCatalog(args.query);
                  else if (call.name === 'sendFollowUp') result = await sendFollowUp(args.contactType, args.contactAddress, args.message);
                  else if (call.name === 'checkServiceStatus') result = await checkServiceStatus();
                  else if (call.name === 'bookAppointment') result = await bookAppointment(args.summary, args.description, args.startTime, args.endTime);
                  return { id: call.id, name: call.name, response: result };
                }));
                geminiSession.sendToolResponse({ functionResponses: responses });
              }
            }
          }
        });

        geminiSession.sendRealtimeInput({ parts: [{ text: "Introduce yourself briefly as the DrisaTech AI Support Agent and ask how you can help." }] });
      } else if (data.event === 'media' && geminiSession) {
        const pcm16 = mulawToPcm16(data.media.payload);
        if (pcm16) geminiSession.sendRealtimeInput({ media: { data: pcm16, mimeType: 'audio/pcm;rate=16000' } });
      }
    });

    ws.on('close', async () => {
      console.log(`[Twilio] Connection closed: ${streamSid}`);
      if (geminiSession) geminiSession.close();

      // Log session to Firestore
      if (transcript.length > 0 && firestore) {
        try {
          // Generate summary using Gemini
          const aiSummary = new GoogleGenAI({ apiKey });
          const summaryResponse = await aiSummary.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: `Summarize this phone conversation and determine the outcome (inquiry, support, sale, lead, other): ${JSON.stringify(transcript)}`,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  summary: { type: Type.STRING },
                  outcome: { type: Type.STRING, enum: ["inquiry", "support", "sale", "lead", "other"] }
                },
                required: ["summary", "outcome"]
              }
            }
          });

          const { summary, outcome } = JSON.parse(summaryResponse.text);

          await firestore.collection('conversations').add({
            sessionId: streamSid || `twilio-${Date.now()}`,
            startTime,
            endTime: new Date().toISOString(),
            language: 'Detected',
            transcript,
            summary,
            outcome,
            fromNumber,
            type: 'voice',
            createdAt: new Date().toISOString()
          });
          console.log('[Twilio] Session logged to Firestore');
        } catch (err) {
          console.error('[Twilio] Failed to log session:', err);
        }
      }
    });
  });

  // Browser Stream Handler (Redundant now as frontend uses SDK directly)
  browserWss.on('connection', (ws: WebSocket) => {
    console.log(`[Browser] New stream connection`);
    ws.on('message', (message: any) => {
      const data = JSON.parse(message.toString());
      if (data.event === 'start') {
        ws.send(JSON.stringify({ event: 'started' }));
      }
    });
  });
}

startServer();
