# Deployment Guide: Moving Drisa_AI to Cloud Run

This guide explains how to manually deploy your application to **Google Cloud Run**.

## 1. Prerequisites
- A Google Cloud Project with billing enabled.
- [Google Cloud SDK (gcloud)](https://cloud.google.com/sdk/docs/install) installed and authenticated.
- Docker installed (if building locally).

## 2. Prepare Your Environment
Ensure your `server.ts` uses the dynamic port provided by Cloud Run:
```ts
const PORT = process.env.PORT || 8080;
```
*(I have already updated this in your codebase)*.

## 3. Build and Deploy

### Option A: Using Google Cloud Build (Recommended)
This is the easiest way as it doesn't require Docker to be installed locally.

1. Open your terminal in the project root.
2. Run the following command (replace `PROJECT_ID` with your actual Google Cloud Project ID):
   ```bash
   gcloud builds submit --tag gcr.io/PROJECT_ID/drisa-ai
   ```
3. Once the build is finished, deploy to Cloud Run:
   ```bash
   gcloud run deploy drisa-ai \
     --image gcr.io/PROJECT_ID/drisa-ai \
     --platform managed \
     --region your-region (e.g., us-central1) \
     --allow-unauthenticated \
     --set-env-vars="GEMINI_API_KEY=your_actual_key_here"
   ```

### Option B: Manual Deployment via Console
1. Go to the [Cloud Run Console](https://console.cloud.google.com/run).
2. Click **Create Service**.
3. Select **"Continuously deploy from a repository"** or upload your container image.
4. Under **Variables & Secrets**, add:
   - `GEMINI_API_KEY`: Your Gemini API Key.
   - `NODE_ENV`: `production`.
5. Under **Container**, set the port to `8080`.

## 4. Database Setup (Firestore)
I have already refactored the code to support **Firestore**. To enable it:

1. **In Google Cloud Console**:
   - Go to **Firestore** and click **Create Database**.
   - Select **Native Mode**.
   - Choose a location (same as your Cloud Run region).

2. **In Cloud Run Settings**:
   - Go to your service -> **Edit & Deploy New Revision**.
   - Under **Variables & Secrets**, add a new variable:
     - `USE_FIRESTORE`: `true`
   - Under **Security**, ensure the **Service Account** has the `Cloud Datastore User` role.

3. **Data Migration**:
   - The first time the app runs with Firestore, it will be empty. You can use the "Catalog" tab in the web app to manually add your products, or modify `db.ts` to seed Firestore similarly to how it seeds SQLite.

## 5. Important Configuration for WebSockets
Cloud Run supports WebSockets, but you must ensure:
- **Session Affinity**: For better performance with WebSockets, you can enable "Session Affinity" in the Cloud Run service settings.
- **Timeout**: Increase the "Request timeout" (e.g., to 3600 seconds) if you expect long phone calls.

## 5. Twilio Webhook Update
Once deployed, you will get a new URL (e.g., `https://drisa-ai-xyz.a.run.app`).
Update your Twilio Voice Webhook to:
`https://drisa-ai-xyz.a.run.app/api/twilio/voice`

## 7. Automated Deployment (GitHub Actions)

I have set up a GitHub Actions workflow to automate your deployment. This is excellent for CI/CD and earns bonus points in the Devpost hackathon.

### Workflow File
The automation is defined in: `/.github/workflows/deploy.yml`

### How to use it:
1. **Push to GitHub**: Export your code to a GitHub repository.
2. **Configure Secrets**: In your GitHub repo, go to `Settings > Secrets and variables > Actions` and add:
   - `GCP_PROJECT_ID`: Your Google Cloud Project ID.
   - `GCP_SA_KEY`: Your Service Account JSON key.
   - `GEMINI_API_KEY`: Your Gemini API Key.
3. **Automatic Deploy**: Every push to the `main` branch will now automatically build and deploy your app to Cloud Run.
