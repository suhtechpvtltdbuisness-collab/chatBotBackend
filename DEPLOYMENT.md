# Deployment Guide

This is a standard Node.js/Express application with Socket.IO support. It can be deployed to any platform that supports Node.js.

## ✅ What Changed

Removed all Vercel-specific configurations and converted to a standard Express server:
- Removed `vercel.json`
- Removed all `process.env.VERCEL` conditionals
- Socket.IO is now always enabled
- Server always starts normally with `server.listen()`
- MongoDB connections handled standardly

## 🚀 Recommended Deployment Options

### 1. **Railway** (Recommended - Easy & Free Tier)
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

Set environment variables in Railway dashboard:
- `MONGO_URI`
- `JWT_SECRET`
- `PORT` (optional, defaults to 3000)
- `NODE_ENV=production`

### 2. **Render**
1. Connect your GitHub repo
2. Select "Web Service"
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add environment variables in dashboard

### 3. **DigitalOcean App Platform**
1. Connect GitHub repo
2. Auto-detects Node.js
3. Add environment variables
4. Deploy

### 4. **Heroku**
```bash
heroku create your-app-name
heroku config:set MONGO_URI="your-mongo-uri"
heroku config:set JWT_SECRET="your-secret"
git push heroku main
```

### 5. **AWS EC2 / VPS**
```bash
# On server
git clone <your-repo>
cd chatBotBackend
npm install --production
npm install -g pm2

# Set environment variables in .env file
pm2 start src/index.js --name chatbot
pm2 save
pm2 startup
```

### 6. **Docker**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## 📋 Required Environment Variables

- `MONGO_URI` - MongoDB connection string
- `JWT_SECRET` - Secret for JWT tokens
- `PORT` (optional) - Server port, defaults to 3000
- `NODE_ENV` - Set to `production` for production
- `FRONTEND_URL` (optional) - Your frontend URL for CORS

## 🔍 Health Check Endpoint

Once deployed, verify your app is running:
```
GET https://your-domain.com/api/health
```

Should return:
```json
{
  "status": "healthy",
  "timestamp": "2026-02-02T...",
  "environment": "production",
  "version": "1.0.0"
}
```

## 🎯 Features

✅ Standard Express.js server  
✅ Socket.IO for real-time communication  
✅ MongoDB connection with pooling  
✅ CORS enabled for all origins  
✅ Helmet security headers  
✅ Compression middleware  
✅ Error handling middleware  
✅ Global error handlers for uncaught exceptions  

## 🛠️ Local Development

```bash
npm install
npm run dev  # Starts on port 5001
```

## 📦 Production Build

```bash
npm install --production
npm start  # Starts on PORT env variable or 3000
```
