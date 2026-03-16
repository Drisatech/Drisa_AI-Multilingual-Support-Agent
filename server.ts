import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import twilio from 'twilio';
import { db } from './db.ts';
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
console.log(`[Server] Gemini API Key present: ${!!(process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY)}`);

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
2. Use 'lookupCatalog' for product inquiries. If the answer is not in the catalog, you MAY use Google Search to provide general helpful information, but always prioritize DrisaTech products.
3. Use 'sendFollowUp' to capture contact details and send real messages (WhatsApp, Email, SMS, or Voice Call).
4. Use 'checkServiceStatus' to see if the system is configured correctly (WhatsApp, Twilio, Email, Google Calendar).
5. Use 'bookAppointment' to schedule meetings or site visits.

IMMEDIATE GREETING RULE:
- As soon as the session starts, you MUST proactively greet the user warmly.
- Do not wait for the user to speak first.
- Introduce yourself as ${agentName} from ${companyName}.

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

function pcmToMulaw(base64Payload: string): string[] {
  try {
    const buffer = Buffer.from(base64Payload, 'base64');
    if (buffer.length % 2 !== 0) {
      return pcmToMulaw(Buffer.from(buffer.slice(0, -1)).toString('base64'));
    }
    
    const samples16 = new Int16Array(buffer.length / 2);
    for (let i = 0; i < samples16.length; i++) {
      // 70% gain to prevent clipping and reduce distortion
      samples16[i] = Math.floor(buffer.readInt16LE(i * 2) * 0.7);
    }
    
    const wav = new WaveFile();
    // Gemini Live API (09-2025) outputs 24kHz PCM.
    wav.fromScratch(1, 24000, '16', samples16);
    wav.toSampleRate(8000);
    wav.toBitDepth('8m');
    const samples = wav.getSamples(false, Uint8Array);
    
    // Chunk into 160-byte pieces (20ms each) for Twilio
    const chunks: string[] = [];
    const rawBuffer = Buffer.from(samples);
    for (let i = 0; i < rawBuffer.length; i += 160) {
      const chunk = rawBuffer.slice(i, i + 160);
      chunks.push(chunk.toString('base64'));
    }
    
    return chunks;
  } catch (e) {
    console.error('[Audio] pcmToMulaw failed:', e);
    return [];
  }
}

// Initialize Database
db.init();

