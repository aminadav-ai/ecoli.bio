# Stage 1: Build the frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production environment
FROM python:3.12-slim
WORKDIR /app

# Install system dependencies (compiler, GLPK development headers for swiglpk, and Node.js for Vite preview)
RUN apt-get update && apt-get install -y \
    curl \
    gcc \
    g++ \
    make \
    libglpk-dev \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy python requirements and install them
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy package.json to install node dependencies (needed for Vite preview)
COPY package*.json ./
RUN npm ci

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/dist ./dist

# Copy the rest of the application files
COPY . .

# Expose port (default to 8080)
EXPOSE 8080

# Start command
CMD ["npm", "run", "start"]
