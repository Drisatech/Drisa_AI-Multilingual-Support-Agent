# Use Node.js 22 as the base image
FROM node:22-slim

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the frontend assets
RUN npm run build

# Set the environment variable to production
ENV NODE_ENV=production

# Expose the port Cloud Run will use (Google Cloud defaults to 8080)
EXPOSE 8080

# Start the application using tsx to run the server.ts file directly
# (This handles the TypeScript stripping automatically)
CMD ["npx", "tsx", "server.ts"]
