import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";

import { connectDB } from "./config/db.js";
import { loadEnv } from "./config/env.js";
import { errorHandler } from "./utils/error.js";

import apiKeyRoutes from "./routes/apiKeyRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import kbRoutes from "./routes/kbRoutes.js";
import tenantRoutes from "./routes/tenantRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import handoffService from "./services/handoff.js";

loadEnv();

const app = express();
const server = createServer(app);

// ===============================
// CORS CONFIGURATION
// ===============================

const allowedOrigins = [
  "https://suhtech.shop",
  "https://www.suhtech.shop",
  "https://chat-bot-frontend-theta-jade.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5000",
  "http://localhost:5001",
  "http://localhost:5173",
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
].filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (origin.endsWith(".vercel.app")) return true;
  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    console.warn("Blocked CORS origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-Key",
    "X-Requested-With",
    "Accept",
    "Origin",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ===============================
// SECURITY + PERFORMANCE
// ===============================

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://*.razorpay.com"],
        frameSrc: ["'self'", "https://api.razorpay.com", "https://*.razorpay.com"],
        connectSrc: ["'self'", "https://api.razorpay.com", "https://*.razorpay.com"],
        imgSrc: ["'self'", "data:", "https://*.razorpay.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
      },
    },
  })
);
app.use(compression());

// ===============================
// BODY PARSER
// ===============================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ===============================
// SOCKET.IO CONFIG
// ===============================

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS blocked"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ===============================
// DATABASE CONNECTION
// ===============================

if (!process.env.VERCEL) {
  connectDB();
}

// Serverless DB connect
if (process.env.VERCEL) {
  app.use(async (req, res, next) => {
    try {
      await connectDB();
      next();
    } catch (error) {
      console.error("DB connection error:", error.message);
      next();
    }
  });
}

// ===============================
// ROOT ROUTES
// ===============================

app.get("/", (req, res) =>
  res.json({ message: "Welcome to SuhTech AI ChatBot Backend!" }),
);

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "production",
    version: "1.0.0",
  });
});

// ===============================
// API ROUTES
// ===============================

app.use("/auth", authRoutes);
app.use("/tenant", tenantRoutes);
app.use("/keys", apiKeyRoutes);
app.use("/kb", kbRoutes);
app.use("/chat", chatRoutes);
app.use("/webhook", webhookRoutes);
app.use("/payment", paymentRoutes);
app.use("/api", paymentRoutes);

// ===============================
// SOCKET EVENTS
// ===============================

if (!process.env.VERCEL) {
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join-tenant", (tenantId) => {
      socket.join(`tenant-${tenantId}`);
    });

    socket.on("agent-online", (data) => {
      socket.join(`agent-${data.agentId}`);

      socket.to(`tenant-${data.tenantId}`).emit("agent-status", {
        agentId: data.agentId,
        status: "online",
      });

      try {
        handoffService.setAgentOnline(data.tenantId, data.agentId);
        setImmediate(() => handoffService.processQueue());
      } catch (e) {
        console.error("Failed to mark agent online:", e.message);
      }
    });

    socket.on("agent-offline", (data) => {
      socket.leave(`agent-${data.agentId}`);

      socket.to(`tenant-${data.tenantId}`).emit("agent-status", {
        agentId: data.agentId,
        status: "offline",
      });

      try {
        handoffService.setAgentOffline(data.tenantId, data.agentId);
      } catch (e) {
        console.error("Failed to mark agent offline:", e.message);
      }
    });

    socket.on("join-conversation", (conversationId) => {
      socket.join(`conversation-${conversationId}`);
    });

    socket.on("leave-conversation", (conversationId) => {
      socket.leave(`conversation-${conversationId}`);
    });

    socket.on("chat-message", (data) => {
      socket
        .to(`conversation-${data.conversationId}`)
        .emit("new-message", data);
    });

    socket.on("handoff-notification", (data) => {
      socket.to(`tenant-${data.tenantId}`).emit("new-handoff", data);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  app.set("io", io);
  handoffService.setSocketIO(io);
}

// ===============================
// GLOBAL ERROR HANDLERS
// ===============================

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

// ===============================
// ERROR HANDLER
// ===============================

app.use(errorHandler);

// ===============================
// 404 ROUTE
// ===============================

app.use("*", (req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

// ===============================
// SERVER START
// ===============================

const PORT = process.env.PORT || 3000;

if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || "not set"}`);
  });
}

export default app;
