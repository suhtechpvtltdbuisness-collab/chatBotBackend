import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

export const loadEnv = () => {
  // Resolve and load ONLY backend/.env regardless of current working directory
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, '../../.env');
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    console.warn(`⚠️ Could not load .env from ${envPath}. Falling back to process environment.`);
  }

  // Validate required environment variables
  const requiredForProd = ['MONGO_URI', 'JWT_SECRET'];
  const missing = requiredForProd.filter(key => !process.env[key]);

  if (missing.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error('❌ Missing required environment variables:', missing);
      process.exit(1);
    } else {
      console.warn('⚠️ Missing environment variables (development mode):', missing);
      // Provide safe defaults for development
      if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'dev-secret-change-me';
      if (!process.env.MONGO_URI) process.env.MONGO_URI = 'mongodb+srv://Ankit:Ankit@cluster0.m609d.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
    }
  }

  console.log('✅ Environment variables loaded');
};

// Ensure env is loaded BEFORE building the config object
if (!process.env.__ENV_LOADED) {
  loadEnv();
  process.env.__ENV_LOADED = '1';
}

export const config = {
  mongodb: {
    uri: process.env.MONGO_URI || "mongodb+srv://User:Akp%40123@cluster0.v5cjcdr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: '7d'
  },
  llm: {
    apiKey: process.env.SAMBANOVA_API_KEY || '98235f86-e8c2-4a62-b606-6925868bfa21',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.sambanova.ai/v1',
    model: 'Meta-Llama-3.1-8B-Instruct'
  },
  server: {
    port: process.env.PORT || 3000,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173'
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
  }
};
