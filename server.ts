import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { db } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const SYSTEM_INSTRUCTION = `You are a professional multilingual AI Support Agent as a Sales and Customer Care Representative for a business.

Your responsibilities:
1. Automatically detect the customer's language and respond in the same language.
Supported languages: English, Hausa, Igbo, Yoruba, Nigerian Pidgin.
2. Be polite, professional, warm, and helpful.
3. Understand whether the customer is: Making an inquiry, Requesting support, Asking for price, Asking for recommendation, or Asking for recent products.
4. When customer describes a need: Ask clarifying questions if necessary, Suggest suitable products from the catalog, Mention benefits, pricing, and availability.
5. During the conversation: Offer to send product details via WhatsApp or Email. Ask customer to provide preferred contact and confirm it clearly.
6. After collecting contact: Summarize what will be sent, Thank the customer, End conversation professionally.
7. When suggesting products: Use persuasive but honest sales tone. Focus on solving customer's problem.
8. If the customer is unsure: Offer 2-3 options based on budget or use case.
9. Never hallucinate product data. Only use catalog data provided via function call.
10. Always keep responses short enough for natural phone conversation.

Tone: Professional, Friendly, Solution-focused, Trust-building.
Goal: Convert inquiry into qualified lead or sale.`;

app.use(express.json());

// Initialize Database
db.init();

// --- API Routes ---

// Get all products or search
app.get('/api/products', async (req, res) => {
  const query = req.query.q as string;
  const products = await db.getProducts(query);
  res.json(products);
});

// Add a product
app.post('/api/products', async (req, res) => {
  const product = await db.addProduct(req.body);
  res.json(product);
});

// Get follow-ups
app.get('/api/follow-ups', async (req, res) => {
  const followUps = await db.getFollowUps();
  res.json(followUps);
});

// Create a follow-up (Triggered by AI Agent)
app.post('/api/follow-ups', async (req, res) => {
  const followUp = await db.addFollowUp(req.body);
  res.json({ success: true, ...followUp });
});

// Twilio Voice Webhook Placeholder
app.post('/api/twilio/voice', (req, res) => {
  // This is where Twilio would send incoming calls.
  // To connect to Gemini Live API via Twilio, you would return TwiML that starts a <Connect><Stream>
  // pointing to a WebSocket endpoint on this server.
  const twiml = `
    <Response>
      <Say>Welcome to our AI Customer Care. Please wait while we connect you.</Say>
      <Connect>
        <Stream url="wss://${req.headers.host}/api/twilio/stream" />
      </Connect>
    </Response>
  `;
  res.type('text/xml');
  res.send(twiml);
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
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // --- WebSocket Server for Twilio Streams ---
  const wss = new WebSocketServer({ server, path: '/api/twilio/stream' });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[Twilio] New stream connection');
    
    let streamSid: string | null = null;
    let geminiSession: any = null;
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const connectToGemini = async () => {
      try {
        const sessionPromise = ai.live.connect({
          model: "gemini-2.5-flash-native-audio-preview-09-2025",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
            },
            systemInstruction: SYSTEM_INSTRUCTION,
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
              // Handle audio output from Gemini
              const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              if (base64Audio && streamSid && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: { payload: base64Audio }
                }));
              }

              // Handle tool calls
              if (message.toolCall) {
                const functionCalls = message.toolCall.functionCalls;
                if (functionCalls) {
                  const responses = await Promise.all(functionCalls.map(async (call) => {
                    if (call.name === 'lookupCatalog') {
                      const query = (call.args as any)?.query || '';
                      const products = await db.getProducts(query);
                      return { id: call.id, name: call.name, response: { result: products } };
                    } else if (call.name === 'sendFollowUp') {
                      const { contactType, contactAddress, message: msg } = call.args as any;
                      const followUp = await db.addFollowUp({ contactType, contactAddress, message: msg });
                      return { id: call.id, name: call.name, response: { result: "Follow-up scheduled successfully", id: followUp.id } };
                    }
                    return { id: call.id, name: call.name, response: { error: "Unknown function" } };
                  }));
                  
                  sessionPromise.then(session => {
                    session.sendToolResponse({ functionResponses: responses });
                  });
                }
              }
            },
            onerror: (err) => {
              console.error('[Gemini] Error:', err);
              ws.close();
            },
            onclose: () => {
              console.log('[Gemini] Closed');
              ws.close();
            }
          }
        });
        geminiSession = await sessionPromise;
      } catch (err) {
        console.error('[Gemini] Connection failed:', err);
        ws.close();
      }
    };

    ws.on('message', (message: string) => {
      const data = JSON.parse(message);
      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log(`[Twilio] Stream started: ${streamSid}`);
          connectToGemini();
          break;
        case 'media':
          if (geminiSession && data.media.payload) {
            geminiSession.sendRealtimeInput({
              media: {
                data: data.media.payload,
                mimeType: 'audio/x-mulaw;rate=8000' // Twilio default
              }
            });
          }
          break;
        case 'stop':
          console.log(`[Twilio] Stream stopped: ${streamSid}`);
          if (geminiSession) geminiSession.close();
          break;
      }
    });

    ws.on('close', () => {
      console.log('[Twilio] Connection closed');
      if (geminiSession) geminiSession.close();
    });
  });
}

startServer();
