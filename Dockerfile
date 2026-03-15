# Use Node.js 22 as the base image
FROM node:22

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

# Expose the port the application will use
EXPOSE 3000

# Start the application using the start script defined in package.json
CMD ["npm", "start"]
