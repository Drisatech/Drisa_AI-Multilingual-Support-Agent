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
import firebaseConfig from './firebase-applet-config.json' assert { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let firestore: Firestore;
try {
  firestore = new Firestore({
    projectId: firebaseConfig.projectId,
    databaseId: firebaseConfig.firestoreDatabaseId
  });
} catch (e) {
  console.error("Firestore initialization failed:", e);
  firestore = null as any;
}

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT) || 3000;

const SYSTEM_INSTRUCTION = `You are Drisa, a professional Nigerian AI Sales & Support Agent for DrisaTech (https://drisatech.com.ng).

LANGUAGE & MULTILINGUAL RULES:
- You are fluent in English, Hausa, Igbo, Yoruba, and Nigerian Pidgin.
- CRITICAL: You MUST respond in the EXACT SAME language the user is speaking. If they speak Hausa, you respond in Hausa. If they speak Pidgin, you respond in Pidgin.
- If the user switches languages mid-conversation, you MUST switch with them immediately.
- Use the user's preferred language for the initial greeting.

TONE & VOICE:
- Speak with a warm, respectful, and rhythmic Nigerian professional tone.
- Use polite Nigerian English honorifics like "Sir" or "Ma" when appropriate.
- Your cadence should be engaging, helpful, and clear.
- When speaking Nigerian Pidgin, Hausa, Igbo, or Yoruba, be authentic, natural, and friendly.

CONVERSATION RULES:
1. Keep responses VERY CONCISE (1-2 sentences) to reduce latency and keep the flow natural.
2. If you need to look up information, tell the user: "Just a moment while I check that for you, Sir/Ma."
3. Use 'lookupCatalog' for product inquiries. If the catalog is empty, use your knowledge of DrisaTech (Solar, CCTV, Smart Home).
4. Use 'sendFollowUp' to capture contact details and send real messages. You MUST call this tool as soon as the user provides their email or WhatsApp number.
5. If a user says they didn't receive a message, use 'checkServiceStatus' to see if the system is configured correctly.
6. Always confirm contact information clearly before sending a follow-up.
7. IMPORTANT: If the user types their contact info in the text box, acknowledge it and call 'sendFollowUp'.
8. Use 'bookAppointment' to schedule meetings or site visits for the business owner. Always confirm the date and time with the user before booking.

Goal: Provide expert advice on DrisaTech products with a rhythmic Nigerian flair in the user's language of choice.`;

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
  });
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
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
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
  });

  // Twilio Stream Handler (Mu-law 8000Hz)
  twilioWss.on('connection', (ws: WebSocket) => {
    const clientIp = (ws as any).clientIp || 'unknown';
    console.log(`[Twilio] New stream connection from ${clientIp}`);
    setupGeminiProxy(
      ws, 
      'audio/pcm;rate=16000', 
      (data) => mulawToPcm16(data.media.payload), 
      (payload, streamSid) => JSON.stringify({ event: 'media', streamSid, media: { payload: pcmToMulaw(payload) } }),
      clientIp
    );
  });

  // Browser Stream Handler (PCM 16000Hz)
  browserWss.on('connection', (ws: WebSocket) => {
    const clientIp = (ws as any).clientIp || 'unknown';
    console.log(`[Browser] New stream connection from ${clientIp}`);
    setupGeminiProxy(ws, 'audio/pcm;rate=16000', (data) => data.audio, (payload) => JSON.stringify({ event: 'audio', audio: payload }), clientIp);
  });

  async function setupGeminiProxy(ws: WebSocket, mimeType: string, getPayload: (data: any) => string, createMessage: (payload: string, streamSid?: string) => string, clientIp: string) {
    let streamSid: string | null = null;
    let geminiSession: any = null;
    let isConnectingGemini = false;
    let preferredLanguage: string = 'English';
    let transcript: { role: string, text: string, timestamp: string }[] = [];
    let startTime = new Date().toISOString();
    let audioOutputBuffer = Buffer.alloc(0);
    
    const connectToGemini = async () => {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY;
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        console.error('[Gemini] API Key is missing or set to placeholder. Please check your environment variables.');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            event: 'error', 
            message: 'Gemini API Key is missing or invalid. Please configure GEMINI_API_KEY in the Secrets panel.' 
          }));
          ws.close();
        }
        return;
      }
      console.log(`[Gemini] Using API Key (first 4): ${apiKey.substring(0, 4)}...`);
      const ai = new GoogleGenAI({ apiKey });

      if (isConnectingGemini || geminiSession) return;
      isConnectingGemini = true;
      
      try {
        const modelName = "gemini-2.5-flash-native-audio-preview-09-2025";
        console.log(`[Gemini] Connecting to Live API with model ${modelName}...`);
        const sessionPromise = ai.live.connect({
          model: modelName,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
            },
            systemInstruction: `${SYSTEM_INSTRUCTION}\n\nIMPORTANT: The user has selected ${preferredLanguage} as their preferred language. You MUST start the conversation in ${preferredLanguage} and strictly follow the language switching rules if the user changes language.`,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{
              functionDeclarations: [
                {
                  name: "lookupCatalog",
                  description: "Search the product catalog for items matching the customer's request.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The search query (e.g., 'solar', 'generator', 'camera'). Leave empty to get all products."
                      }
                    }
                  }
                },
                {
                  name: "sendFollowUp",
                  description: "Send a follow-up message with product details to the customer via WhatsApp or Email.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      contactType: {
                        type: Type.STRING,
                        description: "Either 'whatsapp' or 'email'"
                      },
                      contactAddress: {
                        type: Type.STRING,
                        description: "The phone number or email address provided by the customer"
                      },
                      message: {
                        type: Type.STRING,
                        description: "The formatted message containing product details, links, and prices to send."
                      }
                    },
                    required: ["contactType", "contactAddress", "message"]
                  }
                },
                {
                  name: "checkServiceStatus",
                  description: "Check if the messaging services (WhatsApp/Email) are correctly configured with API keys.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "bookAppointment",
                  description: "Schedule a meeting or site visit for the business owner. Always confirm the date and time with the user before booking.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      summary: {
                        type: Type.STRING,
                        description: "The title of the appointment (e.g., 'Solar Installation Site Visit')."
                      },
                      description: {
                        type: Type.STRING,
                        description: "Additional details about the appointment, including customer name and contact info."
                      },
                      startTime: {
                        type: Type.STRING,
                        description: "The start time of the appointment in ISO 8601 format (e.g., '2026-03-15T10:00:00Z')."
                      },
                      endTime: {
                        type: Type.STRING,
                        description: "The end time of the appointment in ISO 8601 format (e.g., '2026-03-15T11:00:00Z')."
                      }
                    },
                    required: ["summary", "startTime", "endTime"]
                  }
                }
              ]
            }]
          },
          callbacks: {
            onopen: () => {
              console.log('[Gemini] Connected');
            },
            onmessage: async (message) => {
              // console.log('[Gemini] Message received:', JSON.stringify(message).substring(0, 200) + '...');
              
              if (message.serverContent?.interrupted) {
                console.log('[Gemini] Model interrupted');
                ws.send(JSON.stringify({ event: 'interrupted' }));
              }

              // Handle transcriptions and audio
              if (message.serverContent?.modelTurn) {
                for (const part of message.serverContent.modelTurn.parts) {
                  if (part.text) {
                    const text = part.text;
                    transcript.push({ role: 'AI', text, timestamp: new Date().toISOString() });
                    ws.send(JSON.stringify({ event: 'transcript', role: 'AI', text }));
                  }
                  if (part.inlineData && part.inlineData.mimeType.includes('audio')) {
                    const base64Audio = part.inlineData.data;
                    if (base64Audio && ws.readyState === WebSocket.OPEN) {
                      // console.log(`[Gemini] Sending audio chunk to ${streamSid ? 'Twilio' : 'Browser'}`);
                      ws.send(createMessage(base64Audio, streamSid || undefined));
                    }
                  }
                }
              }

              const userTurn = (message.serverContent as any)?.userTurn;
              if (userTurn) {
                const text = (userTurn.parts as any[]).find(p => p.text)?.text;
                if (text) {
                  transcript.push({ role: 'Customer', text, timestamp: new Date().toISOString() });
                  ws.send(JSON.stringify({ event: 'transcript', role: 'Customer', text }));
                }
              }

              if (message.toolCall?.functionCalls) {
                console.log(`[Gemini] Tool calls received:`, JSON.stringify(message.toolCall.functionCalls));
                const responses = await Promise.all(message.toolCall.functionCalls.map(async (call) => {
                  if (call.name === 'lookupCatalog') {
                    const query = (call.args as any)?.query || '';
                    let products: any[] = [];
                    
                    if (firestore) {
                      try {
                        const snapshot = await firestore.collection('products').get();
                        products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                        console.log(`[Catalog] Found ${products.length} products in database`);
                      } catch (e) {
                        console.error('[Firestore] Failed to fetch products:', e);
                      }
                    }

                    // Fallback catalog if database is empty
                    if (products.length === 0) {
                      console.log('[Catalog] Using fallback data');
                      products = [
                        { name: "Drisa Solar Kit 5KVA", description: "Complete solar solution for homes and offices. Includes panels, inverter, and batteries.", price: "₦1,250,000", category: "Solar" },
                        { name: "Drisa Smart CCTV 4-Cam", description: "High-definition security cameras with mobile app access and night vision.", price: "₦185,000", category: "Security" },
                        { name: "Drisa Smart Door Lock", description: "Biometric and remote access door lock for enhanced security.", price: "₦45,000", category: "Security" },
                        { name: "Drisa Solar Street Light", description: "All-in-one solar street light with motion sensor.", price: "₦35,000", category: "Solar" }
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
                    
                    return { id: call.id, name: call.name, response: { result: products, count: products.length } };
                  } else if (call.name === 'sendFollowUp') {
                    const args = call.args as any;
                    const contactType = args.contactType || args.contact_type;
                    const contactAddress = args.contactAddress || args.contact_address;
                    const msg = args.message || args.msg;
                    
                    console.log(`[Follow-up Tool] Called with: type=${contactType}, address=${contactAddress}`);
                    console.log(`[Follow-up Tool] Message length: ${msg?.length || 0}`);
                    
                    if (!contactType || !contactAddress || !msg) {
                      console.error('[Follow-up Tool] Missing arguments');
                      return { id: call.id, name: call.name, response: { error: "Missing required arguments: contactType, contactAddress, or message" } };
                    }

                    let whatsappResult = "Not attempted";
                    let emailResult = "Not attempted";
                    let realSendSuccess = false;

                    // Attempt to send real WhatsApp message if configured via Meta WhatsApp Business API
                    if (contactType === 'whatsapp') {
                      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
                      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

                      if (accessToken && phoneNumberId) {
                        try {
                          // Clean the phone number: remove non-digits
                          let to = contactAddress.trim().replace(/\D/g, '');
                          
                          // If it doesn't start with a country code (assuming Nigeria +234 as default if it's short)
                          if (to.length <= 11 && !to.startsWith('234')) {
                            to = '234' + (to.startsWith('0') ? to.substring(1) : to);
                          }

                          const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
                            method: 'POST',
                            headers: {
                              'Authorization': `Bearer ${accessToken}`,
                              'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                              messaging_product: "whatsapp",
                              recipient_type: "individual",
                              to: to,
                              type: "text",
                              text: {
                                preview_url: false,
                                body: msg
                              }
                            })
                          });

                          const data = await response.json() as any;
                          console.log(`[Meta WhatsApp] API Response Status: ${response.status}`);
                          
                          if (response.ok) {
                            console.log(`[Meta WhatsApp] Message sent successfully: ${data.messages?.[0]?.id}`);
                            whatsappResult = "SUCCESS: Real WhatsApp message sent via Meta API.";
                            realSendSuccess = true;
                          } else {
                            console.error('[Meta WhatsApp] API Error Details:', JSON.stringify(data));
                            const errorMsg = data.error?.message || response.statusText;
                            whatsappResult = `FAILED: Meta API error - ${errorMsg}. Note: Meta requires users to message the business first within 24 hours for free-form messages.`;
                          }
                        } catch (err) {
                          console.error('[Meta WhatsApp] Error sending WhatsApp:', err);
                          whatsappResult = "FAILED: Network or system error - " + (err instanceof Error ? err.message : String(err));
                        }
                      } else {
                        console.log('[Meta WhatsApp] Credentials missing.');
                        whatsappResult = "FAILED: Meta WhatsApp credentials (WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID) are missing in the server environment.";
                      }
                    }

                    // Attempt to send real Email if configured
                    if (contactType === 'email') {
                      const smtpUser = process.env.SMTP_USER;
                      const smtpPass = process.env.SMTP_PASS;
                      const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
                      const smtpPort = parseInt(process.env.SMTP_PORT || '465');

                      if (smtpUser && smtpPass) {
                        try {
                          const transporter = nodemailer.createTransport({
                            host: smtpHost,
                            port: smtpPort,
                            secure: smtpPort === 465,
                            auth: {
                              user: smtpUser,
                              pass: smtpPass,
                            },
                          });

                          const info = await transporter.sendMail({
                            from: `"${process.env.SMTP_FROM_NAME || 'Drisa AI Agent'}" <${smtpUser}>`,
                            to: contactAddress,
                            subject: "Follow-up from Drisa",
                            text: msg,
                            html: `<p>${msg.replace(/\n/g, '<br>')}</p>`,
                          });

                          console.log(`[Email] Message sent: ${info.messageId}`);
                          emailResult = "SUCCESS: Real Email sent successfully.";
                          realSendSuccess = true;
                        } catch (err) {
                          console.error('[Email] Error sending email:', err);
                          emailResult = "FAILED: SMTP error - " + (err instanceof Error ? err.message : String(err));
                        }
                      } else {
                        console.log('[Email] SMTP credentials missing.');
                        emailResult = "FAILED: Email credentials (SMTP_USER or SMTP_PASS) are missing in the server environment.";
                      }
                    }

                    if (firestore) {
                      try {
                        await firestore.collection('leads').add({
                          contactType,
                          phone: contactType === 'whatsapp' ? contactAddress : '',
                          email: contactType === 'email' ? contactAddress : '',
                          notes: msg,
                          createdAt: new Date().toISOString(),
                          status: 'new',
                          realSendSuccess
                        });
                        console.log(`[Firestore] Lead saved: ${contactAddress}`);
                      } catch (e) {
                        console.error('[Firestore] Failed to save lead:', e);
                      }
                    }
                    
                    const finalResult = contactType === 'whatsapp' ? whatsappResult : emailResult;
                    return { id: call.id, name: call.name, response: { result: finalResult } };
                  } else if (call.name === 'checkServiceStatus') {
                    const googleCalendarTokens = await getGoogleCalendarTokens();
                    const status = {
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
                    };
                    return { id: call.id, name: call.name, response: { result: status } };
                  } else if (call.name === 'bookAppointment') {
                    const { summary, description, startTime, endTime } = call.args as any;
                    console.log(`[Calendar Tool] Booking appointment: ${summary} at ${startTime}`);
                    
                    try {
                      const tokens = await getGoogleCalendarTokens();
                      if (!tokens) {
                        return { id: call.id, name: call.name, response: { error: "Google Calendar is not connected. Please ask the admin to connect it in the dashboard." } };
                      }
                      
                      const client = getOAuth2Client();
                      client.setCredentials(tokens);
                      const calendar = google.calendar({ version: 'v3', auth: client });
                      
                      const event = {
                        summary,
                        description,
                        start: { dateTime: startTime },
                        end: { dateTime: endTime },
                      };
                      
                      const response = await calendar.events.insert({
                        calendarId: 'primary',
                        requestBody: event,
                      });
                      
                      console.log(`[Calendar Tool] Event created: ${response.data.htmlLink}`);
                      return { id: call.id, name: call.name, response: { success: true, link: response.data.htmlLink } };
                    } catch (err) {
                      console.error('[Calendar Tool] Error booking appointment:', err);
                      return { id: call.id, name: call.name, response: { error: "Failed to book appointment: " + (err instanceof Error ? err.message : String(err)) } };
                    }
                  }
                  return { id: call.id, name: call.name, response: { error: "Unknown function" } };
                }));
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
              }
            },
            onerror: (err) => { 
              console.error('[Gemini] Error details:', JSON.stringify(err)); 
              console.error('[Gemini] Error message:', err.message);
              ws.send(JSON.stringify({ event: 'error', message: 'Gemini connection error' }));
              ws.close(); 
            },
            onclose: (event) => { 
              console.log('[Gemini] Closed. Event:', JSON.stringify(event)); 
              ws.close(); 
            }
          }
        });
        geminiSession = await sessionPromise;
        
        // Send initial greeting trigger
        if (geminiSession) {
          console.log(`[Gemini] Sending initial greeting trigger in ${preferredLanguage}`);
          const greetingPrompt = `Introduce yourself briefly in ${preferredLanguage} as the DrisaTech AI Support Agent and ask how you can help. Do not use any other language.`;
          geminiSession.sendRealtimeInput({ parts: [{ text: greetingPrompt }] });
        }
      } catch (err) {
        console.error('[Gemini] Connection failed:', err);
        ws.send(JSON.stringify({ event: 'error', message: 'Failed to connect to Gemini' }));
        ws.close();
      } finally {
        isConnectingGemini = false;
      }
    };

    ws.on('message', (message: any) => {
      try {
        const messageStr = message.toString();
        const data = JSON.parse(messageStr);
        console.log(`[WS] Received event: ${data.event}`);
        
        if (data.event === 'start') {
          streamSid = data.start?.streamSid || data.streamSid || null;
          console.log(`[Twilio] Stream started with SID: ${streamSid}`);
          
          const from = data.start?.customParameters?.from;
          preferredLanguage = data.preferredLanguage || 'English';
          connectToGemini();
        } else if (data.event === 'message') {
          const text = data.text;
          console.log(`[Browser] Received text message: ${text}`);
          if (text) {
            transcript.push({ role: 'Customer', text, timestamp: new Date().toISOString() });
            if (geminiSession) {
              geminiSession.sendRealtimeInput({ parts: [{ text }] });
            } else if (!isConnectingGemini) {
              connectToGemini().then(() => {
                if (geminiSession) geminiSession.sendRealtimeInput({ parts: [{ text }] });
              });
            }
          }
        } else if (data.event === 'media' || data.event === 'audio') {
          const payload = getPayload(data);
          if (data.streamSid && !streamSid) {
            streamSid = data.streamSid;
            console.log(`[Twilio] Captured streamSid from media: ${streamSid}`);
          }
          
          if (geminiSession && payload) {
            // console.log(`[Gemini] Sending audio chunk, size: ${payload.length}`);
            geminiSession.sendRealtimeInput({ media: { data: payload, mimeType } });
          } else if (!geminiSession && !isConnectingGemini && streamSid) {
            // This case handles if media arrives before 'start' event or if 'start' was missed
            console.log('[Twilio] Connecting to Gemini on first media packet');
            connectToGemini().then(() => {
              if (geminiSession && payload) geminiSession.sendRealtimeInput({ media: { data: payload, mimeType } });
            });
          } else if (!geminiSession && !isConnectingGemini && !streamSid && data.event === 'audio') {
            // For browser, we might not have a 'start' event, so connect on first audio
            console.log('[Browser] Connecting to Gemini on first audio packet');
            connectToGemini().then(() => {
              if (geminiSession) geminiSession.sendRealtimeInput({ media: { data: payload, mimeType } });
            });
          }
        } else if (data.event === 'stop') {
          console.log(`[Twilio] Stream stopped: ${streamSid}`);
          if (geminiSession) geminiSession.close();
        }
      } catch (e) {
        console.error('[WS] Message error:', e);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] WebSocket error:', err);
    });

    ws.on('close', async () => {
      console.log(`[WS] Connection closed: ${streamSid}`);
      if (geminiSession) geminiSession.close();
      
      // Log session to Firestore
      if (transcript.length > 0 && firestore) {
        try {
          const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY;
          if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') throw new Error('Gemini API Key is missing or invalid');
          
          const ai = new GoogleGenAI({ apiKey });
          const summaryResponse = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: `Summarize this conversation and determine the outcome (inquiry, support, sale, lead, other): ${JSON.stringify(transcript)}`,
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
            sessionId: streamSid || `browser-${clientIp}-${Date.now()}`,
            startTime,
            endTime: new Date().toISOString(),
            language: preferredLanguage,
            transcript,
            summary,
            outcome,
            clientIp,
            createdAt: new Date().toISOString()
          });
          console.log('[Firestore] Session logged');
        } catch (err) {
          console.error('[Firestore] Failed to log session:', err);
        }
      }
    });
  }
}

startServer();
