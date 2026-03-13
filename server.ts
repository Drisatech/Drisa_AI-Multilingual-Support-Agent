import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
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
3. Use 'lookupCatalog' for product inquiries and 'sendFollowUp' to capture contact details.
4. Always confirm contact information clearly before sending a follow-up.

Goal: Provide expert advice on DrisaTech products with a rhythmic Nigerian flair in the user's language of choice.`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Audio Conversion Helpers ---
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
  const { type, content } = req.body;
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  
  if (!apiKey) {
    console.error('[Gemini] API Key is missing');
    return res.status(500).json({ error: 'Gemini API Key is missing' });
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    let textToProcess = content;

    if (type === 'url') {
      // In a real app, we'd fetch the URL content here. 
      // For this demo, we'll use Gemini's urlContext if possible, 
      // but since this is a backend route, we'll just simulate or use a simple fetch if allowed.
      // Since we can't easily fetch external URLs from this sandbox without a library, 
      // we'll ask Gemini to "imagine" the content if it's a known site, or just use the URL as a prompt.
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Extract product information (name, description, price in Naira, category) from this source: ${content}. If it's a URL, use your knowledge of the site or common product patterns. Return a JSON array of products.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                price: { type: Type.NUMBER },
                category: { type: Type.STRING }
              },
              required: ["name", "price"]
            }
          }
        }
      });
      
      const products = JSON.parse(response.text);
      const batch = firestore.batch();
      products.forEach((p: any) => {
        const docRef = firestore.collection('products').doc();
        batch.set(docRef, { ...p, updatedAt: new Date().toISOString() });
      });
      await batch.commit();
    } else {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Extract product information (name, description, price in Naira, category) from this article: ${content}. Return a JSON array of products.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                price: { type: Type.NUMBER },
                category: { type: Type.STRING }
              },
              required: ["name", "price"]
            }
          }
        }
      });
      
      const products = JSON.parse(response.text);
      const batch = firestore.batch();
      products.forEach((p: any) => {
        const docRef = firestore.collection('products').doc();
        batch.set(docRef, { ...p, updatedAt: new Date().toISOString() });
      });
      await batch.commit();
    }

    // Update source status
    const sources = await firestore.collection('knowledge_sources')
      .where('content', '==', content)
      .limit(1)
      .get();
    
    if (!sources.empty) {
      await sources.docs[0].ref.update({ status: 'processed' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process knowledge source' });
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
      console.log(`[Upgrade] Request for ${pathname}`);
      
      if (pathname.startsWith('/api/twilio/stream')) {
        console.log('[Upgrade] Handling Twilio stream upgrade');
        twilioWss.handleUpgrade(request, socket, head, (ws) => {
          twilioWss.emit('connection', ws, request);
        });
      } else if (pathname.startsWith('/api/browser/stream')) {
        console.log('[Upgrade] Handling Browser stream upgrade');
        browserWss.handleUpgrade(request, socket, head, (ws) => {
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
    console.log('[Twilio] New stream connection');
    setupGeminiProxy(
      ws, 
      'audio/pcm;rate=16000', 
      (data) => mulawToPcm16(data.media.payload), 
      (payload, streamSid) => JSON.stringify({ event: 'media', streamSid, media: { payload: pcmToMulaw(payload) } })
    );
  });

  // Browser Stream Handler (PCM 16000Hz)
  browserWss.on('connection', (ws: WebSocket) => {
    console.log('[Browser] New stream connection');
    setupGeminiProxy(ws, 'audio/pcm;rate=16000', (data) => data.audio, (payload) => JSON.stringify({ event: 'audio', audio: payload }));
  });

  async function setupGeminiProxy(ws: WebSocket, mimeType: string, getPayload: (data: any) => string, createMessage: (payload: string, streamSid?: string) => string) {
    let streamSid: string | null = null;
    let geminiSession: any = null;
    let isConnectingGemini = false;
    let preferredLanguage: string = 'English';
    let transcript: { role: string, text: string, timestamp: string }[] = [];
    let startTime = new Date().toISOString();
    let audioOutputBuffer = Buffer.alloc(0);
    
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

    const connectToGemini = async () => {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        console.error('[Gemini] API Key is missing, cannot connect. Please check your environment variables.');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'error', message: 'Gemini API Key is missing' }));
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
                        products = snapshot.docs.map(doc => doc.data());
                      } catch (e) {
                        console.error('[Firestore] Failed to fetch products:', e);
                      }
                    }
                    
                    if (query) {
                      products = products.filter(p => 
                        p.name.toLowerCase().includes(query.toLowerCase()) || 
                        p.description.toLowerCase().includes(query.toLowerCase())
                      );
                    }
                    
                    return { id: call.id, name: call.name, response: { result: products } };
                  } else if (call.name === 'sendFollowUp') {
                    const args = call.args as any;
                    const contactType = args.contactType || args.contact_type;
                    const contactAddress = args.contactAddress || args.contact_address;
                    const msg = args.message || args.msg;
                    
                    console.log(`[Follow-up] Sending ${contactType} to ${contactAddress}`);
                    console.log(`[Follow-up] Message: ${msg}`);
                    
                    if (!contactType || !contactAddress || !msg) {
                      return { id: call.id, name: call.name, response: { error: "Missing required arguments: contactType, contactAddress, or message" } };
                    }

                    if (firestore) {
                      try {
                        await firestore.collection('leads').add({
                          contactType,
                          phone: contactType === 'whatsapp' ? contactAddress : '',
                          email: contactType === 'email' ? contactAddress : '',
                          notes: msg,
                          createdAt: new Date().toISOString(),
                          status: 'new'
                        });
                        console.log(`[Firestore] Lead saved: ${contactAddress}`);
                      } catch (e) {
                        console.error('[Firestore] Failed to save lead:', e);
                      }
                    }
                    
                    return { id: call.id, name: call.name, response: { result: "Follow-up sent successfully via " + contactType } };
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
          const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
          if (!apiKey) throw new Error('Gemini API Key is missing');
          
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
            sessionId: streamSid || 'browser-user-' + Date.now(),
            startTime,
            endTime: new Date().toISOString(),
            language: preferredLanguage,
            transcript,
            summary,
            outcome,
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