app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is alive' });
});

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
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY,
    appUrl: process.env.APP_URL,
    sharedAppUrl: process.env.SHARED_APP_URL
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
  let phoneResult = "Not attempted";
  let realSendSuccess = false;

  // Fetch settings from Firestore
  let waSettings: any = null;
  let emailSettings: any = null;
  let twilioSettings: any = null;
  
  if (firestore) {
    try {
      const waDoc = await firestore.collection('settings').doc('whatsapp').get();
      if (waDoc.exists) waSettings = waDoc.data();
      
      const emailDoc = await firestore.collection('settings').doc('email').get();
      if (emailDoc.exists) emailSettings = emailDoc.data();

      const twilioDoc = await firestore.collection('settings').doc('twilio').get();
      if (twilioDoc.exists) twilioSettings = twilioDoc.data();
    } catch (e) {
      console.error('[Firestore] Error fetching settings for follow-up:', e);
    }
  }

  if (contactType === 'whatsapp') {
    // ... existing whatsapp logic ...
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

  if (contactType === 'sms') {
    const accountSid = twilioSettings?.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const authToken = twilioSettings?.authToken || process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = twilioSettings?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;

    if (accountSid && authToken && fromNumber) {
      try {
        const client = twilio(accountSid, authToken);
        let to = contactAddress.trim().replace(/\D/g, '');
        if (!to.startsWith('+')) {
          if (to.length <= 11 && !to.startsWith('234')) {
            to = '+234' + (to.startsWith('0') ? to.substring(1) : to);
          } else {
            to = '+' + to;
          }
        }
        await client.messages.create({
          body: message,
          from: fromNumber,
          to: to
        });
        return { result: "SUCCESS: Real SMS sent via Twilio." };
      } catch (err) {
        return { result: "FAILED: Twilio SMS error - " + (err instanceof Error ? err.message : String(err)) };
      }
    } else {
      return { result: "FAILED: Twilio credentials missing." };
    }
  }

  if (contactType === 'phone' || contactType === 'call') {
    const accountSid = twilioSettings?.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const authToken = twilioSettings?.authToken || process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = twilioSettings?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;

    if (accountSid && authToken && fromNumber) {
      try {
        const client = twilio(accountSid, authToken);
        let to = contactAddress.trim().replace(/\D/g, '');
        if (!to.startsWith('+')) {
          if (to.length <= 11 && !to.startsWith('234')) {
            to = '+234' + (to.startsWith('0') ? to.substring(1) : to);
          } else if (!to.startsWith('+')) {
            to = '+' + to;
          }
        }

        // For a follow-up call, we'll use a simple TwiML that says the message
        await client.calls.create({
          twiml: `<Response><Say>${message}</Say></Response>`,
          to: to,
          from: fromNumber
        });
        phoneResult = "SUCCESS: Outbound call initiated.";
        realSendSuccess = true;
      } catch (err) {
        phoneResult = "FAILED: Twilio error - " + (err instanceof Error ? err.message : String(err));
      }
    } else {
      phoneResult = "FAILED: Twilio credentials missing.";
    }
  }

  if (contactType === 'email') {
    // ... existing email logic ...
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
        phone: (contactType === 'whatsapp' || contactType === 'phone') ? contactAddress : '',
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
  
  if (contactType === 'whatsapp') return { result: whatsappResult };
  if (contactType === 'phone' || contactType === 'call') return { result: phoneResult };
  return { result: emailResult };
}

async function checkServiceStatus() {
  const googleCalendarTokens = await getGoogleCalendarTokens();
  
  let twilioSettings: any = null;
  if (firestore) {
    try {
      const twilioDoc = await firestore.collection('settings').doc('twilio').get();
      if (twilioDoc.exists) twilioSettings = twilioDoc.data();
    } catch (e) {}
  }

  return {
    result: {
      whatsapp: {
        configured: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
        details: process.env.WHATSAPP_ACCESS_TOKEN ? "Token present" : "Token missing"
      },
      twilio: {
        configured: !!(twilioSettings?.accountSid || process.env.TWILIO_ACCOUNT_SID),
        details: (twilioSettings?.accountSid || process.env.TWILIO_ACCOUNT_SID) ? "Credentials present" : "Credentials missing"
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
      await firestore.collection('conversations').add({
        sessionId: `web-${Date.now()}`,
        transcript,
        startTime,
        endTime,
        language: preferredLanguage || 'English',
        type: 'web',
        summary: 'Web chat session', // Default summary for web
        outcome: 'inquiry', // Default outcome for web
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
app.all(['/api/twilio/voice', '/api/twilio/voice/'], (req, res) => {
  console.log(`[Twilio] Webhook received: ${req.method} ${req.url}`);
  console.log(`[Twilio] Headers:`, JSON.stringify(req.headers));
  
  // Twilio sends data in body for POST, in query for GET
  const data = req.method === 'POST' ? req.body : req.query;
  console.log(`[Twilio] Data:`, JSON.stringify(data));
  
  try {
    const from = data.From || 'Unknown';
    console.log(`[Twilio] Incoming call from: ${from}`);
    
    // Robust host detection
    // Priority: 
    // 1. x-forwarded-host (set by proxy)
    // 2. host header
    // 3. APP_URL (only if detected host is local/missing)
    let host = req.get('x-forwarded-host') || req.get('host');
    
    const isLocal = !host || host.includes('localhost') || host.includes('127.0.0.1') || host.includes('0.0.0.0');
    
    if (isLocal && process.env.APP_URL) {
      try {
        const appUrl = new URL(process.env.APP_URL);
        host = appUrl.host;
        console.log(`[Twilio] Using host from APP_URL (fallback): ${host}`);
      } catch (e) {
        console.warn(`[Twilio] Invalid APP_URL: ${process.env.APP_URL}`);
      }
    }

    if (!host) {
      console.error('[Twilio] Could not determine host for WebSocket stream');
      return res.status(500).send('Could not determine host');
    }

    // Determine protocol - Twilio Media Streams REQUIRE wss:// in production
    // In AI Studio/Cloud Run, we are always behind an SSL proxy.
    const protocol = (host.includes('localhost') || host.includes('0.0.0.0')) ? 'ws' : 'wss';
    
    // Ensure host doesn't have a port if it's already a standard one
    const cleanHost = host.split(':')[0];
    const streamUrl = `${protocol}://${cleanHost}/api/twilio/stream`;
    console.log(`[Twilio] Generated Stream URL: ${streamUrl}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Welcome to DrisaTech AI Support. Please wait while we connect you to our AI agent.</Say>
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

// Twilio Status Callback (to avoid 404s)
app.all(['/api/twilio/status', '/api/twilio/status/'], (req, res) => {
  console.log(`[Twilio] Status Callback: ${req.method} ${req.url}`);
  res.status(200).send('OK');
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

app.post('/api/admin/request-notification', async (req, res) => {
  const { userEmail, userName } = req.body;
  if (!userEmail) {
    return res.status(400).json({ error: "Missing user email" });
  }

  const superAdminEmail = 'drisatech@gmail.com';
  let emailSettings: any = null;

  if (firestore) {
    try {
      const emailDoc = await firestore.collection('settings').doc('email').get();
      if (emailDoc.exists) emailSettings = emailDoc.data();
    } catch (e) {
      console.error('[Firestore] Error fetching email settings for admin notification:', e);
    }
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
        from: `"Drisa AI System" <${smtpUser}>`,
        to: superAdminEmail,
        subject: "New Admin Access Request - Drisa AI",
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #8b5cf6;">New Admin Access Request</h2>
            <p>A user has requested sub-admin access to the Drisa AI Dashboard.</p>
            <div style="background: #f3f4f6; padding: 15px; rounded: 10px; margin: 20px 0;">
              <p><strong>Name:</strong> ${userName || 'N/A'}</p>
              <p><strong>Email:</strong> ${userEmail}</p>
              <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
            </div>
            <p>Please log in to the dashboard to approve or reject this request.</p>
            <a href="${process.env.APP_URL || '#'}" style="display: inline-block; background: #8b5cf6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 8px; margin-top: 10px;">Go to Dashboard</a>
          </div>
        `,
      });
      res.json({ success: true });
    } catch (err) {
      console.error('[SMTP] Admin notification failed:', err);
      res.status(500).json({ error: 'Failed to send email notification' });
    }
  } else {
    res.status(500).json({ error: 'Email credentials not configured' });
  }
});

async function startServer() {
  console.log('[Server] startServer() called');
  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Server] Initializing Vite middleware...');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('[Server] Vite middleware initialized');
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

  const httpServer = createHttpServer(app);

  // --- WebSocket Server for Twilio Streams ---
  const twilioWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const requestUrl = request.url || '';
      const host = request.headers.host || 'unknown';
      console.log(`[Upgrade] Incoming upgrade request: ${requestUrl} on host ${host}`);

      // Use a fixed base for URL parsing as we only care about the pathname
      const url = new URL(requestUrl, 'http://localhost');
      const pathname = url.pathname;
      const ip = (request.headers['x-forwarded-for'] as string || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
      
      console.log(`[Upgrade] Request for ${pathname} from ${ip}. Host: ${request.headers.host}`);
      
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
    
    ws.on('error', (err) => {
      console.error('[Twilio] WebSocket error:', err);
    });

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

    console.log(`[Twilio] Using API Key: ${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`);
    const ai = new GoogleGenAI({ apiKey });

    ws.on('close', async () => {
      console.log(`[Twilio] WebSocket connection closed for stream: ${streamSid}`);
      if (geminiSession) {
        try {
          geminiSession.close();
        } catch (e) {}
      }
    });

    ws.on('message', async (message: any) => {
      try {
        const msgString = message.toString();
        const data = JSON.parse(msgString);
        console.log(`[Twilio] Received event: ${data.event}`);
        
        if (data.event === 'start') {
          streamSid = data.streamSid;
          fromNumber = data.start?.customParameters?.from || 'Unknown';
          console.log(`[Twilio] Stream started: ${streamSid} from ${fromNumber}`);
          
          const { instruction, defaultLanguage } = await getSystemInstruction();
          
          try {
            console.log(`[Twilio] Connecting to Gemini Live API...`);
            geminiSession = await ai.live.connect({
              model: "gemini-2.5-flash-native-audio-preview-09-2025",
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
                systemInstruction: instruction,
                outputAudioTranscription: {},
                inputAudioTranscription: {},
                tools: [
                  { googleSearch: {} },
                  {
                    functionDeclarations: [
                      { name: "lookupCatalog", parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } } } },
                    { name: "sendFollowUp", parameters: { type: Type.OBJECT, properties: { contactType: { type: Type.STRING, enum: ["whatsapp", "email", "sms", "call"], description: "Type of contact: 'whatsapp', 'email', 'sms', or 'call'" }, contactAddress: { type: Type.STRING, description: "The phone number or email address" }, message: { type: Type.STRING, description: "The message to send or speak on the call" } }, required: ["contactType", "contactAddress", "message"] } },
                    { name: "makePhoneCall", parameters: { type: Type.OBJECT, properties: { phoneNumber: { type: Type.STRING, description: "The phone number to call" }, message: { type: Type.STRING, description: "The message to speak when the user answers" } }, required: ["phoneNumber", "message"] } },
                    { name: "checkServiceStatus", parameters: { type: Type.OBJECT, properties: {} } },
                    { name: "bookAppointment", parameters: { type: Type.OBJECT, properties: { summary: { type: Type.STRING }, description: { type: Type.STRING }, startTime: { type: Type.STRING }, endTime: { type: Type.STRING } }, required: ["summary", "startTime", "endTime"] } }
                  ]
                }]
              },
              callbacks: {
                onopen: () => {
                  console.log('[Twilio] Gemini session opened successfully');
                  try {
                    geminiSession.sendRealtimeInput({
                      parts: [{ text: `Hello! Please introduce yourself briefly as the DrisaTech AI Support Agent and ask how you can help. Greet the user warmly in ${defaultLanguage}.` }]
                    });
                  } catch (e) {
                    console.error('[Twilio] Error sending initial greeting:', e);
                  }
                },
                onmessage: async (msg) => {
                  try {
                    // Handle transcriptions
                    if (msg.serverContent?.modelTurn?.parts) {
                      for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.text) {
                          transcript.push({ role: 'AI', text: part.text });
                        }
                        if (part.inlineData?.data) {
                          const mulawChunks = pcmToMulaw(part.inlineData.data);
                          for (const chunk of mulawChunks) {
                            if (ws.readyState === WebSocket.OPEN) {
                              ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: chunk } }));
                            }
                          }
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
                        else if (call.name === 'makePhoneCall') result = await sendFollowUp('phone', args.phoneNumber, args.message);
                        else if (call.name === 'checkServiceStatus') result = await checkServiceStatus();
                        else if (call.name === 'bookAppointment') result = await bookAppointment(args.summary, args.description, args.startTime, args.endTime);
                        return { id: call.id, name: call.name, response: result };
                      }));
                      geminiSession.sendToolResponse({ functionResponses: responses });
                    }
                  } catch (e) {
                    console.error('[Twilio] Error processing Gemini message:', e);
                  }
                },
                onerror: (err) => {
                  console.error('[Twilio] Gemini session error:', err);
                  if (ws.readyState === WebSocket.OPEN) ws.close();
                },
                onclose: () => {
                  console.log('[Twilio] Gemini session closed');
                  if (ws.readyState === WebSocket.OPEN) ws.close();
                }
              }
            });
          } catch (err: any) {
            console.error('[Twilio] Failed to connect to Gemini:', err);
            console.error('[Twilio] Gemini Error Details:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
            if (ws.readyState === WebSocket.OPEN) ws.close();
          }
  
        } else if (data.event === 'media' && geminiSession) {
          const pcm16 = mulawToPcm16(data.media.payload);
          if (pcm16) {
            try {
              geminiSession.sendRealtimeInput({ media: { data: pcm16, mimeType: 'audio/pcm;rate=16000' } });
            } catch (e) {
              console.error('[Twilio] Error sending media to Gemini:', e);
            }
          }
        } else if (data.event === 'stop') {
          console.log(`[Twilio] Stream stopped: ${streamSid}`);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        }
      } catch (err) {
        console.error('[Twilio] Error processing message:', err);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
    });

    ws.on('close', async () => {
      console.log(`[Twilio] Connection closed: ${streamSid}`);
      if (geminiSession) {
        try {
          geminiSession.close();
        } catch (e) {}
      }

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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
} catch (err) {
    console.error('[Server] Error in startServer:', err);
    throw err;
  }
}

startServer().catch(err => {
  console.error('[Server] FATAL ERROR during startup:', err);
  process.exit(1);
});
