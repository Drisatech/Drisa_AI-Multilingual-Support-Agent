# Drisa_AI Agent

A professional multilingual AI Voice Support Agent built with React, Express, and Gemini 2.5 Flash.

## Architecture

![Drisa_AI Architecture Diagram](./public/architecture.svg)

### Workflow Overview

1.  **User Interaction**: Users connect via the web interface or phone (Twilio).
2.  **Backend Orchestration**: The Express server manages WebSocket connections and proxies audio streams.
3.  **AI Intelligence**: Gemini 2.5 Flash Native Audio processes the real-time audio stream, understands intent, and generates responses.
4.  **Data Management**: All interactions are logged in SQLite/Firestore for history and follow-up tracking.
5.  **Action Tools**: The AI can trigger external tools like searching the product catalog or sending follow-up messages via WhatsApp and Email.

## Features

- **Real-time Voice**: Low-latency multilingual conversation.
- **Product Catalog**: Instant information retrieval for customers.
- **Automated Follow-ups**: Seamless integration with WhatsApp and Email.
- **Multi-user Support**: Scalable architecture for multiple simultaneous sessions.
