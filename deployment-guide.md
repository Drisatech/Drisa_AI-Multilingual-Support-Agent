# 🚀 Deployment Strategy: Scaling Drisa_AI on Google Cloud

This guide outlines the professional deployment architecture for **Drisa_AI**, leveraging **Google Cloud Run** for serverless scalability, **Firebase Firestore** for real-time persistence, and **GitHub Actions** for automated CI/CD.

---

## 🏗️ 1. Cloud Architecture Overview

Drisa_AI is designed as a cloud-native application. By deploying to **Google Cloud Run**, we achieve:
- **Auto-scaling**: Scales to zero when not in use and handles thousands of concurrent calls during peak hours.
- **WebSocket Support**: Native support for high-concurrency bi-directional streams.
- **Global Reach**: Low-latency edge deployment across Google's global network.

---

## 📋 2. Prerequisites

Before beginning the deployment, ensure you have the following:
- **Google Cloud Project**: With an active billing account.
- **Google Cloud SDK (gcloud)**: Installed and authenticated (`gcloud auth login`).
- **Project Permissions**: `Owner` or `Editor` access to the target project.

---

## 🛠️ 3. Environment Configuration

Drisa_AI relies on secure environment variables. For production, these should be managed via **Google Secret Manager** or directly in the Cloud Run configuration.

| Variable | Description |
| :--- | :--- |
| `GEMINI_API_KEY` | Your Google AI Studio API Key. |
| `WHATSAPP_ACCESS_TOKEN` | Meta WhatsApp Business API Access Token. |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Phone Number ID. |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID for Google Calendar. |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret for Google Calendar. |
| `SMTP_USER` / `SMTP_PASS` | Credentials for automated email follow-ups. |

---

## 🚢 4. Deployment Strategies

### Option A: Automated CI/CD (Recommended for Hackathons)
We have included a production-ready **GitHub Actions** workflow to demonstrate professional DevOps practices.

1.  **Export to GitHub**: Push your code to a private or public GitHub repository.
2.  **Configure Repository Secrets**: Navigate to `Settings > Secrets and variables > Actions` and add:
    - `GCP_PROJECT_ID`: Your Google Cloud Project ID.
    - `GCP_SA_KEY`: A Service Account JSON key with `Cloud Run Admin` and `Storage Admin` roles.
    - `GEMINI_API_KEY`: Your production API key.
3.  **Trigger Build**: Every push to the `main` branch will automatically trigger a build via **Cloud Build** and a deployment to **Cloud Run**.

### Option B: Manual CLI Deployment
For rapid prototyping, use the `gcloud` CLI:

```bash
# 1. Build the container image using Cloud Build
gcloud builds submit --tag gcr.io/[PROJECT_ID]/drisa-ai

# 2. Deploy to Cloud Run
gcloud run deploy drisa-ai \
  --image gcr.io/[PROJECT_ID]/drisa-ai \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,GEMINI_API_KEY=[YOUR_KEY]"
```

---

## 📂 5. Database & Persistence (Firestore)

Drisa_AI uses **Firebase Firestore** in Native Mode for enterprise-grade data persistence.

1.  **Provision Firestore**: In the GCP Console, navigate to **Firestore** and create a database in **Native Mode**.
2.  **Service Account Permissions**: Ensure the Cloud Run service account has the `Cloud Datastore User` role.
3.  **Configuration**: Set the `USE_FIRESTORE=true` environment variable in your Cloud Run service settings.

---

## 📞 6. Telephony Integration (Twilio)

To enable the voice-over-phone feature:
1.  **Deploy the App**: Obtain your service URL (e.g., `https://drisa-ai-agent-xyz.a.run.app`).
2.  **Configure Twilio Webhook**:
    - Go to your **Twilio Console** > **Active Numbers**.
    - Select your number and scroll to the **Voice & Fax** section.
    - Set **A CALL COMES IN** to `Webhook` and use the URL:
      `https://[YOUR_APP_URL]/api/twilio/voice`
    - Set the method to `HTTP POST`.

---

## ⚡ 7. Performance Optimization for WebSockets

To ensure smooth, real-time audio streams:
- **Session Affinity**: Enable "Session Affinity" in the Cloud Run **Networking** settings. This ensures the WebSocket handshake stays with the same instance.
- **Request Timeout**: Increase the timeout to `3600s` to prevent premature disconnection during long customer consultations.
- **CPU Allocation**: Set "CPU is always allocated" for lower latency during active voice sessions.

---

## 🏁 Conclusion

By following this guide, you have deployed a **production-ready, serverless AI agent** capable of handling multimodal interactions at scale. This architecture demonstrates a high level of technical maturity, making it a strong contender for hackathon awards and professional implementation.
